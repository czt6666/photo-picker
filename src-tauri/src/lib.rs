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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Settings {
    #[serde(default)]
    roots: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Library {
    roots: Vec<String>,
    folders: Vec<Folder>,
}

pub struct AppState {
    settings_path: PathBuf,
    /// 上次扫描结果。启动时先用它秒开侧栏，再在后台重新扫描（大图库扫一遍可能要好几秒）
    library_cache_path: PathBuf,
    scanning: AtomicBool,
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
        let settings: Settings = fs::read(&settings_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let images = ImageService::new(cache_dir.join("thumbs"));
        images.set_roots(&settings.roots);
        let library_cache_path = config_dir.join("library-cache.json");
        let cached: Vec<Folder> = fs::read(&library_cache_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Vec<Folder>>(&b).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|f| settings.roots.contains(&f.root))
            .collect();
        AppState {
            settings_path,
            library_cache_path,
            scanning: AtomicBool::new(false),
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
        Library { roots: self.settings.lock().roots.clone(), folders: self.folders.read().clone() }
    }

    fn rescan_all(&self) -> Library {
        let roots = self.settings.lock().roots.clone();
        let mut folders = Vec::new();
        for r in &roots {
            folders.extend(scan::scan_root(Path::new(r), &self.stars));
        }
        *self.folders.write() = folders;
        self.scanned.store(true, Ordering::SeqCst);
        self.persist_folders();
        self.library()
    }

    fn persist_folders(&self) {
        if let Ok(json) = serde_json::to_vec(&*self.folders.read()) {
            let _ = fs::write(&self.library_cache_path, json);
        }
    }

    fn folder_starred_count(&self, dir: &Path) -> usize {
        let set = self.stars.load(dir);
        if set.is_empty() {
            return 0;
        }
        fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| formats::is_supported(&e.path()))
                    .filter(|e| stars::is_starred(&set, &e.file_name().to_string_lossy()))
                    .count()
            })
            .unwrap_or(0)
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
        return blocking(move || Ok(st.rescan_all())).await;
    }
    if !st.scanning.swap(true, Ordering::SeqCst) {
        let st2 = st.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let lib = st2.rescan_all();
            st2.scanning.store(false, Ordering::SeqCst);
            let _ = app.emit("library-updated", lib);
        });
    }
    Ok(st.library())
}

#[tauri::command]
async fn rescan(state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || Ok(st.rescan_all())).await
}

#[tauri::command]
async fn add_root(path: String, state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || {
        let mut p = PathBuf::from(&path);
        // 拖进来的是照片文件：添加它所在的文件夹
        if p.is_file() {
            p = p.parent().map(Path::to_path_buf).ok_or("无效路径")?;
        }
        if !p.is_dir() {
            return Err("不是文件夹".into());
        }
        let path = p.to_string_lossy().trim_end_matches('/').to_string();
        let path = if path.is_empty() { "/".to_string() } else { path };
        let mut s = st.settings.lock().clone();
        if s.roots.iter().any(|r| Path::new(&path).starts_with(r)) {
            return Ok(st.library()); // 已经在某个根目录里了
        }
        // 新根目录包含了旧的根目录：旧的并进来
        s.roots.retain(|r| !Path::new(r).starts_with(&path));
        s.roots.push(path.clone());
        st.save_settings(&s)?;
        st.images.set_roots(&s.roots);
        let new_folders = scan::scan_root(Path::new(&path), &st.stars);
        {
            let mut folders = st.folders.write();
            folders.retain(|f| s.roots.contains(&f.root));
            folders.extend(new_folders);
        }
        *st.settings.lock() = s;
        st.persist_folders();
        Ok(st.library())
    })
    .await
}

#[tauri::command]
async fn remove_root(path: String, state: AppStateRef<'_>) -> Result<Library, String> {
    let st = state.inner().clone();
    blocking(move || {
        let mut s = st.settings.lock().clone();
        s.roots.retain(|r| r != &path);
        st.save_settings(&s)?;
        st.images.set_roots(&s.roots);
        st.folders.write().retain(|f| f.root != path);
        *st.settings.lock() = s;
        st.persist_folders();
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
        for (dir, names) in by_dir {
            if st.stars.set(&dir, &names, starred)? == StarLocation::Fallback {
                res.fallback = true;
            }
            let count = st.folder_starred_count(&dir);
            let key = dir.to_string_lossy().into_owned();
            if let Some(f) = st.folders.write().iter_mut().find(|f| f.path == key) {
                f.starred = count;
            }
            res.folders.insert(key, count);
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
            add_root,
            remove_root,
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
