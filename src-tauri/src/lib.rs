//! 选片（PhotoPicker）后端入口：应用状态、IPC 命令、图片协议。

mod decode;
mod export;
mod formats;
mod images;
#[cfg(target_os = "macos")]
mod macos;
mod meta;
mod natural;
mod picasa_ini;
mod pool;
mod scan;
mod stars;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::http::{header, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, UriSchemeContext, UriSchemeResponder};

use export::{ExportProgress, ExportRequest, ExportResult};
use images::{ImageService, Served};
use meta::PhotoInfo;
use pool::Priority;
use scan::{Folder, Photo};
use stars::{StarLocation, StarStore};

// ---------------------------------------------------------------------------
// 应用状态
// ---------------------------------------------------------------------------

const MAX_RECENT: usize = 12;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Settings {
    /// 当前工作目录：侧栏列出它下面的所有相册（含照片的子文件夹）
    #[serde(default)]
    workdir: Option<String>,
    /// 最近用过的工作目录，最新的在前，用于快速切换
    #[serde(default)]
    recent: Vec<String>,
    /// v0.1 的“多个根目录”设置；读入时迁移成 workdir + recent，不再写出
    #[serde(default, skip_serializing)]
    roots: Vec<String>,
}

impl Settings {
    fn parse(bytes: Option<&[u8]>) -> Self {
        let mut s: Settings = bytes.and_then(|b| serde_json::from_slice(b).ok()).unwrap_or_default();
        let legacy = std::mem::take(&mut s.roots);
        if s.workdir.is_none() && !legacy.is_empty() {
            for r in legacy.iter().rev() {
                s.use_workdir(r.clone());
            }
        }
        // 当前工作目录必须在“最近”列表里（手改过的或旧版写的设置可能没有）
        if let Some(w) = s.workdir.clone() {
            if s.recent.first() != Some(&w) {
                s.use_workdir(w);
            }
        }
        s
    }

    /// 允许访问的目录（图片协议、命令都只放行工作目录里的文件）
    fn roots(&self) -> Vec<String> {
        self.workdir.iter().cloned().collect()
    }

    fn use_workdir(&mut self, dir: String) {
        self.recent.retain(|r| r != &dir);
        self.recent.insert(0, dir.clone());
        self.recent.truncate(MAX_RECENT);
        self.workdir = Some(dir);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Library {
    workdir: Option<String>,
    recent: Vec<String>,
    /// 最近列表里当前不存在的目录（移动硬盘没插、改名、删掉了），菜单里置灰
    missing: Vec<String>,
    folders: Vec<Folder>,
}

pub struct AppState {
    settings_path: PathBuf,
    /// 上次扫描结果。启动时先用它秒开侧栏，再在后台重新扫描（大图库扫一遍可能要好几秒）
    library_cache_path: PathBuf,
    scanning: AtomicBool,
    /// 工作目录“代数”：每次切换 +1。扫描开始时记下，结束时代数变了就说明用户已经换了目录，结果作废
    workdir_gen: AtomicU64,
    /// 扫描进行期间被打过星的文件夹：扫描结果里这些文件夹的星标数可能已过时，写回前要重算
    star_touched: Mutex<HashSet<String>>,
    settings: Mutex<Settings>,
    folders: RwLock<Vec<Folder>>,
    scanned: AtomicBool,
    stars: StarStore,
    images: ImageService,
    exporting: AtomicBool,
    export_cancel: AtomicBool,
}

impl AppState {
    fn new(config_dir: PathBuf, cache_dir: PathBuf, data_dir: PathBuf) -> Self {
        let settings_path = config_dir.join("settings.json");
        let settings = Settings::parse(fs::read(&settings_path).ok().as_deref());
        let images = ImageService::new(cache_dir.join("thumbs"));
        images.set_roots(&settings.roots());
        let library_cache_path = config_dir.join("library-cache.json");
        let cached: Vec<Folder> = fs::read(&library_cache_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Folder>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|f| settings.workdir.as_ref() == Some(&f.root))
            .collect();
        AppState {
            settings_path,
            library_cache_path,
            scanning: AtomicBool::new(false),
            workdir_gen: AtomicU64::new(0),
            star_touched: Mutex::new(HashSet::new()),
            settings: Mutex::new(settings),
            folders: RwLock::new(cached),
            scanned: AtomicBool::new(false),
            stars: StarStore::new(data_dir.join("stars")),
            images,
            exporting: AtomicBool::new(false),
            export_cancel: AtomicBool::new(false),
        }
    }

    fn save_settings(&self, s: &Settings) -> Result<(), String> {
        if let Some(dir) = self.settings_path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
        fs::write(&self.settings_path, json).map_err(|e| e.to_string())
    }

    fn library(&self) -> Library {
        let s = self.settings.lock();
        let missing = s.recent.iter().filter(|r| !Path::new(r).is_dir()).cloned().collect();
        Library { workdir: s.workdir.clone(), recent: s.recent.clone(), missing, folders: self.folders.read().clone() }
    }

    /// 扫描结束时把结果写回：只有在扫描期间工作目录没被切换过才写（在设置锁里判断并写入，原子完成）。
    /// 扫描期间被打过星的文件夹，星标数重新算一遍，免得旧结果把新星标数盖掉。
    fn commit_scan(&self, gen: u64, workdir: Option<String>, mut folders: Vec<Folder>, settings: Option<Settings>) -> Option<Library> {
        let mut s = self.settings.lock();
        if self.workdir_gen.load(Ordering::SeqCst) != gen {
            return None;
        }
        if let Some(new) = settings {
            // 设置也在这里（判断过没被抢先之后）才落盘，免得一个作废的切换把旧目录写进设置文件
            if let Err(e) = self.save_settings(&new) {
                eprintln!("[settings] 保存失败：{e}");
            }
            *s = new;
        }
        if s.workdir != workdir {
            return None;
        }
        let touched = std::mem::take(&mut *self.star_touched.lock());
        for f in folders.iter_mut().filter(|f| touched.contains(&f.path)) {
            (f.count, f.starred) = scan::folder_counts(Path::new(&f.path), &self.stars);
        }
        self.images.set_roots(&s.roots());
        *self.folders.write() = folders;
        drop(s);
        self.scanned.store(true, Ordering::SeqCst);
        self.persist_folders();
        Some(self.library())
    }

    /// 重新扫描当前工作目录。扫描可能要几秒，期间用户可能已经切换了工作目录——那这次结果就作废。
    fn rescan_all(&self) -> Option<Library> {
        let gen = self.workdir_gen.load(Ordering::SeqCst);
        let workdir = self.settings.lock().workdir.clone();
        self.star_touched.lock().clear();
        let folders = workdir.as_deref().map(|w| scan::scan_root(Path::new(w), &self.stars)).unwrap_or_default();
        self.commit_scan(gen, workdir, folders, None)
    }

    fn persist_folders(&self) {
        if let Ok(json) = serde_json::to_vec(&*self.folders.read()) {
            let _ = fs::write(&self.library_cache_path, json);
        }
    }
}

type AppStateRef<'a> = State<'a, Arc<AppState>>;

/// 把阻塞的磁盘活扔到后台线程池，别卡住 IPC 线程。
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// IPC 命令
// ---------------------------------------------------------------------------

/// 取图库。首次调用时：有上次的扫描缓存就立即返回缓存，同时在后台重新扫描，
/// 扫完通过 `library-updated` 事件推给前端；没有缓存才同步扫描。
#[tauri::command]
async fn get_library(app: AppHandle, state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    if st.scanned.load(Ordering::SeqCst) {
        return Ok(st.library());
    }
    let has_cache = !st.folders.read().is_empty();
    if !has_cache {
        return blocking(move || Ok(st.rescan_all().unwrap_or_else(|| st.library()))).await;
    }
    if !st.scanning.swap(true, Ordering::SeqCst) {
        let st2 = st.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let lib = st2.rescan_all();
            st2.scanning.store(false, Ordering::SeqCst);
            if let Some(lib) = lib {
                let _ = app.emit("library-updated", lib);
            }
        });
    }
    Ok(st.library())
}

#[tauri::command]
async fn rescan(state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || Ok(st.rescan_all().unwrap_or_else(|| st.library()))).await
}

/// 选择（或切换到）一个工作目录，并扫描它下面的所有相册。
///
/// 先扫描、后切换：扫描可能要好几秒（移动硬盘、NAS），这期间旧工作目录照常可用；
/// 扫完再一次性切换设置、访问权限和相册列表。期间用户又选了别的目录，这次的结果就作废。
#[tauri::command]
async fn set_workdir(path: String, state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || {
        let mut p = PathBuf::from(&path);
        // 拖进来的是照片文件：用它所在的文件夹
        if p.is_file() {
            p = p.parent().map(Path::to_path_buf).ok_or("无效路径")?;
        }
        if !p.is_dir() {
            return Err(format!("文件夹不存在：{}", p.display()));
        }
        let dir = p.to_string_lossy().trim_end_matches(['/', '\\']).to_string();
        if dir.is_empty() {
            return Err("请选择具体的照片文件夹，而不是整个磁盘".into());
        }
        let gen = st.workdir_gen.fetch_add(1, Ordering::SeqCst) + 1;
        st.star_touched.lock().clear();
        let folders = scan::scan_root(Path::new(&dir), &st.stars);
        let mut s = st.settings.lock().clone();
        s.use_workdir(dir.clone());
        st.commit_scan(gen, Some(dir), folders, Some(s)).ok_or_else(|| SUPERSEDED.to_string())
    })
    .await
}

/// 扫描期间用户又切换了工作目录：这次结果作废。前端认得这个字符串，静默忽略。
const SUPERSEDED: &str = "superseded";

/// 从“最近的工作目录”里移除一项（不删除任何文件）。
#[tauri::command]
async fn forget_workdir(path: String, state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || {
        let mut s = st.settings.lock().clone();
        if s.workdir.as_deref() == Some(path.as_str()) {
            return Err("不能移除当前的工作目录".into());
        }
        s.recent.retain(|r| r != &path);
        st.save_settings(&s)?;
        *st.settings.lock() = s;
        Ok(st.library())
    })
    .await
}

#[tauri::command]
async fn list_folder(path: String, state: AppStateRef<'_>) -> Result<Vec<Photo>, String> {
    let st = state.inner().clone();
    blocking(move || {
        if !st.images.allowed_dir(Path::new(&path)) {
            return Err("不在图库中".into());
        }
        scan::list_folder(Path::new(&path), &st.stars).map_err(|e| e.to_string())
    })
    .await
}

/// “已加星标”虚拟相册：所有文件夹里的星标照片。
#[tauri::command]
async fn list_starred(state: AppStateRef<'_>) -> Result<Vec<Photo>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let dirs: Vec<String> = st.folders.read().iter().filter(|f| f.starred > 0).map(|f| f.path.clone()).collect();
        let mut out = Vec::new();
        for d in dirs {
            if let Ok(list) = scan::list_folder(Path::new(&d), &st.stars) {
                out.extend(list.into_iter().filter(|p| p.starred));
            }
        }
        Ok(out)
    })
    .await
}

#[derive(Serialize)]
struct SetStarResult {
    /// 有文件夹不可写、星标存到了 App 数据目录
    fallback: bool,
    /// 受影响文件夹的最新星标数
    folders: BTreeMap<String, usize>,
}

#[tauri::command]
async fn set_star(paths: Vec<String>, starred: bool, state: AppStateRef<'_>) -> Result<SetStarResult, String> {
    let st = state.inner().clone();
    blocking(move || {
        let mut by_dir: BTreeMap<PathBuf, Vec<String>> = BTreeMap::new();
        for p in &paths {
            let p = Path::new(p);
            if !st.images.allowed(p) {
                return Err(format!("不在图库中：{}", p.display()));
            }
            if let (Some(dir), Some(name)) = (p.parent(), p.file_name()) {
                by_dir.entry(dir.to_path_buf()).or_default().push(name.to_string_lossy().into_owned());
            }
        }
        let mut res = SetStarResult { fallback: false, folders: BTreeMap::new() };
        for (dir, primaries) in by_dir {
            // RAW+JPG：同名的 RAW 一起打星/取消（每个文件夹只读一次目录）。
            // xmp 不是图片，加星时不写它；取消时连它一起清（兼容早先写过的记录）
            let map = scan::companion_map(&dir);
            let mut names = primaries.clone();
            for n in &primaries {
                for c in map.get(n).into_iter().flatten() {
                    if !starred || !c.to_ascii_lowercase().ends_with(".xmp") {
                        names.push(c.clone());
                    }
                }
            }
            st.star_touched.lock().insert(dir.to_string_lossy().into_owned());
            if st.stars.set(&dir, &names, starred)? == StarLocation::Fallback {
                res.fallback = true;
            }
            let (count, starred_count) = scan::folder_counts(&dir, &st.stars);
            let key = dir.to_string_lossy().into_owned();
            if let Some(f) = st.folders.write().iter_mut().find(|f| f.path == key) {
                f.count = count;
                f.starred = starred_count;
            }
            res.folders.insert(key, starred_count);
        }
        st.persist_folders();
        Ok(res)
    })
    .await
}

#[tauri::command]
async fn photo_info(path: String, state: AppStateRef<'_>) -> Result<PhotoInfo, String> {
    let st = state.inner().clone();
    blocking(move || {
        let p = PathBuf::from(&path);
        if !st.images.allowed(&p) {
            return Err("不在图库中".into());
        }
        #[allow(unused_mut)]
        let mut info = meta::photo_info(&p)?;
        #[cfg(target_os = "macos")]
        if let Some((w, h)) = macos::image_size(&p) {
            info.width = w;
            info.height = h;
        }
        Ok(info)
    })
    .await
}

#[tauri::command]
async fn prefetch_thumbs(paths: Vec<String>, state: AppStateRef<'_>) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || {
        st.images.prefetch(paths.into_iter().map(PathBuf::from).collect());
        Ok(())
    })
    .await
}

#[tauri::command]
async fn export_photos(request: ExportRequest, app: AppHandle, state: AppStateRef<'_>) -> Result<ExportResult, String> {
    let st = state.inner().clone();
    if st.exporting.swap(true, Ordering::SeqCst) {
        return Err("已有导出任务在进行".into());
    }
    st.export_cancel.store(false, Ordering::SeqCst);
    if let Some(bad) = request.paths.iter().find(|p| !st.images.allowed(Path::new(p))) {
        st.exporting.store(false, Ordering::SeqCst);
        return Err(format!("不在图库中：{bad}"));
    }
    let st2 = st.clone();
    let result = blocking(move || {
        let last = Mutex::new(Instant::now() - Duration::from_secs(1));
        let progress = move |p: ExportProgress| {
            let mut l = last.lock();
            if p.done == p.total || l.elapsed() >= Duration::from_millis(100) {
                *l = Instant::now();
                let _ = app.emit("export-progress", p);
            }
        };
        export::run_export(&request, &st2.export_cancel, &progress)
    })
    .await;
    st.exporting.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
fn cancel_export(state: AppStateRef<'_>) {
    state.export_cancel.store(true, Ordering::SeqCst);
}

#[derive(Serialize)]
struct CacheInfo {
    bytes: u64,
    files: usize,
    path: String,
}

#[tauri::command]
async fn cache_info(state: AppStateRef<'_>) -> Result<CacheInfo, String> {
    let st = state.inner().clone();
    blocking(move || {
        let (bytes, files) = st.images.cache_usage();
        Ok(CacheInfo { bytes, files, path: st.images.thumb_dir().to_string_lossy().into_owned() })
    })
    .await
}

#[tauri::command]
async fn clear_cache(state: AppStateRef<'_>) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || st.images.clear_cache().map_err(|e| e.to_string())).await
}

// ---------------------------------------------------------------------------
// 图片协议：thumb:// 与 photo://
// ---------------------------------------------------------------------------

/// URL 形如 `thumb://localhost/%2FUsers%2Fme%2Fa.jpg?v=123`（Windows 上是 http://thumb.localhost/…）。
fn parse_request(req: &Request<Vec<u8>>) -> (PathBuf, BTreeMap<String, String>) {
    let raw = req.uri().path().trim_start_matches('/');
    let path = percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned();
    let query = req
        .uri()
        .query()
        .unwrap_or("")
        .split('&')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    (PathBuf::from(path), query)
}

fn respond(responder: UriSchemeResponder, served: Served) {
    let resp = match served {
        Ok((bytes, mime)) => Response::builder()
            .status(200)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(Arc::try_unwrap(bytes).unwrap_or_else(|b| (*b).clone())),
        Err(e) => Response::builder()
            .status(404)
            .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(e.into_bytes()),
    };
    responder.respond(resp.expect("valid response"));
}

fn handle_image_protocol<R: tauri::Runtime>(
    ctx: UriSchemeContext<'_, R>,
    req: Request<Vec<u8>>,
    responder: UriSchemeResponder,
    is_thumb: bool,
) {
    let st = ctx.app_handle().state::<Arc<AppState>>().inner().clone();
    // 协议回调在主线程上被调用，读盘/解码一律丢到后台
    tauri::async_runtime::spawn_blocking(move || {
        let (path, q) = parse_request(&req);
        if !st.images.allowed(&path) {
            return respond(responder, Err("forbidden".into()));
        }
        let prio = match q.get("p").map(String::as_str) {
            Some("0") => Priority::Urgent,
            _ => Priority::High,
        };
        let cb = Box::new(move |s: Served| respond(responder, s));
        if is_thumb {
            st.images.thumb(path, prio, cb);
        } else {
            let max = q.get("max").and_then(|v| v.parse().ok()).unwrap_or(0);
            let force = q.get("force").is_some_and(|v| v == "1");
            st.images.photo(path, max, force, prio, cb);
        }
    });
}

#[derive(Clone, Serialize)]
struct ThumbProgress {
    done: usize,
    total: usize,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = app.path();
            let state = Arc::new(AppState::new(paths.app_config_dir()?, paths.app_cache_dir()?, paths.app_data_dir()?));
            let handle = app.handle().clone();
            state.images.pool.set_progress(Box::new(move |done, total| {
                let _ = handle.emit("thumb-progress", ThumbProgress { done, total });
            }));
            app.manage(state);
            Ok(())
        })
        .register_asynchronous_uri_scheme_protocol("thumb", |ctx, req, responder| {
            handle_image_protocol(ctx, req, responder, true)
        })
        .register_asynchronous_uri_scheme_protocol("photo", |ctx, req, responder| {
            handle_image_protocol(ctx, req, responder, false)
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            rescan,
            set_workdir,
            forget_workdir,
            list_folder,
            list_starred,
            set_star,
            photo_info,
            prefetch_thumbs,
            export_photos,
            cancel_export,
            cache_info,
            clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect("启动失败");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_v01_roots_to_workdir_and_recent() {
        let s = Settings::parse(Some(br#"{"roots": ["/a", "/b"]}"#));
        assert_eq!(s.workdir.as_deref(), Some("/a"));
        assert_eq!(s.recent, vec!["/a", "/b"]);
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("roots"), "旧字段不再写出：{json}");
        assert_eq!(Settings::parse(Some(json.as_bytes())), s);
    }

    #[test]
    fn recent_list_is_mru_without_duplicates() {
        let mut s = Settings::parse(None);
        assert!(s.workdir.is_none() && s.roots().is_empty());
        for d in ["/a", "/b", "/a", "/c"] {
            s.use_workdir(d.into());
        }
        assert_eq!(s.workdir.as_deref(), Some("/c"));
        assert_eq!(s.recent, vec!["/c", "/a", "/b"]);
        for i in 0..20 {
            s.use_workdir(format!("/x{i}"));
        }
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.roots(), vec!["/x19".to_string()]);
    }

    #[test]
    fn current_workdir_is_always_first_in_recent() {
        let s = Settings::parse(Some(br#"{"workdir": "/w", "recent": ["/a", "/w"]}"#));
        assert_eq!(s.recent, vec!["/w", "/a"]);
        let s = Settings::parse(Some(br#"{"workdir": "/w"}"#));
        assert_eq!(s.recent, vec!["/w"]);
    }

    fn state() -> (tempfile::TempDir, Arc<AppState>) {
        let t = tempfile::tempdir().unwrap();
        let st = Arc::new(AppState::new(t.path().join("cfg"), t.path().join("cache"), t.path().join("data")));
        (t, st)
    }

    fn photo_dir(root: &Path, rel: &str, files: &[&str]) {
        let d = root.join(rel);
        fs::create_dir_all(&d).unwrap();
        for f in files {
            fs::write(d.join(f), b"x").unwrap();
        }
    }

    #[test]
    fn superseded_switch_is_discarded_and_not_persisted() {
        let (t, st) = state();
        let a = t.path().join("A");
        let b = t.path().join("B");
        photo_dir(&a, "x", &["1.jpg"]);
        photo_dir(&b, "y", &["2.jpg"]);
        // 模拟：切到 A 的扫描还没结束，用户又切到了 B（代数 +1）
        let gen_a = st.workdir_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let folders_a = scan::scan_root(&a, &st.stars);
        let gen_b = st.workdir_gen.fetch_add(1, Ordering::SeqCst) + 1;
        let mut sb = Settings::default();
        sb.use_workdir(b.to_string_lossy().into_owned());
        let lib = st.commit_scan(gen_b, sb.workdir.clone(), scan::scan_root(&b, &st.stars), Some(sb)).unwrap();
        assert_eq!(lib.folders[0].name, "y");
        // A 的结果后到：作废，不覆盖 B，也不写进设置文件
        let mut sa = Settings::default();
        sa.use_workdir(a.to_string_lossy().into_owned());
        assert!(st.commit_scan(gen_a, sa.workdir.clone(), folders_a, Some(sa)).is_none());
        assert_eq!(st.library().workdir.as_deref(), Some(b.to_string_lossy().as_ref()));
        let saved = Settings::parse(fs::read(&st.settings_path).ok().as_deref());
        assert_eq!(saved.workdir.as_deref(), Some(b.to_string_lossy().as_ref()));
        // 访问权限也只放行 B
        assert!(st.images.allowed(&b.join("y/2.jpg")) && !st.images.allowed(&a.join("x/1.jpg")));
    }

    #[test]
    fn star_counts_changed_during_scan_survive_the_commit() {
        let (t, st) = state();
        let w = t.path().join("W");
        photo_dir(&w, "album", &["1.jpg", "2.jpg"]);
        let mut s = Settings::default();
        s.use_workdir(w.to_string_lossy().into_owned());
        let gen = st.workdir_gen.load(Ordering::SeqCst);
        st.commit_scan(gen, s.workdir.clone(), scan::scan_root(&w, &st.stars), Some(s.clone())).unwrap();
        // 后台重扫开始（读到 0 星）……
        let stale = scan::scan_root(&w, &st.stars);
        // ……扫描期间用户打了星
        let album = w.join("album");
        st.stars.set(&album, &["1.jpg".into()], true).unwrap();
        st.star_touched.lock().insert(album.to_string_lossy().into_owned());
        let lib = st.commit_scan(gen, s.workdir.clone(), stale, None).unwrap();
        assert_eq!(lib.folders[0].starred, 1, "扫描结果里过时的 0 星不能盖掉新打的星");
    }

    #[test]
    fn missing_recent_dirs_are_reported() {
        let (t, st) = state();
        let gone = t.path().join("unplugged").to_string_lossy().into_owned();
        let here = t.path().to_string_lossy().into_owned();
        {
            let mut s = st.settings.lock();
            s.use_workdir(gone.clone());
            s.use_workdir(here);
        }
        assert_eq!(st.library().missing, vec![gone]);
    }

    #[test]
    fn garbage_settings_fall_back_to_default() {
        assert_eq!(Settings::parse(Some(b"{not json")), Settings::default());
    }
}
