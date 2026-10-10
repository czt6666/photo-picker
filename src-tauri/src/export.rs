//! 导出：把选中的照片复制（或缩小后另存）到目标文件夹。
//!
//! - **原图**：直接复制文件。macOS 的 APFS 上 `fs::copy` 会走 clonefile（写时复制），
//!   几十 GB 也是瞬间完成、不占额外空间；随后把修改时间设成和原图一致。
//! - **缩小**：长边缩到指定像素、按指定质量存成 JPEG，并保留原图的 EXIF（拍摄时间、GPS、参数）
//!   和 ICC 色彩配置。原图本来就不大于目标尺寸的 JPEG 直接复制，避免无谓的二次压缩。
//!
//! **RAW+JPG**：默认把同名的 RAW（和 .xmp）一起导出，RAW 始终原样复制（RAW 没法“缩小”）。
//!
//! 重名时自动改名为 `名字 (1).jpg`；成组的文件一起改名（`IMG_1 (1).JPG` + `IMG_1 (1).CR3`），
//! 保证导出后 RAW 和 JPG 依然同名配对。多张缩图并行处理。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::decode::render_jpeg;
use crate::formats::{ext_of, is_companion, is_jpeg, is_raw, is_supported_ext};
use crate::meta::{read_jpeg_head, transplant_metadata};
use crate::picasa_ini::norm_name;
use crate::scan::{companion_map, split_group_stem};

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
    /// 同时导出同名的 RAW / xmp 文件
    #[serde(default = "default_true")]
    pub include_companions: bool,
}

fn default_true() -> bool {
    true
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
    /// 导出的照片数（RAW+JPG 算一张）
    pub exported: usize,
    /// 实际写出的文件数（含 RAW 等伴侣文件）
    pub files: usize,
    pub failed: Vec<ExportFailure>,
    pub dest: String,
    pub cancelled: bool,
}

/// 把用户输入的子文件夹名清理成各平台都合法的文件名。
/// 按最严格的 Windows 规则来（导出的文件夹可能拷到 Windows / U 盘上）：
/// 不能含 `<>:"/\|?*` 和控制字符，不能以点或空格结尾，不能叫 CON、NUL、COM1 这类设备名。
fn sanitize(name: &str) -> String {
    let s = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*') || c.is_control() { '_' } else { c })
        .collect::<String>();
    let s = s.trim().trim_matches('.').trim().to_string();
    let stem = s.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved {
        format!("{s}_")
    } else {
        s
    }
}

/// 已被占用的“组名”（规范化：NFC + 小写，因为 macOS 默认的 APFS 不区分大小写）。
///
/// 按组名而不是按完整文件名占位：否则 A 文件夹只有 JPG 的 `IMG_1.JPG` 和 B 文件夹只有 RAW 的
/// `IMG_1.CR3` 导出到同一处后，会被当成一对 RAW+JPG。目标文件夹里已有的图片/RAW/xmp 也按组名算占用。
fn taken_stems(dest: &Path) -> HashSet<String> {
    let Ok(rd) = fs::read_dir(dest) else { return HashSet::new() };
    rd.flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| {
            let ext = n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
            is_supported_ext(&ext) || is_companion(&ext)
        })
        .map(|n| norm_name(split_group_stem(&n).0))
        .collect()
}

/// 目标位置已经有东西（包括失效的符号链接——`exists()` 会把它当成不存在，复制时却会顺着链接写到别处）。
fn occupied(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok()
}

/// 为一组文件找一套不冲突的目标路径。`tails` 是每个文件名去掉组名后的部分（如 `.JPG`、`.CR3`、`.CR3.xmp`）。
/// 组名没被占用、且每个目标文件都不存在时用原名；否则整组一起改成 `组名 (n)` + 各自的后缀：a.jpg → a (1).jpg …
fn unique_targets(dir: &Path, stem: &str, tails: &[String], taken: &mut HashSet<String>) -> Vec<PathBuf> {
    let mut n = 0;
    loop {
        let base = if n == 0 { stem.to_string() } else { format!("{stem} ({n})") };
        let key = norm_name(&base);
        let paths: Vec<PathBuf> = tails.iter().map(|t| dir.join(format!("{base}{t}"))).collect();
        if !taken.contains(&key) && paths.iter().all(|p| !occupied(p)) {
            taken.insert(key);
            return paths;
        }
        n += 1;
    }
}

struct PlanItem {
    src: PathBuf,
    target: PathBuf,
    /// true = 直接复制；false = 缩小重新编码
    copy: bool,
    /// 伴侣文件（源, 目标），总是原样复制
    companions: Vec<(PathBuf, PathBuf)>,
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
    let mut reserved = taken_stems(&dest);
    let mut plan: Vec<PlanItem> = Vec::new();
    let mut failed = Vec::new();
    // 伴侣文件表按文件夹缓存：每个文件夹只读一次目录（几千张时差别是几十秒 vs 一眨眼）
    let mut companion_cache: HashMap<PathBuf, HashMap<String, Vec<String>>> = HashMap::new();
    for p in &req.paths {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let src = PathBuf::from(p);
        match fs::symlink_metadata(&src) {
            Ok(m) if m.is_file() => {}
            Ok(_) => {
                failed.push(ExportFailure { path: p.clone(), error: "不是普通文件".into() });
                continue;
            }
            Err(_) => {
                failed.push(ExportFailure { path: p.clone(), error: "文件不存在".into() });
                continue;
            }
        }
        let dir = src.parent().unwrap_or(Path::new("")).to_path_buf();
        if dir.canonicalize().ok().as_deref() == Some(dest_canon.as_path()) {
            failed.push(ExportFailure { path: p.clone(), error: "源文件已在目标文件夹中".into() });
            continue;
        }
        let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
        let (stem, tail) = split_group_stem(&name);
        let ext = ext_of(&src).unwrap_or_default();
        let copy = match req.mode {
            ExportMode::Original => true,
            ExportMode::Resize => is_jpeg(&ext) && long_edge(&src).is_some_and(|l| l <= req.max_px),
        };
        let mut companions: Vec<PathBuf> = Vec::new();
        if req.include_companions {
            // 只有 RAW 没有 JPG 的照片（macOS）在缩小导出时会转成 JPG；勾了“同时导出 RAW”就把 RAW 原件也带上
            if !copy && is_raw(&ext) {
                companions.push(src.clone());
            }
            let map = companion_cache.entry(dir.clone()).or_insert_with(|| companion_map(&dir));
            companions.extend(map.get(&name).into_iter().flatten().map(|c| dir.join(c)));
        }
        // 组内后缀忽略大小写去重（区分大小写的磁盘上可能同时有 IMG_1.CR3 和 img_1.cr3），重复的单独取名
        let mut tails = vec![if copy { tail.to_string() } else { ".jpg".to_string() }];
        let mut seen: HashSet<String> = tails.iter().map(|t| t.to_lowercase()).collect();
        let (mut grouped, mut separate) = (Vec::new(), Vec::new());
        for c in companions {
            let ctail = split_group_stem(&c.file_name().unwrap_or_default().to_string_lossy()).1.to_string();
            if seen.insert(ctail.to_lowercase()) {
                tails.push(ctail);
                grouped.push(c);
            } else {
                separate.push(c);
            }
        }
        let mut targets = unique_targets(&dest, stem, &tails, &mut reserved).into_iter();
        let target = targets.next().expect("至少有主文件");
        let mut pairs: Vec<(PathBuf, PathBuf)> = grouped.into_iter().zip(targets).collect();
        for c in separate {
            let cname = c.file_name().unwrap_or_default().to_string_lossy().into_owned();
            let (cstem, ctail) = split_group_stem(&cname);
            let t = unique_targets(&dest, cstem, &[ctail.to_string()], &mut reserved).remove(0);
            pairs.push((c, t));
        }
        plan.push(PlanItem { src, target, copy, companions: pairs });
    }

    let total = req.paths.len();
    let done = AtomicUsize::new(failed.len());
    let exported = AtomicUsize::new(0);
    let files = AtomicUsize::new(0);
    let failed = Mutex::new(failed);
    let next = AtomicUsize::new(0);
    // 原图复制是磁盘 IO，开太多线程反而互相抢；缩图是 CPU 活，按核数开
    let threads = match req.mode {
        ExportMode::Original => 2,
        ExportMode::Resize => std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(1, 8),
    };
    let fail = |path: &Path, error: String| {
        failed.lock().push(ExportFailure { path: path.to_string_lossy().into_owned(), error });
    };

    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| loop {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let i = next.fetch_add(1, Ordering::SeqCst);
                let Some(item) = plan.get(i) else { return };
                let (src, target) = (&item.src, &item.target);
                let r = if item.copy { copy_original(src, target) } else { resize_one(src, target, req.max_px, req.quality) };
                match r {
                    Ok(()) => {
                        files.fetch_add(1, Ordering::SeqCst);
                        // 一张照片 = 主文件 + 全部伴侣都成功才算导出成功
                        let mut whole = true;
                        for (csrc, ctarget) in &item.companions {
                            match copy_original(csrc, ctarget) {
                                Ok(()) => {
                                    files.fetch_add(1, Ordering::SeqCst);
                                }
                                Err(e) => {
                                    whole = false;
                                    fail(csrc, e);
                                }
                            }
                        }
                        if whole {
                            exported.fetch_add(1, Ordering::SeqCst);
                        }
                    }
                    // 主文件都失败了，伴侣就不单独导出了（导出半组没有意义）
                    Err(e) => fail(src, e),
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
        files: files.into_inner(),
        failed: failed.into_inner(),
        dest: dest.to_string_lossy().into_owned(),
        cancelled: cancel.load(Ordering::Relaxed),
    })
}

fn long_edge(path: &Path) -> Option<u32> {
    imagesize::size(path).ok().map(|d| d.width.max(d.height) as u32)
}

/// 复制原文件。目标已存在就报错——绝不覆盖用户已有的文件。
fn copy_original(src: &Path, target: &Path) -> Result<(), String> {
    if occupied(target) {
        return Err("目标文件已存在".into());
    }
    if let Err(e) = fs::copy(src, target) {
        let _ = fs::remove_file(target); // 复制了一半的残留（上面已确认原本不存在，是我们自己创建的）
        return Err(e.to_string());
    }
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
    // create_new：目标若已存在（比如别的程序刚写进来）就失败，绝不覆盖
    let mut f = fs::File::options().write(true).create_new(true).open(target).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => "目标文件已存在".to_string(),
        _ => e.to_string(),
    })?;
    use std::io::Write;
    f.write_all(&bytes).map_err(|e| {
        drop(fs::remove_file(target));
        e.to_string()
    })
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
            include_companions: true,
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
    fn sanitize_follows_windows_rules() {
        assert_eq!(sanitize("精选/../2024"), "精选_.._2024");
        assert_eq!(sanitize(r#"a<b>c:"d|e?f*g"#), "a_b_c__d_e_f_g");
        assert_eq!(sanitize("  旅行.  "), "旅行");
        assert_eq!(sanitize("con"), "con_");
        assert_eq!(sanitize("COM1.jpg"), "COM1.jpg_");
        assert_eq!(sanitize("COMA"), "COMA");
        assert_eq!(sanitize("Console"), "Console");
        assert_eq!(sanitize("a\tb"), "a_b");
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
    fn exports_raw_with_jpg_and_keeps_pairs_matched_on_rename() {
        let a = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let jpg = a.path().join("IMG_1.JPG");
        fs::write(&jpg, make_jpeg(3000, 2000)).unwrap();
        fs::write(a.path().join("IMG_1.CR3"), b"raw-bytes").unwrap();
        fs::write(a.path().join("IMG_1.CR3.xmp"), b"<xmp/>").unwrap();
        // 目标文件夹里已有一个同名 RAW：整组都要改名，不能只改 JPG
        fs::write(out.path().join("IMG_1.CR3"), b"old").unwrap();

        let r = run_export(&req(&[&jpg], out.path(), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!((r.exported, r.files), (1, 3), "{:?}", r.failed);
        let mut names: Vec<_> = fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, vec!["IMG_1 (1).CR3", "IMG_1 (1).CR3.xmp", "IMG_1 (1).JPG", "IMG_1.CR3"]);
        assert_eq!(fs::read(out.path().join("IMG_1 (1).CR3")).unwrap(), b"raw-bytes");
        assert_eq!(fs::read(out.path().join("IMG_1.CR3")).unwrap(), b"old", "已有文件不能被覆盖");

        // 缩小导出：JPG 缩小成 .jpg，RAW 原样复制，仍然同名
        let mut rq = req(&[&jpg], &out.path().join("small"), ExportMode::Resize);
        rq.max_px = 800;
        let r = run_export(&rq, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!((r.exported, r.files), (1, 3));
        assert!(out.path().join("small/IMG_1.jpg").exists());
        assert_eq!(fs::read(out.path().join("small/IMG_1.CR3")).unwrap(), b"raw-bytes");

        // 关掉“同时导出 RAW”
        let mut rq = req(&[&jpg], &out.path().join("jpg-only"), ExportMode::Original);
        rq.include_companions = false;
        let r = run_export(&rq, &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!((r.exported, r.files), (1, 1));
        assert!(!out.path().join("jpg-only/IMG_1.CR3").exists());
    }

    #[test]
    fn case_insensitive_names_never_overwrite_each_other() {
        // 缩小导出时：大图重新编码成 IMG_0001.jpg，小图原样复制成 IMG_0001.JPG——在 macOS 上是同一个文件名
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let big = a.path().join("IMG_0001.JPG");
        let small = b.path().join("IMG_0001.JPG");
        fs::write(&big, make_jpeg(3000, 2000)).unwrap();
        fs::write(&small, make_jpeg(800, 600)).unwrap();
        let r = run_export(&req(&[&big, &small], out.path(), ExportMode::Resize), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 2, "{:?}", r.failed);
        let mut names: Vec<String> = fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap().to_lowercase()).collect();
        names.sort();
        assert_eq!(names, vec!["img_0001 (1).jpg", "img_0001.jpg"], "小写后也不能重名");
    }

    #[test]
    fn copy_never_overwrites_and_existing_raw_renames_whole_group() {
        let a = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let raw = a.path().join("IMG_1.CR3");
        fs::write(&raw, b"raw").unwrap();
        // 底层保护：目标已存在就拒绝，原文件不动
        let existing = out.path().join("IMG_1.CR3");
        fs::write(&existing, b"keep me").unwrap();
        assert_eq!(copy_original(&raw, &existing), Err("目标文件已存在".into()));
        assert_eq!(fs::read(&existing).unwrap(), b"keep me");

        // 规划层：已有同名 RAW → 整组改名为 IMG_1 (1).*
        let jpg = a.path().join("IMG_1.JPG");
        fs::write(&jpg, make_jpeg(100, 80)).unwrap();
        let r = run_export(&req(&[&jpg], out.path(), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!((r.exported, r.files), (1, 2), "{:?}", r.failed);
        assert!(out.path().join("IMG_1 (1).JPG").exists() && out.path().join("IMG_1 (1).CR3").exists());
        assert_eq!(fs::read(&existing).unwrap(), b"keep me");
    }

    #[test]
    fn unrelated_photos_with_same_stem_are_not_paired_after_export() {
        // A 里只有 JPG，B 里只有一个同名的 PNG（各自独立的照片）；目标里还已有一个 IMG_7.CR3
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let jpg = a.path().join("IMG_7.JPG");
        let png = b.path().join("IMG_7.png");
        fs::write(&jpg, make_jpeg(20, 20)).unwrap();
        image::RgbImage::new(4, 4).save(&png).unwrap();
        fs::write(out.path().join("IMG_7.CR3"), b"someone else's raw").unwrap();
        let r = run_export(&req(&[&jpg, &png], out.path(), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 2, "{:?}", r.failed);
        let mut names: Vec<_> = fs::read_dir(out.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        // 已有的 IMG_7.CR3 占了“IMG_7”这个组名 → JPG 改名为 IMG_7 (1)；PNG 又换一个组名，三者互不配对
        assert_eq!(names, vec!["IMG_7 (1).JPG", "IMG_7 (2).png", "IMG_7.CR3"]);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_sources_are_refused() {
        let a = tempfile::tempdir().unwrap();
        let out = tempfile::tempdir().unwrap();
        let real = a.path().join("real.jpg");
        fs::write(&real, make_jpeg(10, 10)).unwrap();
        let link = a.path().join("link.jpg");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let r = run_export(&req(&[&link], out.path(), ExportMode::Original), &AtomicBool::new(false), &|_| {}).unwrap();
        assert_eq!(r.exported, 0);
        assert_eq!(r.failed[0].error, "不是普通文件");
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
