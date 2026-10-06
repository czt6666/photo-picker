//! 导出：把选中的照片复制（或缩小后另存）到目标文件夹。
//!
//! - **原图**：直接复制文件。macOS 的 APFS 上 `fs::copy` 会走 clonefile（写时复制），
//!   几十 GB 也是瞬间完成、不占额外空间；随后把修改时间设成和原图一致。
//! - **缩小**：长边缩到指定像素、按指定质量存成 JPEG，并保留原图的 EXIF（拍摄时间、GPS、参数）
//!   和 ICC 色彩配置。原图本来就不大于目标尺寸的 JPEG 直接复制，避免无谓的二次压缩。
//!
//! 重名时自动改名为 `名字 (1).jpg`。多张缩图并行处理。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::decode::render_jpeg;
use crate::formats::{ext_of, is_jpeg};
use crate::meta::{read_jpeg_head, transplant_metadata};

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ExportMode {
    Original,
    Resize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub paths: Vec<String>,
    pub dest: String,
    /// 在目标文件夹下再建一个子文件夹（可空）
    #[serde(default)]
    pub subfolder: Option<String>,
    pub mode: ExportMode,
    #[serde(default = "default_max_px")]
    pub max_px: u32,
    #[serde(default = "default_quality")]
    pub quality: u8,
}

fn default_max_px() -> u32 {
    2048
}
fn default_quality() -> u8 {
    90
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportProgress {
    pub done: usize,
    pub total: usize,
    pub current: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub exported: usize,
    pub failed: Vec<ExportFailure>,
    pub dest: String,
    pub cancelled: bool,
}

/// 文件名里不允许出现的字符（子文件夹名由用户输入）。
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c })
        .collect::<String>()
        .trim()
        .trim_matches('.')
        .to_string()
}

/// 找一个不冲突的目标路径：a.jpg → a (1).jpg → a (2).jpg …
fn unique_target(dir: &Path, stem: &str, ext: &str, reserved: &mut HashSet<PathBuf>) -> PathBuf {
    let make = |n: usize| {
        let name = if n == 0 { format!("{stem}.{ext}") } else { format!("{stem} ({n}).{ext}") };
        dir.join(name)
    };
    let mut n = 0;
    loop {
        let p = make(n);
        if !p.exists() && !reserved.contains(&p) {
            reserved.insert(p.clone());
            return p;
        }
        n += 1;
    }
}

pub fn run_export(
    req: &ExportRequest,
    cancel: &AtomicBool,
    progress: &(dyn Fn(ExportProgress) + Sync),
) -> Result<ExportResult, String> {
    let mut dest = PathBuf::from(&req.dest);
    if let Some(sub) = req.subfolder.as_deref().map(sanitize).filter(|s| !s.is_empty()) {
        dest.push(sub);
    }
    fs::create_dir_all(&dest).map_err(|e| format!("无法创建目标文件夹：{e}"))?;
    let dest_canon = dest.canonicalize().unwrap_or_else(|_| dest.clone());

    // 先串行地为每张图分配好目标文件名，后面并行处理时就不会抢同一个名字
    let mut reserved = HashSet::new();
    let mut plan: Vec<(PathBuf, PathBuf, bool)> = Vec::new(); // (源, 目标, 是否直接复制)
    let mut failed = Vec::new();
    for p in &req.paths {
        let src = PathBuf::from(p);
        if !src.is_file() {
            failed.push(ExportFailure { path: p.clone(), error: "文件不存在".into() });
            continue;
        }
        if src.parent().and_then(|d| d.canonicalize().ok()).as_deref() == Some(dest_canon.as_path()) {
            failed.push(ExportFailure { path: p.clone(), error: "源文件已在目标文件夹中".into() });
            continue;
        }
        let stem = src.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let ext = ext_of(&src).unwrap_or_default();
        let copy = match req.mode {
            ExportMode::Original => true,
            ExportMode::Resize => is_jpeg(&ext) && long_edge(&src).is_some_and(|l| l <= req.max_px),
        };
        let out_ext = if copy {
            src.extension().unwrap_or_default().to_string_lossy().into_owned()
        } else {
            "jpg".to_string()
        };
        let target = unique_target(&dest, &stem, &out_ext, &mut reserved);
        plan.push((src, target, copy));
    }

    let total = req.paths.len();
    let done = AtomicUsize::new(failed.len());
    let exported = AtomicUsize::new(0);
    let failed = Mutex::new(failed);
    let next = AtomicUsize::new(0);
    // 原图复制是磁盘 IO，开太多线程反而互相抢；缩图是 CPU 活，按核数开
    let threads = match req.mode {
        ExportMode::Original => 2,
        ExportMode::Resize => std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8),
    };

    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some((src, target, copy)) = plan.get(i) else { return };
                let r = if *copy { copy_original(src, target) } else { resize_one(src, target, req.max_px, req.quality) };
                match r {
                    Ok(()) => {
                        exported.fetch_add(1, Ordering::SeqCst);
                    }
                    Err(e) => {
                        let _ = fs::remove_file(target);
                        failed.lock().push(ExportFailure { path: src.to_string_lossy().into_owned(), error: e });
                    }
                }
                let d = done.fetch_add(1, Ordering::SeqCst) + 1;
                progress(ExportProgress {
                    done: d,
                    total,
                    current: src.file_name().unwrap_or_default().to_string_lossy().into_owned(),
                });
            });
        }
    });

    Ok(ExportResult {
        exported: exported.into_inner(),
        failed: failed.into_inner(),
        dest: dest.to_string_lossy().into_owned(),
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

fn long_edge(path: &Path) -> Option<u32> {
    imagesize::size(path).ok().map(|d| d.width.max(d.height) as u32)
}

fn copy_original(src: &Path, target: &Path) -> Result<(), String> {
    fs::copy(src, target).map_err(|e| e.to_string())?;
    if let Ok(mtime) = fs::metadata(src).and_then(|m| m.modified()) {
        if let Ok(f) = fs::File::options().write(true).open(target) {
            let _ = f.set_modified(mtime);
        }
    }
    Ok(())
}

fn resize_one(src: &Path, target: &Path, max_px: u32, quality: u8) -> Result<(), String> {
    let rendered = render_jpeg(src, max_px, quality)?;
    let ext = ext_of(src).unwrap_or_default();
    let bytes = if is_jpeg(&ext) {
        transplant_metadata(&read_jpeg_head(src), rendered.jpeg)
    } else {
        rendered.jpeg
    };
    fs::write(target, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::make_jpeg;
    use crate::meta::tests::with_exif;

    fn req(paths: &[&Path], dest: &Path, mode: ExportMode) -> ExportRequest {
        ExportRequest {
            paths: paths.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
            dest: dest.to_string_lossy().into_owned(),
            subfolder: None,
            mode,
            max_px: 1000,
            quality: 85,
        }
    }

    #[test]
    fn copies_originals_and_renames_on_conflict() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let p1 = a.path().join("IMG_1.jpg");
        let p2 = b.path().join("IMG_1.jpg"); // 不同文件夹的同名文件
        fs::write(&p1, make_jpeg(100, 50)).unwrap();
        fs::write(&p2, make_jpeg(60, 50)).unwrap();
        fs::write(out.path().join("IMG_1.jpg"), b"existing").unwrap();

        let r = run_export(&req(&[&p1, &p2], out.path(), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 2);
        assert!(r.failed.is_empty());
        assert_eq!(fs::read(out.path().join("IMG_1.jpg")).unwrap(), b"existing", "已有文件不能被覆盖");
        assert_eq!(fs::read(out.path().join("IMG_1 (1).jpg")).unwrap(), fs::read(&p1).unwrap());
        assert_eq!(fs::read(out.path().join("IMG_1 (2).jpg")).unwrap(), fs::read(&p2).unwrap());
        let m1 = fs::metadata(&p1).unwrap().modified().unwrap();
        let m2 = fs::metadata(out.path().join("IMG_1 (1).jpg")).unwrap().modified().unwrap();
        assert_eq!(m1, m2, "保留修改时间");
    }

    #[test]
    fn resize_keeps_exif_and_resets_orientation() {
        let a = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let big = a.path().join("big.jpg");
        let small = a.path().join("small.jpg");
        fs::write(&big, with_exif(&make_jpeg(3000, 2000), 6)).unwrap();
        fs::write(&small, make_jpeg(800, 600)).unwrap();

        let mut rq = req(&[&big, &small], out.path(), ExportMode::Resize);
        rq.subfolder = Some("精选/../2024".into());
        let r = run_export(&rq, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 2, "{:?}", r.failed);
        let dir = out.path().join("精选_.._2024");
        let img = image::open(dir.join("big.jpg")).unwrap();
        // 666.67 → 不同解码器取整可能差 1
        assert!((666..=667).contains(&img.width()) && img.height() == 1000, "转正后竖图，长边 1000：{:?}", (img.width(), img.height()));
        let bytes = fs::read(dir.join("big.jpg")).unwrap();
        let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(bytes)).unwrap();
        assert_eq!(exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0), Some(1));
        // 小图原样复制
        assert_eq!(fs::read(dir.join("small.jpg")).unwrap(), fs::read(&small).unwrap());
    }

    #[test]
    fn missing_file_and_cancel() {
        let out = tempfile::tempdir().unwrap();
        let ghost = out.path().join("nope.jpg");
        let r = run_export(&req(&[&ghost], &out.path().join("x"), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 0);
        assert_eq!(r.failed.len(), 1);

        let a = tempfile::tempdir().unwrap();
        let p = a.path().join("a.jpg");
        fs::write(&p, make_jpeg(10, 10)).unwrap();
        let r = run_export(&req(&[&p], &out.path().join("y"), ExportMode::Original), &AtomicBool::new(true), &|_| {}).unwrap();
        assert!(r.cancelled);
        assert_eq!(r.exported, 0);
    }
}
