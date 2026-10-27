//! 星标存储。
//!
//! 首选：照片所在文件夹的 `.picasa.ini`（与 Picasa 3 兼容，文件夹走到哪星标跟到哪）。
//! 兜底：文件夹不可写（只读 U 盘、网络盘、无权限）时，写到 App 自己的数据目录，
//! 文件名是文件夹路径的哈希，格式同样是 picasa.ini。读取时两边取并集。

use std::collections::{HashMap, HashSet};
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

/// 一次写入改什么：星标（Lightroom 的“选取”）和星级（1～5 星）是两回事，各改各的。
#[derive(Debug, Clone, Copy)]
enum Edit {
    Star(bool),
    /// 0 = 清除
    Rating(u8),
}

impl Edit {
    fn clears(self) -> bool {
        matches!(self, Edit::Star(false) | Edit::Rating(0))
    }

    fn cleared(self) -> Edit {
        match self {
            Edit::Star(_) => Edit::Star(false),
            Edit::Rating(_) => Edit::Rating(0),
        }
    }

    fn apply(self, doc: &mut IniDoc, names: &[String]) -> bool {
        match self {
            Edit::Star(on) => doc.set_star_many(names, on),
            Edit::Rating(r) => doc.set_rating_many(names, r),
        }
    }
}

/// 一个文件夹里的标记：加星的文件名，和文件名 → 星级（都是规范化后的名字，见 [`norm_name`]）。
#[derive(Debug, Default)]
pub struct Marks {
    pub starred: HashSet<String>,
    pub ratings: HashMap<String, u8>,
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
        self.load_marks(folder).starred
    }

    /// 某文件夹下的星标和星级。
    pub fn load_marks(&self, folder: &Path) -> Marks {
        let mut marks = Marks::default();
        for p in [folder.join(INI_NAME), self.fallback_path(folder)] {
            if let Ok(text) = fs::read(&p) {
                let doc = IniDoc::parse(&String::from_utf8_lossy(&text));
                marks.starred.extend(doc.starred());
                for (name, r) in doc.ratings() {
                    let e = marks.ratings.entry(name).or_insert(0);
                    *e = (*e).max(r);
                }
            }
        }
        marks
    }

    /// 给同一文件夹里的一批文件设置星标。
    pub fn set(&self, folder: &Path, names: &[String], starred: bool) -> Result<StarLocation, String> {
        self.write(folder, names, Edit::Star(starred))
    }

    /// 给同一文件夹里的一批文件设置星级：0 = 清除，1～5 = 星级。不动星标。
    pub fn set_rating(&self, folder: &Path, names: &[String], rating: u8) -> Result<StarLocation, String> {
        self.write(folder, names, Edit::Rating(rating))
    }

    /// 导出 / 移动之后，把星标和星级带到新文件上。`pairs` 是 (源文件, 目标文件)，目标可能改过名（`IMG_1 (1).JPG`）。
    /// `moved` = 源文件已经不在原处了：原文件夹里的记录顺手清掉，免得以后同名的新照片“继承”了它。
    /// 返回带星级的目标文件和星级（调用方再写进照片的 XMP）。
    pub fn carry_marks(&self, pairs: &[(PathBuf, PathBuf)], moved: bool) -> Vec<(PathBuf, u8)> {
        let mut marks: HashMap<PathBuf, Marks> = HashMap::new();
        let mut star_to: HashMap<PathBuf, Vec<String>> = HashMap::new();
        let mut rate_to: HashMap<(PathBuf, u8), Vec<String>> = HashMap::new();
        let mut clear_from: HashMap<PathBuf, Vec<String>> = HashMap::new();
        let mut rated = Vec::new();
        for (src, dst) in pairs {
            let (Some(sdir), Some(sname), Some(ddir), Some(dname)) = (src.parent(), src.file_name(), dst.parent(), dst.file_name()) else {
                continue;
            };
            let m = marks.entry(sdir.to_path_buf()).or_insert_with(|| self.load_marks(sdir));
            let sname = sname.to_string_lossy();
            let dname = dname.to_string_lossy().into_owned();
            let starred = is_starred(&m.starred, &sname);
            let rating = rating_of(&m.ratings, &sname);
            if starred {
                star_to.entry(ddir.to_path_buf()).or_default().push(dname.clone());
            }
            if rating > 0 {
                rate_to.entry((ddir.to_path_buf(), rating)).or_default().push(dname);
                rated.push((dst.clone(), rating));
            }
            if moved && (starred || rating > 0) {
                clear_from.entry(sdir.to_path_buf()).or_default().push(sname.into_owned());
            }
        }
        let warn = |r: Result<StarLocation, String>| {
            if let Err(e) = r {
                log_warn(&format!("带星标到新文件夹失败：{e}"));
            }
        };
        for (dir, names) in &star_to {
            warn(self.set(dir, names, true));
        }
        for ((dir, r), names) in &rate_to {
            warn(self.set_rating(dir, names, *r));
        }
        for (dir, names) in &clear_from {
            warn(self.set(dir, names, false));
            warn(self.set_rating(dir, names, 0));
        }
        rated
    }

    fn write(&self, folder: &Path, names: &[String], edit: Edit) -> Result<StarLocation, String> {
        let _guard = self.write_lock.lock();
        let primary = folder.join(INI_NAME);
        let fallback = self.fallback_path(folder);

        let primary_result = edit_ini(&primary, names, edit, None);
        let location = match primary_result {
            Ok(()) => StarLocation::Folder,
            Err(e) => {
                log_warn(&format!("写 {} 失败（{e}），改存到 App 数据目录", primary.display()));
                fs::create_dir_all(&self.fallback_dir).map_err(|e| e.to_string())?;
                let header = format!("; 星标备份：文件夹不可写时由选片 App 保存\n; folder={}", folder.display());
                edit_ini(&fallback, names, edit, Some(&header)).map_err(|e| e.to_string())?;
                return Ok(StarLocation::Fallback);
            }
        };
        // 取消星标时，兜底文件里的旧记录也要清掉，否则读的时候并集又把它“救活”了
        // 星级同理：读的时候两边取最高的，兜底文件里留着旧的更高星级就降不下来了，所以每次都清
        if (edit.clears() || matches!(edit, Edit::Rating(_))) && fallback.exists() {
            let _ = edit_ini(&fallback, names, edit.cleared(), None);
        }
        Ok(location)
    }
}

/// 读-改-写一个 ini 文件；没有变化就不写盘。写入用“临时文件 + 原子改名”，断电也不会写出半个文件。
fn edit_ini(path: &Path, names: &[String], edit: Edit, header: Option<&str>) -> io::Result<()> {
    let mut doc = match fs::read(path) {
        Ok(b) => IniDoc::parse(&String::from_utf8_lossy(&b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if edit.clears() {
                return Ok(());
            }
            IniDoc::parse(header.map(|h| format!("{h}\n")).as_deref().unwrap_or(""))
        }
        Err(e) => return Err(e),
    };
    if !edit.apply(&mut doc, names) {
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

/// 便捷函数：某文件名的星级（没有是 0）。
pub fn rating_of(map: &HashMap<String, u8>, file_name: &str) -> u8 {
    if map.is_empty() {
        return 0;
    }
    map.get(&norm_name(file_name)).copied().unwrap_or(0)
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
    fn rating_and_star_are_stored_separately() {
        let photos = tempfile::tempdir().unwrap();
        let app = tempfile::tempdir().unwrap();
        let store = StarStore::new(app.path().join("stars"));
        store.set_rating(photos.path(), &names(&["a.jpg", "b.jpg"]), 5).unwrap();
        store.set_rating(photos.path(), &names(&["b.jpg"]), 2).unwrap();
        store.set(photos.path(), &names(&["c.jpg"]), true).unwrap();
        let m = store.load_marks(photos.path());
        assert_eq!((rating_of(&m.ratings, "A.JPG"), rating_of(&m.ratings, "b.jpg"), rating_of(&m.ratings, "c.jpg")), (5, 2, 0));
        // 标了星级不等于加了星标
        assert!(!is_starred(&m.starred, "a.jpg") && is_starred(&m.starred, "c.jpg"));
        assert_eq!(fs::read_to_string(photos.path().join(INI_NAME)).unwrap(), "[a.jpg]\nrating=5\n[b.jpg]\nrating=2\n[c.jpg]\nstar=yes\n");
        // 加 / 取消星标不动星级
        store.set(photos.path(), &names(&["a.jpg"]), true).unwrap();
        store.set(photos.path(), &names(&["a.jpg"]), false).unwrap();
        assert_eq!(rating_of(&store.load_marks(photos.path()).ratings, "a.jpg"), 5);
        store.set_rating(photos.path(), &names(&["a.jpg"]), 0).unwrap();
        assert_eq!(rating_of(&store.load_marks(photos.path()).ratings, "a.jpg"), 0);
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

    #[test]
    fn carry_marks_follows_moved_and_renamed_files() {
        let root = tempfile::tempdir().unwrap();
        let (a, b) = (root.path().join("a"), root.path().join("a/精选"));
        fs::create_dir_all(&b).unwrap();
        let store = StarStore::new(root.path().join("fallback"));
        store.set(&a, &names(&["IMG_1.JPG", "IMG_1.NEF"]), true).unwrap();
        store.set_rating(&a, &names(&["IMG_1.JPG", "IMG_1.NEF", "IMG_2.JPG"]), 4).unwrap();
        store.set_rating(&a, &names(&["IMG_3.JPG"]), 2).unwrap();
        let pairs = vec![
            (a.join("IMG_1.JPG"), b.join("IMG_1.JPG")),
            (a.join("IMG_1.NEF"), b.join("IMG_1.NEF")),
            (a.join("IMG_2.JPG"), b.join("IMG_2 (1).JPG")),
            (a.join("IMG_9.JPG"), b.join("IMG_9.JPG")),
        ];
        let rated = store.carry_marks(&pairs, true);
        assert_eq!(rated.len(), 3);
        let m = store.load_marks(&b);
        assert!(is_starred(&m.starred, "IMG_1.JPG") && is_starred(&m.starred, "img_1.nef"));
        assert_eq!(rating_of(&m.ratings, "IMG_2 (1).JPG"), 4, "改了名也跟着走");
        assert!(!is_starred(&m.starred, "IMG_9.JPG") && rating_of(&m.ratings, "IMG_9.JPG") == 0);
        let old = store.load_marks(&a);
        assert!(old.starred.is_empty(), "移走的从原文件夹清掉");
        assert_eq!(rating_of(&old.ratings, "IMG_1.JPG"), 0);
        assert_eq!(rating_of(&old.ratings, "IMG_3.JPG"), 2, "没移的不动");
        // 复制：原文件夹保留
        let c = root.path().join("c");
        fs::create_dir_all(&c).unwrap();
        store.carry_marks(&[(a.join("IMG_3.JPG"), c.join("IMG_3.JPG"))], false);
        assert_eq!(rating_of(&store.load_marks(&c).ratings, "IMG_3.JPG"), 2);
        assert_eq!(rating_of(&store.load_marks(&a).ratings, "IMG_3.JPG"), 2);
    }
}
