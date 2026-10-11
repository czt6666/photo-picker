//! 星标存储。
//!
//! 首选：照片所在文件夹的 `.picasa.ini`（与 Picasa 3 兼容，文件夹走到哪星标跟到哪）。
//! 兜底：文件夹不可写（只读 U 盘、网络盘、无权限）时，写到 App 自己的数据目录，
//! 文件名是文件夹路径的哈希，格式同样是 picasa.ini。读取时两边取并集。

use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::Serialize;

use crate::picasa_ini::{norm_name, IniDoc};

pub const INI_NAME: &str = ".picasa.ini";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StarLocation {
    /// 写进了文件夹里的 .picasa.ini
    Folder,
    /// 文件夹不可写，存到了 App 数据目录
    Fallback,
}

pub struct StarStore {
    fallback_dir: PathBuf,
    /// 同一进程内串行化写操作，避免两次快速点击交错写坏文件
    write_lock: Mutex<()>,
}

impl StarStore {
    pub fn new(fallback_dir: PathBuf) -> Self {
        StarStore { fallback_dir, write_lock: Mutex::new(()) }
    }

    fn fallback_path(&self, folder: &Path) -> PathBuf {
        let h = blake3::hash(folder.to_string_lossy().as_bytes()).to_hex();
        self.fallback_dir.join(format!("{}.ini", &h[..20]))
    }

    /// 某文件夹下所有加星文件名（规范化后的，见 [`norm_name`]）。
    pub fn load(&self, folder: &Path) -> HashSet<String> {
        let mut set = HashSet::new();
        for p in [folder.join(INI_NAME), self.fallback_path(folder)] {
            if let Ok(text) = fs::read(&p) {
                set.extend(IniDoc::parse(&String::from_utf8_lossy(&text)).starred());
            }
        }
        set
    }

    /// 给同一文件夹里的一批文件设置星标。
    pub fn set(&self, folder: &Path, names: &[String], starred: bool) -> Result<StarLocation, String> {
        let _guard = self.write_lock.lock();
        let primary = folder.join(INI_NAME);
        let fallback = self.fallback_path(folder);

        let primary_result = edit_ini(&primary, names, starred, None);
        let location = match primary_result {
            Ok(()) => StarLocation::Folder,
            Err(e) => {
                log_warn(&format!("写 {} 失败（{e}），改存到 App 数据目录", primary.display()));
                fs::create_dir_all(&self.fallback_dir).map_err(|e| e.to_string())?;
                let header = format!("; 星标备份：文件夹不可写时由选片 App 保存\n; folder={}", folder.display());
                edit_ini(&fallback, names, starred, Some(&header)).map_err(|e| e.to_string())?;
                return Ok(StarLocation::Fallback);
            }
        };
        // 取消星标时，兜底文件里的旧记录也要清掉，否则读的时候并集又把它“救活”了
        if !starred && fallback.exists() {
            let _ = edit_ini(&fallback, names, false, None);
        }
        Ok(location)
    }
}

/// 读-改-写一个 ini 文件；没有变化就不写盘。写入用“临时文件 + 原子改名”，断电也不会写出半个文件。
fn edit_ini(path: &Path, names: &[String], starred: bool, header: Option<&str>) -> io::Result<()> {
    let mut doc = match fs::read(path) {
        Ok(b) => IniDoc::parse(&String::from_utf8_lossy(&b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if !starred {
                return Ok(());
            }
            IniDoc::parse(header.map(|h| format!("{h}\n")).as_deref().unwrap_or(""))
        }
        Err(e) => return Err(e),
    };
    if !doc.set_star_many(names, starred) {
        return Ok(());
    }
    let tmp = path.with_extension(format!("ini.tmp{}", std::process::id()));
    write_new(&tmp, doc.render().as_bytes())?;
    replace_file(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

/// 写一个新文件。Windows 上带“隐藏”属性：Windows 不会自动隐藏点开头的文件，
/// Picasa 写的 `.picasa.ini` 本来就是隐藏的，我们也照做，免得在资源管理器里多出一个文件。
/// （改名替换时目标文件的属性会被临时文件的属性取代，所以要在临时文件上就设好。）
fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        opts.attributes(FILE_ATTRIBUTE_HIDDEN);
    }
    opts.open(path)?.write_all(bytes)
}

/// 用 `from` 原子替换 `to`。
/// Windows 上目标文件被别的程序短暂打开（杀毒软件、索引服务、资源管理器预览）时改名会失败，
/// 稍等重试几次，而不是马上判定“文件夹不可写”、把星标存到兜底目录去。
fn replace_file(from: &Path, to: &Path) -> io::Result<()> {
    let attempts = if cfg!(windows) { 5 } else { 1 };
    let mut last = None;
    for i in 0..attempts {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == io::ErrorKind::PermissionDenied && i + 1 < attempts => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 << i));
            }
            Err(e) => return Err(e),
        }
    }
    Err(last.unwrap_or_else(|| io::Error::other("rename failed")))
}

fn log_warn(msg: &str) {
    eprintln!("[stars] {msg}");
}

/// 便捷函数：某文件名是否在星标集合里。
pub fn is_starred(set: &HashSet<String>, file_name: &str) -> bool {
    !set.is_empty() && set.contains(&norm_name(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn writes_picasa_ini_in_folder() {
        let photos = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = StarStore::new(app.path().join("stars"));

        let loc = store.set(photos.path(), &names(&["IMG_1.JPG", "IMG_2.JPG"]), true).unwrap();
        assert_eq!(loc, StarLocation::Folder);
        let text = fs::read_to_string(photos.path().join(INI_NAME)).unwrap();
        assert_eq!(text, "[IMG_1.JPG]\nstar=yes\n[IMG_2.JPG]\nstar=yes\n");

        let set = store.load(photos.path());
        assert!(is_starred(&set, "img_1.jpg"));
        assert!(is_starred(&set, "IMG_2.JPG"));

        store.set(photos.path(), &names(&["IMG_1.JPG"]), false).unwrap();
        let set = store.load(photos.path());
        assert!(!is_starred(&set, "IMG_1.JPG"));
        assert!(is_starred(&set, "IMG_2.JPG"));
    }

    #[cfg(windows)]
    #[test]
    fn picasa_ini_is_hidden_on_windows_like_picasa_does() {
        use std::os::windows::fs::MetadataExt;
        let photos = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = StarStore::new(app.path().join("stars"));
        let hidden = || fs::metadata(photos.path().join(INI_NAME)).unwrap().file_attributes() & 0x2 != 0;
        store.set(photos.path(), &names(&["a.jpg"]), true).unwrap();
        assert!(hidden());
        // 再改一次（替换已存在的隐藏文件）也要成功，且依然隐藏
        assert_eq!(store.set(photos.path(), &names(&["b.jpg"]), true).unwrap(), StarLocation::Folder);
        assert!(hidden());
        assert_eq!(store.load(photos.path()).len(), 2);
    }

    #[test]
    fn unstar_without_ini_does_not_create_file() {
        let photos = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = StarStore::new(app.path().join("stars"));
        store.set(photos.path(), &names(&["a.jpg"]), false).unwrap();
        assert!(!photos.path().join(INI_NAME).exists());
    }

    #[cfg(unix)]
    #[test]
    fn falls_back_when_folder_is_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let photos = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = StarStore::new(app.path().join("stars"));
        fs::set_permissions(photos.path(), fs::Permissions::from_mode(0o555)).unwrap();
        // root 用户无视权限位，此时测试无意义
        if fs::write(photos.path().join("probe"), b"x").is_ok() {
            let _ = fs::remove_file(photos.path().join("probe"));
            fs::set_permissions(photos.path(), fs::Permissions::from_mode(0o755)).unwrap();
            return;
        }
        let loc = store.set(photos.path(), &names(&["a.jpg"]), true).unwrap();
        assert_eq!(loc, StarLocation::Fallback);
        assert!(is_starred(&store.load(photos.path()), "a.jpg"));
        store.set(photos.path(), &names(&["a.jpg"]), false).unwrap();
        assert!(!is_starred(&store.load(photos.path()), "a.jpg"));
        fs::set_permissions(photos.path(), fs::Permissions::from_mode(0o755)).unwrap();
    }
}
