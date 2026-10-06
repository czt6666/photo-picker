//! 扫描图库：找出根目录下所有含照片的文件夹，以及列出某个文件夹里的照片。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::formats::is_supported;
use crate::natural::natural_cmp;
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    let walker = WalkDir::new(root).follow_links(false).max_depth(32).into_iter().filter_entry(|e| {
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
        if entry.file_type().is_file() && is_supported(entry.path()) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with("._") {
                continue; // macOS 在非 APFS 盘上生成的资源分叉文件，不是真图片
            }
            if let Some(parent) = entry.path().parent() {
                found.entry(parent.to_path_buf()).or_default().push(name);
            }
        }
    }

    let root_name = root.file_name().map_or_else(|| root.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
    let mut folders: Vec<Folder> = found
        .into_iter()
        .map(|(dir, files)| {
            let starred_set = stars.load(&dir);
            let starred = files.iter().filter(|f| is_starred(&starred_set, f)).count();
            let rel = dir.strip_prefix(root).map(|r| r.to_string_lossy().into_owned()).unwrap_or_default();
            Folder {
                name: if rel.is_empty() { root_name.clone() } else { dir.file_name().unwrap_or_default().to_string_lossy().into_owned() },
                path: dir.to_string_lossy().into_owned(),
                rel,
                root: root.to_string_lossy().into_owned(),
                count: files.len(),
                starred,
            }
        })
        .collect();
    folders.sort_by(|a, b| natural_cmp(&a.rel, &b.rel));
    folders
}

/// 列出一个文件夹（不递归）里的照片，按文件名自然排序。
pub fn list_folder(dir: &Path, stars: &StarStore) -> std::io::Result<Vec<Photo>> {
    let starred_set = stars.load(dir);
    let dir_s = dir.to_string_lossy().into_owned();
    let mut photos: Vec<Photo> = fs::read_dir(dir)?
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with("._") || !is_supported(&path) {
                return None;
            }
            let meta = e.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(Photo {
                starred: is_starred(&starred_set, &name),
                path: path.to_string_lossy().into_owned(),
                name,
                dir: dir_s.clone(),
                size: meta.len(),
                mtime: mtime_ms(&meta),
            })
        })
        .collect();
    photos.sort_by(|a, b| natural_cmp(&a.name, &b.name));
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
}
