//! 远程相册的数据都在一个 SQLite 文件里：相册、照片、星标、留言。
//!
//! 照片本身（缩略图、预览图）是磁盘上的 JPEG 文件，这里只存它们的“户口”。
//! 量级很小（一个相册几千行），一把锁串行访问就够快：单条查询是微秒级的。
//!
//! 星标是**大家共用的一份**：任何拿到链接的人都能加星/取消，记下最后是谁加的，
//! 这样摄影师和模特看到的是同一份挑选结果。

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
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  owner_token TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS photos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id   TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  name       TEXT NOT NULL,
  folder     TEXT NOT NULL,
  companions TEXT NOT NULL,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  size       INTEGER NOT NULL,
  UNIQUE (album_id, key)
);
CREATE TABLE IF NOT EXISTS stars (
  photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  by       TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  name     TEXT NOT NULL DEFAULT '',
  text     TEXT NOT NULL,
  token    TEXT NOT NULL,
  at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_photo ON comments(photo_id);
"#;

/// 相册码字母表：去掉了容易看错的 0/O、1/I。16 位 = 80 比特，靠复制链接、不靠记，猜是猜不到的。
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
    /// 内部 id：图片目录名（/img/<id>/…），不对外当口令用
    pub id: String,
    /// 16 位相册码，链接 /r/<code> 里的那个
    pub code: String,
    pub name: String,
    #[serde(skip)]
    pub owner_token: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct Photo {
    pub id: i64,
    /// 用来做预览的那个文件名（如 DSC_0001.JPG）
    pub name: String,
    /// 摄影师电脑上的相对文件夹（如 "2024/婚纱"），根目录是 ""
    pub folder: String,
    /// 同名的 RAW 等伴侣文件（如 DSC_0001.NEF）
    pub companions: Vec<String>,
    pub width: u32,
    pub height: u32,
    /// 原图大小（字节），只用来显示
    pub size: u64,
    pub starred: bool,
    /// 最后是谁加的星
    pub starred_by: Option<String>,
}

/// 一条留言：挂在某张照片下面，拿到链接的人都能留。名字是留言的人自己填的（不填前端随机起一个），不做校验
#[derive(Debug, Clone, Serialize)]
pub struct Comment {
    pub id: i64,
    pub photo_id: i64,
    pub name: String,
    pub text: String,
    pub at: i64,
}

pub struct NewPhoto {
    /// 去重/续传用：文件夹 + 不带扩展名的文件名，小写
    pub key: String,
    pub name: String,
    pub folder: String,
    pub companions: Vec<String>,
    pub width: u32,
    pub height: u32,
    pub size: u64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

type R<T> = Result<T, String>;

fn e(err: rusqlite::Error) -> String {
    err.to_string()
}

fn is_conflict(err: &rusqlite::Error) -> bool {
    matches!(err, rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation)
}

const ALBUM_COLS: &str = "id, code, name, owner_token, created_at";

fn album_row(r: &rusqlite::Row) -> rusqlite::Result<Album> {
    Ok(Album { id: r.get(0)?, code: r.get(1)?, name: r.get(2)?, owner_token: r.get(3)?, created_at: r.get(4)? })
}

const PHOTO_SELECT: &str = "SELECT p.id, p.name, p.folder, p.companions, p.width, p.height, p.size, s.by
     FROM photos p LEFT JOIN stars s ON s.photo_id = p.id";

fn photo_row(r: &rusqlite::Row) -> rusqlite::Result<Photo> {
    let companions: String = r.get(3)?;
    let by: Option<String> = r.get(7)?;
    Ok(Photo {
        id: r.get(0)?,
        name: r.get(1)?,
        folder: r.get(2)?,
        companions: serde_json::from_str(&companions).unwrap_or_default(),
        width: r.get(4)?,
        height: r.get(5)?,
        size: r.get::<_, i64>(6)? as u64,
        starred: by.is_some(),
        starred_by: by,
    })
}

impl Db {
    pub fn open(path: &Path) -> R<Db> {
        let conn = Connection::open(path).map_err(e)?;
        conn.execute_batch(SCHEMA).map_err(e)?;
        // v0.4.0 的留言表没有 name 列，老库补上
        let has_name: bool = conn
            .query_row("SELECT COUNT(*) FROM pragma_table_info('comments') WHERE name = 'name'", [], |r| r.get::<_, i64>(0))
            .map_err(e)?
            > 0;
        if !has_name {
            conn.execute_batch("ALTER TABLE comments ADD COLUMN name TEXT NOT NULL DEFAULT ''").map_err(e)?;
        }
        Ok(Db { conn: Mutex::new(conn) })
    }

    pub fn create_album(&self, name: &str) -> R<Album> {
        let c = self.conn.lock();
        // 撞码的概率极低，万一撞了就换一个再试
        for _ in 0..10 {
            let album = Album {
                id: random_string(ID_ALPHABET, 16),
                code: random_string(CODE_ALPHABET, 16),
                name: name.to_string(),
                owner_token: random_string(ID_ALPHABET, 24),
                created_at: now(),
            };
            match c.execute(
                "INSERT INTO albums (id, code, name, owner_token, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![album.id, album.code, album.name, album.owner_token, album.created_at],
            ) {
                Ok(_) => return Ok(album),
                Err(err) if is_conflict(&err) => continue,
                Err(err) => return Err(e(err)),
            }
        }
        Err("生成相册码失败".into())
    }

    pub fn album_by_code(&self, code: &str) -> R<Option<Album>> {
        let c = self.conn.lock();
        c.query_row(&format!("SELECT {ALBUM_COLS} FROM albums WHERE code = ?1"), [code.trim().to_ascii_uppercase()], album_row)
            .optional()
            .map_err(e)
    }

    pub fn rename_album(&self, id: &str, name: &str) -> R<()> {
        self.conn.lock().execute("UPDATE albums SET name = ?1 WHERE id = ?2", params![name, id]).map_err(e)?;
        Ok(())
    }

    pub fn delete_album(&self, id: &str) -> R<()> {
        self.conn.lock().execute("DELETE FROM albums WHERE id = ?1", [id]).map_err(e)?;
        Ok(())
    }

    pub fn photos(&self, album_id: &str) -> R<Vec<Photo>> {
        let c = self.conn.lock();
        let mut st = c.prepare(&format!("{PHOTO_SELECT} WHERE p.album_id = ?1 ORDER BY p.folder, p.name, p.id")).map_err(e)?;
        let rows = st.query_map([album_id], photo_row).map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    fn photo_by(&self, c: &Connection, cond: &str, p: impl rusqlite::Params) -> R<Option<Photo>> {
        c.query_row(&format!("{PHOTO_SELECT} WHERE {cond}"), p, photo_row).optional().map_err(e)
    }

    /// 插入一张照片。同一个 key 已经有了就返回 (已有的那张, false)，所以重传就是续传。
    pub fn insert_photo(&self, album_id: &str, p: NewPhoto) -> R<(Photo, bool)> {
        let c = self.conn.lock();
        let companions = serde_json::to_string(&p.companions).unwrap_or_else(|_| "[]".into());
        match c.execute(
            "INSERT INTO photos (album_id, key, name, folder, companions, width, height, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![album_id, p.key, p.name, p.folder, companions, p.width, p.height, p.size as i64],
        ) {
            Ok(_) => {
                let id = c.last_insert_rowid();
                Ok((self.photo_by(&c, "p.id = ?1", [id])?.ok_or("刚插入的照片不见了")?, true))
            }
            Err(err) if is_conflict(&err) => self
                .photo_by(&c, "p.album_id = ?1 AND p.key = ?2", params![album_id, p.key])?
                .map(|p| (p, false))
                .ok_or_else(|| "照片记录冲突".into()),
            Err(err) => Err(e(err)),
        }
    }

    pub fn delete_photos(&self, album_id: &str, ids: &[i64]) -> R<Vec<i64>> {
        let c = self.conn.lock();
        let mut done = vec![];
        for id in ids {
            if c.execute("DELETE FROM photos WHERE album_id = ?1 AND id = ?2", params![album_id, id]).map_err(e)? > 0 {
                done.push(*id);
            }
        }
        Ok(done)
    }

    /// 加星/取消。只改属于这个相册的照片，返回真正改到的 id。
    pub fn set_stars(&self, album_id: &str, ids: &[i64], starred: bool, by: &str) -> R<Vec<i64>> {
        let mut c = self.conn.lock();
        let tx = c.transaction().map_err(e)?;
        let mut changed = vec![];
        for id in ids {
            let belongs = tx
                .query_row("SELECT 1 FROM photos WHERE album_id = ?1 AND id = ?2", params![album_id, id], |_| Ok(()))
                .optional()
                .map_err(e)?
                .is_some();
            if !belongs {
                continue;
            }
            let n = if starred {
                tx.execute(
                    "INSERT INTO stars (photo_id, by, at) VALUES (?1, ?2, ?3)
                     ON CONFLICT (photo_id) DO UPDATE SET by = excluded.by, at = excluded.at",
                    params![id, by, now()],
                )
            } else {
                tx.execute("DELETE FROM stars WHERE photo_id = ?1", [id])
            }
            .map_err(e)?;
            if n > 0 {
                changed.push(*id);
            }
        }
        tx.commit().map_err(e)?;
        Ok(changed)
    }

    /// 相册里所有留言，按时间先后
    pub fn comments(&self, album_id: &str) -> R<Vec<Comment>> {
        let c = self.conn.lock();
        let mut st = c
            .prepare(
                "SELECT c.id, c.photo_id, c.name, c.text, c.at FROM comments c JOIN photos p ON p.id = c.photo_id
                 WHERE p.album_id = ?1 ORDER BY c.id",
            )
            .map_err(e)?;
        let rows = st
            .query_map([album_id], |r| Ok(Comment { id: r.get(0)?, photo_id: r.get(1)?, name: r.get(2)?, text: r.get(3)?, at: r.get(4)? }))
            .map_err(e)?;
        rows.collect::<Result<_, _>>().map_err(e)
    }

    /// 留言。返回这条留言和它的删除口令（只有留言的那台设备拿得到，用来删自己的留言）。
    /// 照片不属于这个相册就返回 None。
    pub fn add_comment(&self, album_id: &str, photo_id: i64, name: &str, text: &str) -> R<Option<(Comment, String)>> {
        let c = self.conn.lock();
        let belongs = c
            .query_row("SELECT 1 FROM photos WHERE album_id = ?1 AND id = ?2", params![album_id, photo_id], |_| Ok(()))
            .optional()
            .map_err(e)?
            .is_some();
        if !belongs {
            return Ok(None);
        }
        let token = random_string(ID_ALPHABET, 20);
        let at = now();
        c.execute(
            "INSERT INTO comments (photo_id, name, text, token, at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![photo_id, name, text, token, at],
        )
        .map_err(e)?;
        Ok(Some((Comment { id: c.last_insert_rowid(), photo_id, name: name.to_string(), text: text.to_string(), at }, token)))
    }

    /// 删留言：留言的人（拿删除口令）或相册创建者（as_owner）可以删。返回是否删到了
    pub fn delete_comment(&self, album_id: &str, id: i64, token: &str, as_owner: bool) -> R<bool> {
        let c = self.conn.lock();
        let n = c
            .execute(
                "DELETE FROM comments WHERE id = ?1
                   AND photo_id IN (SELECT id FROM photos WHERE album_id = ?2)
                   AND (?3 OR (token = ?4 AND ?4 != ''))",
                params![id, album_id, as_owner, token],
            )
            .map_err(e)?;
        Ok(n > 0)
    }
}
