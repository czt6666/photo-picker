//! 数据都在一个 SQLite 文件里：相册、照片、谁选了哪张。
//!
//! 照片本身（缩略图、预览图）是磁盘上的 JPEG 文件，见 [`crate::store`]，这里只存它们的“户口”。
//! 量级很小（一个相册几千行），一把锁串行访问就够快了：单条查询是微秒级的。

use std::path::Path;

use parking_lot::Mutex;
use rand::Rng;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS albums (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  share_code  TEXT NOT NULL UNIQUE,
  admin_token TEXT NOT NULL UNIQUE,
  pick_limit  INTEGER,
  closed      INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id   TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  folder     TEXT NOT NULL,
  originals  TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  UNIQUE (album_id, key)
);
CREATE TABLE IF NOT EXISTS pickers (
  album_id   TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  submitted  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, name)
);
CREATE TABLE IF NOT EXISTS picks (
  album_id   TEXT NOT NULL,
  picker     TEXT NOT NULL,
  photo_id   INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  note       TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, picker, photo_id),
  FOREIGN KEY (album_id, picker) REFERENCES pickers(album_id, name) ON DELETE CASCADE
);
"#;

/// 共享码字母表：去掉了容易看错的 0/O、1/I。32 个字符 ^ 6 位 ≈ 10 亿种。
const CODE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";

pub fn random_string(alphabet: &[u8], len: usize) -> String {
    let mut rng = rand::rng();
    (0..len).map(|_| alphabet[rng.random_range(0..alphabet.len())] as char).collect()
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Serialize)]
pub struct Album {
    pub id: String,
    pub name: String,
    pub share_code: String,
    #[serde(skip)]
    pub admin_token: String,
    pub pick_limit: Option<u32>,
    pub closed: bool,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Photo {
    pub id: i64,
    /// 去重/续传用：文件夹 + 不带扩展名的文件名，小写。同名 RAW+JPG 是同一个 key。
    pub key: String,
    /// 用来做预览的那个文件名（如 DSC_0001.JPG）
    pub name: String,
    /// 摄影师电脑上的相对文件夹（如 "2024/婚纱"），根目录是 ""
    pub folder: String,
    /// 这一张对应的所有原图文件名（如 DSC_0001.JPG、DSC_0001.NEF）
    pub originals: Vec<String>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Pick {
    pub photo_id: i64,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Picker {
    pub name: String,
    pub submitted: bool,
    pub updated_at: i64,
    pub picks: Vec<Pick>,
}

pub struct NewPhoto {
    pub key: String,
    pub name: String,
    pub folder: String,
    pub originals: Vec<String>,
    pub width: u32,
    pub height: u32,
}

pub struct Db {
    conn: Mutex<Connection>,
}

fn album_row(r: &rusqlite::Row) -> rusqlite::Result<Album> {
    Ok(Album {
        id: r.get(0)?,
        name: r.get(1)?,
        share_code: r.get(2)?,
        admin_token: r.get(3)?,
        pick_limit: r.get(4)?,
        closed: r.get::<_, i64>(5)? != 0,
        created_at: r.get(6)?,
    })
}

const ALBUM_COLS: &str = "id, name, share_code, admin_token, pick_limit, closed, created_at";

fn photo_row(r: &rusqlite::Row) -> rusqlite::Result<Photo> {
    let originals: String = r.get(4)?;
    Ok(Photo {
        id: r.get(0)?,
        key: r.get(1)?,
        name: r.get(2)?,
        folder: r.get(3)?,
        originals: serde_json::from_str(&originals).unwrap_or_default(),
        width: r.get(5)?,
        height: r.get(6)?,
    })
}

const PHOTO_COLS: &str = "id, key, name, folder, originals, width, height";

type R<T> = Result<T, String>;

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

impl Db {
    pub fn open(path: &Path) -> R<Db> {
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch(SCHEMA).map_err(e)?;
        Ok(Db { conn: Mutex::new(conn) })
    }

    pub fn create_album(&self, name: &str, pick_limit: Option<u32>) -> R<Album> {
        let c = self.conn.lock();
        // 撞码的概率极低，但万一撞了就换一个再试
        for _ in 0..10 {
            let album = Album {
                id: random_string(ID_ALPHABET, 16),
                name: name.to_string(),
                share_code: random_string(CODE_ALPHABET, 6),
                admin_token: random_string(ID_ALPHABET, 24),
                pick_limit,
                closed: false,
                created_at: now(),
            };
            let res = c.execute(
                "INSERT INTO albums (id, name, share_code, admin_token, pick_limit, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![album.id, album.name, album.share_code, album.admin_token, album.pick_limit, album.created_at],
            );
            match res {
                Ok(_) => return Ok(album),
                Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => continue,
                Err(err) => return Err(e(err)),
            }
        }
        Err("生成共享码失败".into())
    }

    pub fn album_by_token(&self, token: &str) -> R<Option<Album>> {
        let c = self.conn.lock();
        c.query_row(&format!("SELECT {ALBUM_COLS} FROM albums WHERE admin_token = ?1"), [token], album_row)
            .optional()
            .map_err(e)
    }

    pub fn album_by_code(&self, code: &str) -> R<Option<Album>> {
        let c = self.conn.lock();
        c.query_row(
            &format!("SELECT {ALBUM_COLS} FROM albums WHERE share_code = ?1"),
            [code.trim().to_ascii_uppercase()],
            album_row,
        )
        .optional()
        .map_err(e)
    }

    pub fn update_album(&self, id: &str, name: Option<&str>, pick_limit: Option<Option<u32>>, closed: Option<bool>) -> R<()> {
        let c = self.conn.lock();
        if let Some(n) = name {
            c.execute("UPDATE albums SET name = ?1 WHERE id = ?2", params![n, id]).map_err(e)?;
        }
        if let Some(l) = pick_limit {
            c.execute("UPDATE albums SET pick_limit = ?1 WHERE id = ?2", params![l, id]).map_err(e)?;
        }
        if let Some(cl) = closed {
            c.execute("UPDATE albums SET closed = ?1 WHERE id = ?2", params![cl as i64, id]).map_err(e)?;
        }
        Ok(())
    }

    pub fn reset_code(&self, id: &str) -> R<String> {
        let c = self.conn.lock();
        for _ in 0..10 {
            let code = random_string(CODE_ALPHABET, 6);
            match c.execute("UPDATE albums SET share_code = ?1 WHERE id = ?2", params![code, id]) {
                Ok(_) => return Ok(code),
                Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => continue,
                Err(err) => return Err(e(err)),
            }
        }
        Err("生成共享码失败".into())
    }

    pub fn delete_album(&self, id: &str) -> R<()> {
        let c = self.conn.lock();
        c.execute("DELETE FROM albums WHERE id = ?1", [id]).map_err(e)?;
        Ok(())
    }

    pub fn photos(&self, album_id: &str) -> R<Vec<Photo>> {
        let c = self.conn.lock();
        let mut st = c
            .prepare(&format!("SELECT {PHOTO_COLS} FROM photos WHERE album_id = ?1 ORDER BY id"))
            .map_err(e)?;
        let rows = st.query_map([album_id], photo_row).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    pub fn photo_by_key(&self, album_id: &str, key: &str) -> R<Option<Photo>> {
        let c = self.conn.lock();
        c.query_row(
            &format!("SELECT {PHOTO_COLS} FROM photos WHERE album_id = ?1 AND key = ?2"),
            params![album_id, key],
            photo_row,
        )
        .optional()
        .map_err(e)
    }

    /// 插入一张照片，返回带 id 的完整记录。key 已存在时返回 Err(Ok(已有的那张))。
    pub fn insert_photo(&self, album_id: &str, p: NewPhoto) -> Result<Photo, R<Photo>> {
        let c = self.conn.lock();
        let originals = serde_json::to_string(&p.originals).unwrap_or_else(|_| "[]".into());
        let res = c.execute(
            "INSERT INTO photos (album_id, key, name, folder, originals, width, height) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![album_id, p.key, p.name, p.folder, originals, p.width, p.height],
        );
        match res {
            Ok(_) => Ok(Photo {
                id: c.last_insert_rowid(),
                key: p.key,
                name: p.name,
                folder: p.folder,
                originals: p.originals,
                width: p.width,
                height: p.height,
            }),
            Err(rusqlite::Error::SqliteFailure(f, _)) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
                drop(c);
                match self.photo_by_key(album_id, &p.key) {
                    Ok(Some(existing)) => Err(Ok(existing)),
                    Ok(None) => Err(Err("照片记录冲突".into())),
                    Err(err) => Err(Err(err)),
                }
            }
            Err(err) => Err(Err(e(err))),
        }
    }

    pub fn delete_photo(&self, album_id: &str, photo_id: i64) -> R<bool> {
        let c = self.conn.lock();
        let n = c
            .execute("DELETE FROM photos WHERE album_id = ?1 AND id = ?2", params![album_id, photo_id])
            .map_err(e)?;
        Ok(n > 0)
    }

    fn touch_picker(c: &Connection, album_id: &str, picker: &str) -> R<()> {
        c.execute(
            "INSERT INTO pickers (album_id, name, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT (album_id, name) DO UPDATE SET updated_at = excluded.updated_at",
            params![album_id, picker, now()],
        )
        .map_err(e)?;
        Ok(())
    }

    /// 某人在某相册的选片状态；第一次来就登记这个人（摄影师能看到谁进来过）。
    pub fn join(&self, album_id: &str, picker: &str) -> R<Picker> {
        {
            let c = self.conn.lock();
            Self::touch_picker(&c, album_id, picker)?;
        }
        self.picker(album_id, picker).map(|p| p.expect("刚登记过"))
    }

    fn picker(&self, album_id: &str, picker: &str) -> R<Option<Picker>> {
        Ok(self.pickers_where(album_id, Some(picker))?.into_iter().next())
    }

    pub fn pickers(&self, album_id: &str) -> R<Vec<Picker>> {
        self.pickers_where(album_id, None)
    }

    fn pickers_where(&self, album_id: &str, only: Option<&str>) -> R<Vec<Picker>> {
        let c = self.conn.lock();
        let mut st = c
            .prepare(
                "SELECT name, submitted, updated_at FROM pickers
                 WHERE album_id = ?1 AND (?2 IS NULL OR name = ?2) ORDER BY updated_at DESC",
            )
            .map_err(e)?;
        let mut pickers: Vec<Picker> = st
            .query_map(params![album_id, only], |r| {
                Ok(Picker {
                    name: r.get(0)?,
                    submitted: r.get::<_, i64>(1)? != 0,
                    updated_at: r.get(2)?,
                    picks: vec![],
                })
            })
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        let mut st = c
            .prepare("SELECT photo_id, note FROM picks WHERE album_id = ?1 AND picker = ?2 ORDER BY photo_id")
            .map_err(e)?;
        for p in &mut pickers {
            p.picks = st
                .query_map(params![album_id, p.name], |r| Ok(Pick { photo_id: r.get(0)?, note: r.get(1)? }))
                .map_err(e)?
                .collect::<Result<_, _>>()
                .map_err(e)?;
        }
        Ok(pickers)
    }

    /// 选上/取消一张。`note` 为 None 时不动已有备注。返回此人当前选了几张。
    pub fn set_pick(&self, album_id: &str, picker: &str, photo_id: i64, picked: bool, note: Option<&str>) -> R<usize> {
        let c = self.conn.lock();
        let exists: bool = c
            .query_row("SELECT 1 FROM photos WHERE album_id = ?1 AND id = ?2", params![album_id, photo_id], |_| Ok(()))
            .optional()
            .map_err(e)?
            .is_some();
        if !exists {
            return Err("照片不存在".into());
        }
        Self::touch_picker(&c, album_id, picker)?;
        // 提交后又改了，就回到“选片中”，摄影师那边能看出来
        c.execute("UPDATE pickers SET submitted = 0 WHERE album_id = ?1 AND name = ?2", params![album_id, picker])
            .map_err(e)?;
        if picked {
            c.execute(
                "INSERT INTO picks (album_id, picker, photo_id, note, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (album_id, picker, photo_id) DO UPDATE SET
                   note = CASE WHEN ?6 THEN excluded.note ELSE picks.note END,
                   updated_at = excluded.updated_at",
                params![album_id, picker, photo_id, note.unwrap_or(""), now(), note.is_some()],
            )
            .map_err(e)?;
        } else {
            c.execute(
                "DELETE FROM picks WHERE album_id = ?1 AND picker = ?2 AND photo_id = ?3",
                params![album_id, picker, photo_id],
            )
            .map_err(e)?;
        }
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM picks WHERE album_id = ?1 AND picker = ?2", params![album_id, picker], |r| r.get(0))
            .map_err(e)?;
        Ok(n as usize)
    }

    pub fn pick_count(&self, album_id: &str, picker: &str) -> R<usize> {
        let c = self.conn.lock();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM picks WHERE album_id = ?1 AND picker = ?2", params![album_id, picker], |r| r.get(0))
            .map_err(e)?;
        Ok(n as usize)
    }

    pub fn set_submitted(&self, album_id: &str, picker: &str, submitted: bool) -> R<()> {
        let c = self.conn.lock();
        Self::touch_picker(&c, album_id, picker)?;
        c.execute(
            "UPDATE pickers SET submitted = ?1 WHERE album_id = ?2 AND name = ?3",
            params![submitted as i64, album_id, picker],
        )
        .map_err(e)?;
        Ok(())
    }

    pub fn delete_picker(&self, album_id: &str, picker: &str) -> R<()> {
        let c = self.conn.lock();
        c.execute("DELETE FROM pickers WHERE album_id = ?1 AND name = ?2", params![album_id, picker]).map_err(e)?;
        Ok(())
    }
}
