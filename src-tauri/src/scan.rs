//! 扫描图库：找出工作目录下所有含照片的文件夹（相册），以及列出某个相册里的照片。
//!
//! **RAW+JPG 合并**（同 Lightroom）：相机设成 RAW+JPEG 时，同一张照片会有 `IMG_0001.CR3` 和
//! `IMG_0001.JPG` 两个文件。我们把同名（不含扩展名、忽略大小写）的文件归成一组：
//! JPG 作为“主文件”用来显示（JPG 解码快得多），RAW 和 .xmp 侧车文件作为“伴侣”跟着它走——
//! 网格里只出现一张，打星时两个文件一起打，导出时一起导出。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::formats::{is_companion, is_jpeg, is_supported_ext};
use crate::natural::natural_cmp;
use crate::picasa_ini::norm_name;
use crate::stars::{is_starred, StarStore};

#[derive(Debug, Clone, Serialize)]
pub struct Photo {
    pub path: String,
    pub name: String,
    pub dir: String,
    pub size: u64,
    /// 修改时间（毫秒）。前端拿它拼进缩略图 URL，文件一改 URL 就变，缓存自然失效。
    pub mtime: i64,
    pub starred: bool,
    /// 同名的 RAW / .xmp 文件名（与主文件在同一文件夹）。为空表示单独一个文件。
    pub companions: Vec<String>,
}

/// 一张“照片”：显示用的主文件 + 同名伴侣文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Group {
    pub primary: String,
    pub companions: Vec<String>,
}

fn split_ext(name: &str) -> (&str, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem, ext.to_ascii_lowercase()),
        _ => (name, String::new()),
    }
}

/// 把文件名拆成“组名”和后缀：`IMG_1.JPG` → (`IMG_1`, `.JPG`)，`IMG_1.CR3.xmp` → (`IMG_1`, `.CR3.xmp`)。
/// 导出改名时用：同一组的文件换成同一个新组名、保留各自后缀，就依然配对。
pub fn split_group_stem(name: &str) -> (&str, &str) {
    let (stem, ext) = split_ext(name);
    if ext.is_empty() {
        return (name, "");
    }
    // 侧车文件可能带着原文件的扩展名：IMG_1.CR3.xmp（Lightroom/C1）、IMG_1.JPG.xmp（darktable）
    let stem = if ext == "xmp" {
        match split_ext(stem) {
            (inner, e) if !e.is_empty() && (crate::formats::is_raw(&e) || is_supported_ext(&e)) => inner,
            _ => stem,
        }
    } else {
        stem
    };
    (stem, &name[stem.len()..])
}

/// 分组用的键：去掉扩展名、规范化大小写。`IMG_1.CR3.xmp` 这种“连 RAW 扩展名一起带上”的
/// 侧车文件命名也认作 `IMG_1`。
fn group_key(name: &str) -> String {
    norm_name(split_group_stem(name).0)
}

/// 把一个文件夹里的文件名分组成“照片”（结果按主文件名自然排序）。
///
/// 规则：同名的一组里有 JPG → JPG 是主文件，RAW/xmp 是伴侣；没有 JPG → 能解码的 RAW
/// 自己当主文件（只有 macOS 能解 RAW），孤零零的 xmp 忽略。同名的两个“可显示格式”
/// （比如 HEIC 和 JPG）各算各的，不合并。
pub fn group_names<I: IntoIterator<Item = String>>(names: I) -> Vec<Group> {
    let mut by_key: HashMap<String, Vec<String>> = HashMap::new();
    for n in names {
        if n.starts_with("._") {
            continue; // macOS 在非 APFS 盘上生成的资源分叉文件，不是真图片
        }
        let (_, ext) = split_ext(&n);
        if is_supported_ext(&ext) || is_companion(&ext) {
            by_key.entry(group_key(&n)).or_default().push(n);
        }
    }
    let mut groups = Vec::new();
    for (_, mut members) in by_key {
        members.sort_by(|a, b| natural_cmp(a, b));
        let ext_of = |n: &str| split_ext(n).1;
        // 主文件候选：JPG 优先；否则是能显示的非伴侣格式（HEIC、TIFF…）；最后才是能解码的 RAW
        let jpg = members.iter().position(|n| is_jpeg(&ext_of(n)));
        let primary_idx = jpg
            .or_else(|| members.iter().position(|n| is_supported_ext(&ext_of(n)) && !is_companion(&ext_of(n))))
            .or_else(|| members.iter().position(|n| is_supported_ext(&ext_of(n))));
        let Some(pi) = primary_idx else { continue };
        let primary = members[pi].clone();
        let mut companions = Vec::new();
        for (i, n) in members.iter().enumerate() {
            if i == pi {
                continue;
            }
            let e = ext_of(n);
            if is_companion(&e) {
                companions.push(n.clone());
            } else if is_supported_ext(&e) {
                // 同名但也是可显示格式（另一张 JPG、HEIC、PNG…）：单独成一张
                groups.push(Group { primary: n.clone(), companions: Vec::new() });
            }
        }
        groups.push(Group { primary, companions });
    }
    groups.sort_by(|a, b| natural_cmp(&a.primary, &b.primary));
    groups
}

impl Group {
    pub fn is_starred(&self, set: &std::collections::HashSet<String>) -> bool {
        is_starred(set, &self.primary) || self.companions.iter().any(|c| is_starred(set, c))
    }
}

/// 文件夹里的普通文件名（不含符号链接、子文件夹）。
/// 符号链接一律不算：否则一个名叫 IMG_1.CR3、指向别处的链接会被当成 RAW 跟着导出。
fn regular_file_names(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect()
}

/// 一个文件夹里“主文件名 → 伴侣文件名”的表。只读一次目录：批量打星、导出几千张时，
/// 每张都去重新读一遍目录会变成 O(张数 × 文件夹大小)，几千张要几十秒。
pub fn companion_map(dir: &Path) -> HashMap<String, Vec<String>> {
    group_names(regular_file_names(dir)).into_iter().map(|g| (g.primary, g.companions)).collect()
}

/// 某个主文件的同名伴侣文件（文件名）。测试用；正式代码一律批量用 [`companion_map`]。
#[cfg(test)]
pub fn companions_of(path: &Path) -> Vec<String> {
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else { return Vec::new() };
    companion_map(dir).remove(name.to_string_lossy().as_ref()).unwrap_or_default()
}

/// 文件夹里的照片数和加星照片数（按组计，RAW+JPG 算一张）。
pub fn folder_counts(dir: &Path, stars: &StarStore) -> (usize, usize) {
    let groups = group_names(regular_file_names(dir));
    let set = stars.load(dir);
    let starred = if set.is_empty() { 0 } else { groups.iter().filter(|g| g.is_starred(&set)).count() };
    (groups.len(), starred)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Folder {
    pub path: String,
    /// 文件夹名
    pub name: String,
    /// 相对根目录的路径，侧栏按它排序、显示层级
    pub rel: String,
    pub root: String,
    pub count: usize,
    pub starred: usize,
}

/// 扫描时跳过的目录：隐藏目录、系统/应用包、照片库包（Photos/Lightroom 自己管理，别去碰）。
fn skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    const SKIP_NAMES: &[&str] = &["node_modules", "$RECYCLE.BIN", "System Volume Information"];
    const SKIP_SUFFIX: &[&str] = &[
        ".photoslibrary", ".photolibrary", ".aplibrary", ".lrdata", ".app", ".bundle", ".framework",
    ];
    SKIP_NAMES.contains(&name) || SKIP_SUFFIX.iter().any(|s| name.ends_with(s))
}

pub fn mtime_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// 递归扫描一个根目录，返回所有直接包含照片的文件夹。
pub fn scan_root(root: &Path, stars: &StarStore) -> Vec<Folder> {
    let home = dirs_home();
    let mut found: HashMap<PathBuf, Vec<String>> = HashMap::new();
    // same_file_system：不跨到别的磁盘/挂载点（例如 macOS 的 /System/Volumes/Data、/Volumes 下的移动硬盘）
    let walker = WalkDir::new(root).follow_links(false).same_file_system(true).max_depth(32).into_iter().filter_entry(|e| {
        if e.depth() == 0 || !e.file_type().is_dir() {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        // 把整个用户目录加进来时，别去扫 ~/Library（里面成千上万的缓存小图）
        if name == "Library" && home.as_deref() == e.path().parent() {
            return false;
        }
        !skip_dir(&name)
    });
    for entry in walker.flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let (_, ext) = split_ext(&name);
        if is_supported_ext(&ext) || is_companion(&ext) {
            if let Some(parent) = entry.path().parent() {
                found.entry(parent.to_path_buf()).or_default().push(name);
            }
        }
    }

    let root_name = root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
    let mut folders: Vec<Folder> = found
        .into_iter()
        .filter_map(|(dir, files)| {
            let groups = group_names(files);
            if groups.is_empty() {
                return None; // 只有 Linux 上解不了的 RAW、或只有 xmp
            }
            let starred_set = stars.load(&dir);
            let starred = if starred_set.is_empty() { 0 } else { groups.iter().filter(|g| g.is_starred(&starred_set)).count() };
            let rel = dir.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            Some(Folder {
                name: if rel.is_empty() { root_name.clone() } else { dir.file_name().unwrap_or_default().to_string_lossy().into_owned() },
                path: dir.to_string_lossy().into_owned(),
                rel,
                root: root.to_string_lossy().into_owned(),
                count: groups.len(),
                starred,
            })
        })
        .collect();
    folders.sort_by(|a, b| natural_cmp(&a.rel, &b.rel));
    folders
}

/// 列出一个文件夹（不递归）里的照片，按主文件名自然排序；RAW+JPG 合并成一张。
pub fn list_folder(dir: &Path, stars: &StarStore) -> std::io::Result<Vec<Photo>> {
    let starred_set = stars.load(dir);
    let dir_s = dir.to_string_lossy().into_owned();
    let mut metas: HashMap<String, fs::Metadata> = HashMap::new();
    for e in fs::read_dir(dir)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let (_, ext) = split_ext(&name);
        // 只给图片类文件取 stat，文件夹里的其它文件（视频、文档）不花这个钱
        if !is_supported_ext(&ext) && !is_companion(&ext) {
            continue;
        }
        if let Ok(meta) = e.metadata() {
            if meta.is_file() {
                metas.insert(name, meta);
            }
        }
    }
    let photos = group_names(metas.keys().cloned())
        .into_iter()
        .filter_map(|g| {
            let meta = metas.get(&g.primary)?;
            Some(Photo {
                starred: g.is_starred(&starred_set),
                path: dir.join(&g.primary).to_string_lossy().into_owned(),
                dir: dir_s.clone(),
                size: meta.len(),
                mtime: mtime_ms(meta),
                name: g.primary,
                companions: g.companions,
            })
        })
        .collect();
    Ok(photos)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, b"x").unwrap();
    }

    #[test]
    fn scans_nested_folders_and_skips_hidden_and_packages() {
        let root = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let stars = StarStore::new(app.path().to_path_buf());
        let r = root.path();
        touch(&r.join("top.jpg"));
        touch(&r.join("2024/旅行/IMG_10.JPG"));
        touch(&r.join("2024/旅行/IMG_2.JPG"));
        touch(&r.join("2024/旅行/notes.txt"));
        touch(&r.join("2024/旅行/._IMG_2.JPG"));
        touch(&r.join(".hidden/a.jpg"));
        touch(&r.join("Photos Library.photoslibrary/originals/a.jpg"));
        touch(&r.join("empty/readme.md"));
        stars.set(&r.join("2024/旅行"), &["IMG_2.JPG".into()], true).unwrap();

        let folders = scan_root(r, &stars);
        let rels: Vec<_> = folders.iter().map(|f| f.rel.as_str()).collect();
        assert_eq!(rels, vec!["", "2024/旅行"]);
        assert_eq!(folders[1].count, 2);
        assert_eq!(folders[1].starred, 1);
        assert_eq!(folders[1].name, "旅行");

        let photos = list_folder(&r.join("2024/旅行"), &stars).unwrap();
        let names: Vec<_> = photos.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["IMG_2.JPG", "IMG_10.JPG"]);
        assert!(photos[0].starred && !photos[1].starred);
    }

    fn g(primary: &str, companions: &[&str]) -> Group {
        Group { primary: primary.into(), companions: companions.iter().map(|s| s.to_string()).collect() }
    }

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn groups_raw_and_xmp_under_same_named_jpg() {
        let got = group_names(names(&[
            "IMG_0002.JPG", "IMG_0001.CR3", "IMG_0001.JPG", "img_0001.xmp", "IMG_0002.CR3.xmp", "IMG_0002.cr3",
            "IMG_0003.JPG", "notes.txt", "._IMG_0003.JPG",
        ]));
        assert_eq!(
            got,
            vec![
                g("IMG_0001.JPG", &["IMG_0001.CR3", "img_0001.xmp"]),
                g("IMG_0002.JPG", &["IMG_0002.cr3", "IMG_0002.CR3.xmp"]),
                g("IMG_0003.JPG", &[]),
            ]
        );
    }

    #[test]
    fn raw_without_jpg_depends_on_platform_and_lone_xmp_is_ignored() {
        let got = group_names(names(&["DSC_1.NEF", "DSC_1.xmp", "lonely.xmp"]));
        if cfg!(target_os = "macos") {
            assert_eq!(got, vec![g("DSC_1.NEF", &["DSC_1.xmp"])], "macOS 能解 RAW，RAW 自己当主文件");
        } else {
            assert!(got.is_empty(), "其它平台解不了 RAW，又没有 JPG 可显示：{got:?}");
        }
    }

    #[test]
    fn split_group_stem_keeps_original_case_suffix() {
        assert_eq!(split_group_stem("IMG_1.JPG"), ("IMG_1", ".JPG"));
        assert_eq!(split_group_stem("IMG_1.CR3.xmp"), ("IMG_1", ".CR3.xmp"));
        assert_eq!(split_group_stem("a.b.jpg"), ("a.b", ".jpg"));
        assert_eq!(split_group_stem("noext"), ("noext", ""));
        assert_eq!(split_group_stem(".hidden"), (".hidden", ""));
    }

    #[test]
    fn displayable_format_beats_raw_when_there_is_no_jpg() {
        // TIFF 各平台都能显示，应当是主文件，NEF 跟着它（macOS 上以前会让 NEF 当主文件、两张分开显示）
        assert_eq!(group_names(names(&["a.NEF", "a.tif"])), vec![g("a.tif", &["a.NEF"])]);
        if cfg!(target_os = "macos") {
            assert_eq!(group_names(names(&["DSC_1.ARW", "DSC_1.HEIF"])), vec![g("DSC_1.HEIF", &["DSC_1.ARW"])]);
        }
    }

    #[test]
    fn darktable_style_jpg_sidecar_joins_the_group() {
        let got = group_names(names(&["IMG_1.JPG", "IMG_1.JPG.xmp", "IMG_1.CR3"]));
        assert_eq!(got, vec![g("IMG_1.JPG", &["IMG_1.CR3", "IMG_1.JPG.xmp"])]);
        assert_eq!(split_group_stem("IMG_1.JPG.xmp"), ("IMG_1", ".JPG.xmp"));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_never_companions() {
        let root = tempfile::tempdir().unwrap();
        let d = root.path();
        touch(&d.join("IMG_1.JPG"));
        touch(&d.join("secret.txt"));
        std::os::unix::fs::symlink(d.join("secret.txt"), d.join("IMG_1.CR3")).unwrap();
        assert!(companions_of(&d.join("IMG_1.JPG")).is_empty());
        assert_eq!(companion_map(d).get("IMG_1.JPG"), Some(&Vec::new()));
    }

    #[test]
    fn same_named_displayable_formats_stay_separate() {
        let got = group_names(names(&["a.jpg", "a.png", "a.CR2"]));
        assert_eq!(got, vec![g("a.jpg", &["a.CR2"]), g("a.png", &[])]);
    }

    #[test]
    fn counts_stars_and_companions_from_disk() {
        let root = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let stars = StarStore::new(app.path().to_path_buf());
        let d = root.path();
        for n in ["IMG_1.JPG", "IMG_1.CR3", "IMG_2.JPG", "IMG_2.CR3", "IMG_3.JPG", "IMG_9.CR3"] {
            touch(&d.join(n));
        }
        // 在 Picasa 里只给 RAW 打过星，也算这张照片加了星
        stars.set(d, &["IMG_2.CR3".into()], true).unwrap();
        let photos = list_folder(d, &stars).unwrap();
        let summary: Vec<_> = photos.iter().map(|p| (p.name.as_str(), p.companions.len(), p.starred)).collect();
        let mut want = vec![("IMG_1.JPG", 1, false), ("IMG_2.JPG", 1, true), ("IMG_3.JPG", 0, false)];
        if cfg!(target_os = "macos") {
            want.push(("IMG_9.CR3", 0, false));
        }
        assert_eq!(summary, want);
        assert_eq!(folder_counts(d, &stars), (want.len(), 1));
        assert_eq!(companions_of(&d.join("IMG_1.JPG")), vec!["IMG_1.CR3"]);
        assert!(companions_of(&d.join("IMG_3.JPG")).is_empty());
        let folders = scan_root(d, &stars);
        assert_eq!((folders[0].count, folders[0].starred), (want.len(), 1));
    }
}
