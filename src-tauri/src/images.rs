//! 图片服务：缩略图（磁盘缓存）+ 看图用的屏幕尺寸预览（内存缓存）+ 原图直出。
//!
//! 前端不通过 IPC 要图片字节（JSON/base64 序列化很慢），而是用自定义协议的 URL 直接放进 `<img src>`：
//! - `thumb://localhost/<路径>`：400px 缩略图。磁盘上有缓存就直接读，没有就排队生成。
//! - `photo://localhost/<路径>?max=3072`：看图用。原图不大就原样返回；
//!   原图远大于屏幕（如 4500 万像素）就先缩成屏幕尺寸的 JPEG，webview 解码快 5~10 倍、内存也省得多。
//!   `max=0` 表示要原图（放大到 100% 查看对焦时用）。
//!
//! 浏览器负责并发请求、取消、内存里的图片缓存，我们只管“按优先级把字节准备好”。

use std::fs;
use std::num::NonZeroUsize;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use lru::LruCache;
use parking_lot::{Mutex, RwLock};

use crate::decode::{render_jpeg, render_jpeg_for_screen};
use crate::formats::{ext_of, is_supported, is_web_native, mime_for, prefers_screen_preview};
use crate::pool::{Bytes, Pool, Priority, Work};
use crate::scan::mtime_ms;

/// 缩略图长边像素。网格最大格子约 240pt，Retina 屏上 400px 足够清晰，单张约 25KB。
pub const THUMB_PX: u32 = 400;
const THUMB_QUALITY: u8 = 80;
const PREVIEW_QUALITY: u8 = 88;
/// 改了缩略图尺寸/算法时改这个版本号，旧缓存自动作废
const THUMB_VERSION: &str = "v1";

pub type Served = Result<(Bytes, &'static str), String>;
pub type Respond = Box<dyn FnOnce(Served) + Send>;

pub struct ImageService {
    pub pool: Pool,
    thumb_dir: PathBuf,
    /// 屏幕尺寸预览的内存缓存（按张数限量，一张 0.5~2MB）
    previews: Arc<Mutex<LruCache<String, Bytes>>>,
    roots: RwLock<Vec<PathBuf>>,
}

impl ImageService {
    pub fn new(thumb_dir: PathBuf) -> Self {
        ImageService {
            pool: Pool::new(Pool::default_threads()),
            thumb_dir,
            previews: Arc::new(Mutex::new(LruCache::new(NonZeroUsize::new(40).unwrap()))),
            roots: RwLock::new(Vec::new()),
        }
    }

    pub fn thumb_dir(&self) -> &Path {
        &self.thumb_dir
    }

    pub fn set_roots(&self, roots: &[String]) {
        *self.roots.write() = roots.iter().map(PathBuf::from).collect();
    }

    /// 只允许访问图库根目录下的图片文件（协议 URL 理论上能被页面拼出任意路径，这里兜底）。
    pub fn allowed(&self, p: &Path) -> bool {
        p.is_absolute()
            && !p.components().any(|c| matches!(c, Component::ParentDir))
            && is_supported(p)
            && self.roots.read().iter().any(|r| p.starts_with(r))
    }

    pub fn allowed_dir(&self, p: &Path) -> bool {
        p.is_absolute()
            && !p.components().any(|c| matches!(c, Component::ParentDir))
            && self.roots.read().iter().any(|r| p.starts_with(r))
    }

    fn thumb_path(&self, src: &Path, meta: &fs::Metadata) -> PathBuf {
        let mut h = blake3::Hasher::new();
        h.update(src.to_string_lossy().as_bytes());
        h.update(format!("|{}|{}|{THUMB_VERSION}-{THUMB_PX}", meta.len(), mtime_ms(meta)).as_bytes());
        let hex = h.finalize().to_hex();
        self.thumb_dir.join(&hex[..2]).join(format!("{}.jpg", &hex[2..32]))
    }

    /// 取缩略图。在后台线程调用（会读磁盘）。
    pub fn thumb(&self, src: PathBuf, prio: Priority, respond: Respond) {
        let meta = match fs::metadata(&src) {
            Ok(m) => m,
            Err(e) => return respond(Err(e.to_string())),
        };
        let dst = self.thumb_path(&src, &meta);
        if let Ok(b) = fs::read(&dst) {
            return respond(Ok((Arc::new(b), "image/jpeg")));
        }
        let key = dst.to_string_lossy().into_owned();
        self.pool.submit(
            key,
            prio,
            thumb_work(src, dst),
            Some(Box::new(move |r| respond(r.map(|b| (b, "image/jpeg"))))),
        );
    }

    /// 后台把一批照片的缩略图预先生成好（已有缓存的跳过）。替换掉之前的后台队列。
    pub fn prefetch(&self, srcs: Vec<PathBuf>) {
        let jobs: Vec<(String, Work)> = srcs
            .into_iter()
            .filter(|s| self.allowed(s))
            .filter_map(|src| {
                let meta = fs::metadata(&src).ok()?;
                let dst = self.thumb_path(&src, &meta);
                if dst.exists() {
                    return None;
                }
                Some((dst.to_string_lossy().into_owned(), thumb_work(src, dst)))
            })
            .collect();
        self.pool.replace_low(jobs);
    }

    /// 看图用的图片。`max == 0` 要原图；`force_preview` 表示 webview 解不了原图，必须转成 JPEG。
    pub fn photo(&self, src: PathBuf, max: u32, force_preview: bool, prio: Priority, respond: Respond) {
        let ext = ext_of(&src).unwrap_or_default();
        let meta = match fs::metadata(&src) {
            Ok(m) => m,
            Err(e) => return respond(Err(e.to_string())),
        };
        if is_web_native(&ext) && !force_preview {
            let small_enough = || {
                imagesize::size(&src).map_or(true, |d| (d.width.max(d.height) as u64) * 4 <= max as u64 * 5)
            };
            if max == 0 || !prefers_screen_preview(&ext) || small_enough() {
                return respond(fs::read(&src).map(|b| (Arc::new(b), mime_for(&ext))).map_err(|e| e.to_string()));
            }
        }
        let key = format!("{}|{}|{}|{}", src.display(), meta.len(), mtime_ms(&meta), max);
        if let Some(b) = self.previews.lock().get(&key).cloned() {
            return respond(Ok((b, "image/jpeg")));
        }
        let cache = self.previews.clone();
        let cache_key = key.clone();
        let work: Work = Box::new(move || {
            let r = render_jpeg_for_screen(&src, max, PREVIEW_QUALITY)?;
            let bytes = Arc::new(r.jpeg);
            cache.lock().put(cache_key, bytes.clone());
            Ok(bytes)
        });
        self.pool.submit(key, prio, work, Some(Box::new(move |r| respond(r.map(|b| (b, "image/jpeg"))))));
    }

    /// 缩略图缓存占用的字节数和文件数。
    pub fn cache_usage(&self) -> (u64, usize) {
        walkdir::WalkDir::new(&self.thumb_dir)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .fold((0, 0), |(b, n), e| (b + e.metadata().map_or(0, |m| m.len()), n + 1))
    }

    pub fn clear_cache(&self) -> std::io::Result<()> {
        self.previews.lock().clear();
        match fs::remove_dir_all(&self.thumb_dir) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
}

fn thumb_work(src: PathBuf, dst: PathBuf) -> Work {
    Box::new(move || {
        if let Ok(b) = fs::read(&dst) {
            return Ok(Arc::new(b));
        }
        let r = render_jpeg(&src, THUMB_PX, THUMB_QUALITY)?;
        if let Some(parent) = dst.parent() {
            let _ = fs::create_dir_all(parent);
        }
        // 先写临时文件再改名：别的线程/进程永远不会读到写了一半的缩略图
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = dst.with_extension(format!("tmp{}-{}", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
        if fs::write(&tmp, &r.jpeg).is_ok() && fs::rename(&tmp, &dst).is_err() {
            let _ = fs::remove_file(&tmp);
        }
        Ok(Arc::new(r.jpeg))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::make_jpeg;
    use std::sync::mpsc;
    use std::time::Duration;

    fn setup() -> (tempfile::TempDir, tempfile::TempDir, ImageService) {
        let photos = tempfile::tempdir().unwrap();
        let cache = tempfile::tempdir().unwrap();
        let svc = ImageService::new(cache.path().join("thumbs"));
        svc.set_roots(&[photos.path().to_string_lossy().into_owned()]);
        (photos, cache, svc)
    }

    fn call(f: impl FnOnce(Respond)) -> Served {
        let (tx, rx) = mpsc::channel();
        f(Box::new(move |r| tx.send(r).unwrap()));
        rx.recv_timeout(Duration::from_secs(10)).unwrap()
    }

    #[test]
    fn thumb_is_generated_then_served_from_disk_cache() {
        let (photos, _c, svc) = setup();
        let p = photos.path().join("a.jpg");
        fs::write(&p, make_jpeg(2000, 1000)).unwrap();
        let (b, mime) = call(|r| svc.thumb(p.clone(), Priority::High, r)).unwrap();
        assert_eq!(mime, "image/jpeg");
        let img = image::load_from_memory(&b).unwrap();
        assert_eq!((img.width(), img.height()), (400, 200));
        let (usage, files) = svc.cache_usage();
        assert_eq!(files, 1);
        assert!(usage > 0);
        let (b2, _) = call(|r| svc.thumb(p.clone(), Priority::High, r)).unwrap();
        assert_eq!(b, b2);
    }

    #[test]
    fn photo_passthrough_vs_preview() {
        let (photos, _c, svc) = setup();
        let big = photos.path().join("big.jpg");
        let original = make_jpeg(4000, 2000);
        fs::write(&big, &original).unwrap();
        // 原图请求：原样返回
        let (b, _) = call(|r| svc.photo(big.clone(), 0, false, Priority::Urgent, r)).unwrap();
        assert_eq!(*b, original);
        // 屏幕预览：缩到 ≤2048（允许为了解码快而略小，见 render_jpeg_for_screen）
        let (b, mime) = call(|r| svc.photo(big.clone(), 2048, false, Priority::Urgent, r)).unwrap();
        assert_eq!(mime, "image/jpeg");
        let img = image::load_from_memory(&b).unwrap();
        assert!((1800..=2048).contains(&img.width()) && img.width() == img.height() * 2, "{:?}", (img.width(), img.height()));
        // 原图只比目标大一点点（≤1.25 倍）时不值得转码
        let (b, _) = call(|r| svc.photo(big.clone(), 3600, false, Priority::Urgent, r)).unwrap();
        assert_eq!(*b, original);
    }

    #[test]
    fn rejects_paths_outside_roots() {
        let (photos, _c, svc) = setup();
        assert!(svc.allowed(&photos.path().join("x.jpg")));
        assert!(!svc.allowed(Path::new("/etc/passwd")));
        assert!(!svc.allowed(&photos.path().join("../escape.jpg")));
        assert!(!svc.allowed(&photos.path().join("notes.txt")));
    }

    #[test]
    fn prefetch_generates_in_background() {
        let (photos, _c, svc) = setup();
        let mut paths = Vec::new();
        for i in 0..6 {
            let p = photos.path().join(format!("{i}.jpg"));
            fs::write(&p, make_jpeg(800, 600)).unwrap();
            paths.push(p);
        }
        svc.prefetch(paths);
        for _ in 0..100 {
            if svc.cache_usage().1 == 6 {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("后台预生成没有完成：{:?}", svc.cache_usage());
    }
}
