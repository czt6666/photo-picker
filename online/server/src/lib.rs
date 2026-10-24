//! PhotoPicker 远程相册服务。
//!
//! 一个远程相册 = 一份压缩预览 + 一份大家共用的星标 + 每张照片下的留言。链接是 `/r/<相册码>`，拿到链接的人都能进来挑。
//! - 网页版 PhotoPicker（就是桌面版同一套前端）也由这里提供：`/`、`/r/<code>` 都返回它的 index.html；
//! - 桌面版通过同样的接口访问（允许跨域）；
//! - 谁加星/取消、留言、新传了照片，都通过 WebSocket 实时推给正在看这个相册的所有人。
//!
//! 服务器上**只有压缩后的预览**，没有原图：摄影师那边上传前就压好了（桌面版用自带的解码器，网页版在浏览器里压），
//! 原图一直留在摄影师电脑上，导出时按文件名对回去。

pub mod db;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Multipart, Path as UrlPath, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use db::{Album, Db, NewPhoto};

pub struct Config {
    /// 数据目录：里面是 picker.db 和 photos/
    pub data_dir: PathBuf,
    /// 网页版 PhotoPicker 的构建产物（仓库根目录 `npm run build` 出来的 dist）
    pub web_dir: PathBuf,
    /// 设了的话，创建远程相册要输这个密码，防止陌生人拿你的服务器当图床
    pub create_password: Option<String>,
    /// 在 Nginx/CDN 后面时设为 true，才信任 X-Forwarded-For 里的客户端 IP
    pub behind_proxy: bool,
}

pub struct AppState {
    db: Db,
    photos_dir: PathBuf,
    create_password: Option<String>,
    behind_proxy: bool,
    limiter: Limiter,
    hub: Hub,
}

type S = State<Arc<AppState>>;

pub const THUMB_MAX_BYTES: usize = 1024 * 1024;
pub const PREVIEW_MAX_BYTES: usize = 10 * 1024 * 1024;
const NAME_MAX: usize = 40;

pub fn app(cfg: Config) -> Result<Router, String> {
    let photos_dir = cfg.data_dir.join("photos");
    std::fs::create_dir_all(&photos_dir).map_err(|e| format!("建数据目录失败 {}: {e}", photos_dir.display()))?;
    let db = Db::open(&cfg.data_dir.join("picker.db"))?;
    let state = Arc::new(AppState {
        db,
        photos_dir: photos_dir.clone(),
        create_password: cfg.create_password.filter(|p| !p.is_empty()),
        behind_proxy: cfg.behind_proxy,
        limiter: Limiter::default(),
        hub: Hub::default(),
    });

    let api = Router::new()
        .route("/config", get(config))
        .route("/albums", post(create_album))
        .route("/albums/{code}", get(get_album).patch(rename_album).delete(delete_album))
        .route(
            "/albums/{code}/photos",
            post(upload).layer(DefaultBodyLimit::max(PREVIEW_MAX_BYTES + THUMB_MAX_BYTES + 64 * 1024)),
        )
        .route("/albums/{code}/photos/delete", post(delete_photos))
        .route("/albums/{code}/stars", put(set_stars))
        .route("/albums/{code}/photos/{id}/comments", post(add_comment))
        .route("/albums/{code}/comments/{id}", axum::routing::delete(delete_comment))
        .route("/albums/{code}/ws", get(ws))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "没有这个接口") });

    // 预览图的文件名里带着自增 id，同一个 URL 的内容永远不变，可以让浏览器/CDN 缓存一年。
    let images = Router::new().fallback_service(ServeDir::new(&photos_dir)).layer(SetResponseHeaderLayer::overriding(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=31536000, immutable"),
    ));

    let index = ServeFile::new(cfg.web_dir.join("index.html"));
    Ok(Router::new()
        .nest("/api", api)
        .nest("/img", images)
        // 桌面版的页面来源是 tauri://localhost，要允许它跨域调接口、取图
        .layer(CorsLayer::permissive())
        .route_service("/", index.clone())
        .route_service("/r/{code}", index)
        .fallback_service(ServeDir::new(&cfg.web_dir))
        .layer(axum::middleware::map_response(utf8_charset))
        .with_state(state))
}

/// 网页、脚本、样式默认只写 `text/html`、`text/javascript`，没说编码，有的浏览器会猜错，中文变成乱码。
/// 这里统一补上 `charset=utf-8`。
async fn utf8_charset(mut res: Response) -> Response {
    let ct = res.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("");
    let textual = ct.starts_with("text/") || ct.starts_with("application/javascript");
    if textual && !ct.contains("charset") {
        if let Ok(v) = HeaderValue::from_str(&format!("{ct}; charset=utf-8")) {
            res.headers_mut().insert(header::CONTENT_TYPE, v);
        }
    }
    res
}

// ---------- 错误 ----------

#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn new(code: StatusCode, msg: impl Into<String>) -> Self {
        ApiError(code, msg.into())
    }
    fn bad(msg: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, msg)
    }
}

impl From<String> for ApiError {
    fn from(msg: String) -> Self {
        eprintln!("[server] {msg}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, msg)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T = Json<Value>> = Result<T, ApiError>;

// ---------- 防猜码 ----------

/// 相册码 16 位已经猜不到了，再挡一下暴力枚举：同一 IP 10 分钟内输错 30 次就先歇着。
#[derive(Default)]
struct Limiter {
    fails: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

const FAIL_WINDOW: Duration = Duration::from_secs(600);
const FAIL_MAX: u32 = 30;

impl Limiter {
    fn blocked(&self, ip: IpAddr) -> bool {
        self.fails.lock().get(&ip).is_some_and(|(n, t)| *n >= FAIL_MAX && t.elapsed() < FAIL_WINDOW)
    }
    fn fail(&self, ip: IpAddr) {
        let mut m = self.fails.lock();
        if m.len() > 10_000 {
            m.retain(|_, (_, t)| t.elapsed() < FAIL_WINDOW);
        }
        let e = m.entry(ip).or_insert((0, Instant::now()));
        if e.1.elapsed() >= FAIL_WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }
}

pub struct ClientIp(IpAddr);

impl FromRequestParts<Arc<AppState>> for ClientIp {
    type Rejection = std::convert::Infallible;
    async fn from_request_parts(parts: &mut Parts, state: &Arc<AppState>) -> Result<Self, Self::Rejection> {
        if state.behind_proxy {
            let fwd = parts
                .headers
                .get("x-forwarded-for")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.split(',').next())
                .and_then(|v| v.trim().parse().ok());
            if let Some(ip) = fwd {
                return Ok(ClientIp(ip));
            }
        }
        let ip = parts.extensions.get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip()).unwrap_or(IpAddr::from([0, 0, 0, 0]));
        Ok(ClientIp(ip))
    }
}

fn album(st: &AppState, ip: IpAddr, code: &str) -> ApiResult<Album> {
    if st.limiter.blocked(ip) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "输错太多次，请 10 分钟后再试"));
    }
    match st.db.album_by_code(code)? {
        Some(a) => Ok(a),
        None => {
            st.limiter.fail(ip);
            Err(ApiError::new(StatusCode::NOT_FOUND, "相册不存在，可能链接不对或已被删除"))
        }
    }
}

/// 上传、删除、改名只有创建者能做：创建时拿到的 owner_token 放在 `x-owner-token` 头里
fn owned(st: &AppState, ip: IpAddr, code: &str, headers: &HeaderMap) -> ApiResult<Album> {
    let a = album(st, ip, code)?;
    let token = headers.get("x-owner-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    if token.is_empty() || token != a.owner_token {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "只有创建这个相册的人能这样做"));
    }
    Ok(a)
}

fn clean_name(name: &str, what: &str) -> ApiResult<String> {
    let n: String = name.trim().chars().filter(|c| !c.is_control()).collect();
    if n.is_empty() {
        return Err(ApiError::bad(format!("请填写{what}")));
    }
    if n.chars().count() > NAME_MAX {
        return Err(ApiError::bad(format!("{what}太长了")));
    }
    Ok(n)
}

// ---------- 实时推送 ----------

/// 每个正在被人看的相册一个广播频道，外加“谁在看”的名单。
#[derive(Default)]
struct Hub {
    rooms: Mutex<HashMap<String, Room>>,
    next_id: AtomicU64,
}

struct Room {
    tx: broadcast::Sender<String>,
    viewers: HashMap<u64, String>,
}

impl Hub {
    fn join(&self, album_id: &str) -> (u64, broadcast::Receiver<String>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut rooms = self.rooms.lock();
        let room = rooms
            .entry(album_id.to_string())
            .or_insert_with(|| Room { tx: broadcast::channel(256).0, viewers: HashMap::new() });
        room.viewers.insert(id, String::new());
        (id, room.tx.subscribe())
    }

    fn set_name(&self, album_id: &str, conn: u64, name: String) {
        if let Some(room) = self.rooms.lock().get_mut(album_id) {
            room.viewers.insert(conn, name);
        }
        self.send_presence(album_id);
    }

    fn leave(&self, album_id: &str, conn: u64) {
        let mut rooms = self.rooms.lock();
        if let Some(room) = rooms.get_mut(album_id) {
            room.viewers.remove(&conn);
            if room.viewers.is_empty() {
                rooms.remove(album_id);
                return;
            }
        }
        drop(rooms);
        self.send_presence(album_id);
    }

    fn send_presence(&self, album_id: &str) {
        let rooms = self.rooms.lock();
        if let Some(room) = rooms.get(album_id) {
            let mut names: Vec<&String> = room.viewers.values().filter(|n| !n.is_empty()).collect();
            names.sort();
            names.dedup();
            let _ = room.tx.send(json!({ "type": "presence", "names": names }).to_string());
        }
    }

    fn send(&self, album_id: &str, msg: Value) {
        if let Some(room) = self.rooms.lock().get(album_id) {
            let _ = room.tx.send(msg.to_string());
        }
    }
}

async fn ws(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, upgrade: WebSocketUpgrade) -> ApiResult<Response> {
    let a = album(&st, ip, &code)?;
    Ok(upgrade.on_upgrade(move |socket| run_socket(st, a.id, socket)))
}

async fn run_socket(st: Arc<AppState>, album_id: String, socket: WebSocket) {
    let (conn, mut rx) = st.hub.join(&album_id);
    let (mut sink, mut stream) = socket.split();
    let mut ping = tokio::time::interval(Duration::from_secs(25)); // 防止中间的代理把空闲连接掐掉
    loop {
        tokio::select! {
            msg = rx.recv() => match msg {
                Ok(text) => if sink.send(Message::Text(text.into())).await.is_err() { break },
                // 落后太多（网太慢）：让客户端整体重新拉一次
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    if sink.send(Message::Text(json!({ "type": "reload" }).to_string().into())).await.is_err() { break }
                }
                Err(_) => break,
            },
            incoming = stream.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    #[derive(Deserialize)]
                    struct Hello { name: String }
                    if let Ok(h) = serde_json::from_str::<Hello>(&text) {
                        let name: String = h.name.trim().chars().filter(|c| !c.is_control()).take(NAME_MAX).collect();
                        st.hub.set_name(&album_id, conn, name);
                    }
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                Some(Ok(_)) => {}
            },
            _ = ping.tick() => if sink.send(Message::Ping(Vec::new().into())).await.is_err() { break },
        }
    }
    st.hub.leave(&album_id, conn);
}

// ---------- 接口 ----------

async fn config(State(st): S) -> Json<Value> {
    Json(json!({ "create_password_required": st.create_password.is_some() }))
}

#[derive(Deserialize)]
struct CreateAlbum {
    name: String,
    password: Option<String>,
}

async fn create_album(State(st): S, Json(req): Json<CreateAlbum>) -> ApiResult {
    if let Some(pw) = &st.create_password {
        if req.password.as_deref() != Some(pw.as_str()) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "创建密码不对"));
        }
    }
    let name = clean_name(&req.name, "相册名")?;
    let a = st.db.create_album(&name)?;
    Ok(Json(json!({ "album": a, "owner_token": a.owner_token })))
}

async fn get_album(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>) -> ApiResult {
    let a = album(&st, ip, &code)?;
    Ok(Json(json!({ "album": a, "photos": st.db.photos(&a.id)?, "comments": st.db.comments(&a.id)? })))
}

#[derive(Deserialize)]
struct Rename {
    name: String,
}

async fn rename_album(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, headers: HeaderMap, Json(req): Json<Rename>) -> ApiResult {
    let a = owned(&st, ip, &code, &headers)?;
    let name = clean_name(&req.name, "相册名")?;
    st.db.rename_album(&a.id, &name)?;
    st.hub.send(&a.id, json!({ "type": "album", "name": name }));
    Ok(Json(json!({ "ok": true })))
}

async fn delete_album(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, headers: HeaderMap) -> ApiResult {
    let a = owned(&st, ip, &code, &headers)?;
    st.db.delete_album(&a.id)?;
    st.hub.send(&a.id, json!({ "type": "gone" }));
    let dir = st.photos_dir.join(&a.id);
    if let Err(e) = tokio::fs::remove_dir_all(&dir).await {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[server] 删除 {} 失败：{e}", dir.display());
        }
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct UploadMeta {
    key: String,
    name: String,
    #[serde(default)]
    folder: String,
    #[serde(default)]
    companions: Vec<String>,
    width: u32,
    height: u32,
    #[serde(default)]
    size: u64,
}

fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF
}

fn photo_file(dir: &Path, album_id: &str, photo_id: i64, kind: char) -> PathBuf {
    dir.join(album_id).join(format!("{photo_id}_{kind}.jpg"))
}

/// 上传一张：表单里 `meta`（JSON）、`thumb`、`preview`（都是压好的 JPEG）。
/// 同一个 key 传过了就直接返回已有的那张，所以中断后再传一次就是“续传”。
async fn upload(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, headers: HeaderMap, mut form: Multipart) -> ApiResult {
    let a = owned(&st, ip, &code, &headers)?;
    let (mut meta, mut thumb, mut preview) = (None, None, None);
    while let Some(field) = form.next_field().await.map_err(|e| ApiError::bad(format!("表单不完整：{e}")))? {
        let name = field.name().unwrap_or_default().to_string();
        let bytes = field.bytes().await.map_err(|e| ApiError::bad(format!("上传中断：{e}")))?;
        match name.as_str() {
            "meta" => meta = Some(serde_json::from_slice::<UploadMeta>(&bytes).map_err(|e| ApiError::bad(format!("meta 格式不对：{e}")))?),
            "thumb" => thumb = Some(bytes),
            "preview" => preview = Some(bytes),
            _ => {}
        }
    }
    let (Some(meta), Some(thumb), Some(preview)) = (meta, thumb, preview) else {
        return Err(ApiError::bad("缺少 meta / thumb / preview"));
    };
    if !is_jpeg(&thumb) || !is_jpeg(&preview) {
        return Err(ApiError::bad("缩略图和预览图必须是 JPEG"));
    }
    if thumb.len() > THUMB_MAX_BYTES || preview.len() > PREVIEW_MAX_BYTES {
        return Err(ApiError::bad("图片太大，应先压缩"));
    }
    let key = meta.key.trim().to_lowercase();
    if key.is_empty() || key.len() > 1024 || meta.name.len() > 512 || meta.folder.len() > 1024 || meta.companions.len() > 20 {
        return Err(ApiError::bad("照片信息不对"));
    }
    let new = NewPhoto {
        key,
        name: meta.name,
        folder: meta.folder,
        companions: meta.companions,
        width: meta.width,
        height: meta.height,
        size: meta.size,
    };
    let (photo, created) = st.db.insert_photo(&a.id, new)?;
    if !created {
        return Ok(Json(json!({ "photo": photo, "existed": true })));
    }
    let write = async {
        tokio::fs::create_dir_all(st.photos_dir.join(&a.id)).await?;
        for (kind, bytes) in [('t', &thumb), ('p', &preview)] {
            let path = photo_file(&st.photos_dir, &a.id, photo.id, kind);
            let tmp = path.with_extension("part");
            tokio::fs::write(&tmp, bytes).await?;
            tokio::fs::rename(&tmp, &path).await?;
        }
        std::io::Result::Ok(())
    };
    if let Err(e) = write.await {
        let _ = st.db.delete_photos(&a.id, &[photo.id]);
        return Err(format!("保存图片失败：{e}").into());
    }
    st.hub.send(&a.id, json!({ "type": "photos", "photos": [&photo] }));
    Ok(Json(json!({ "photo": photo, "existed": false })))
}

#[derive(Deserialize)]
struct Ids {
    ids: Vec<i64>,
}

async fn delete_photos(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, headers: HeaderMap, Json(req): Json<Ids>) -> ApiResult {
    let a = owned(&st, ip, &code, &headers)?;
    let done = st.db.delete_photos(&a.id, &req.ids)?;
    for id in &done {
        for kind in ['t', 'p'] {
            let _ = tokio::fs::remove_file(photo_file(&st.photos_dir, &a.id, *id, kind)).await;
        }
    }
    if !done.is_empty() {
        st.hub.send(&a.id, json!({ "type": "deleted", "ids": done }));
    }
    Ok(Json(json!({ "deleted": done })))
}

#[derive(Deserialize)]
struct StarReq {
    ids: Vec<i64>,
    starred: bool,
    /// 以前会记下是谁加的星；现在不问名字了，留着兼容旧客户端
    #[serde(default)]
    by: String,
}

async fn set_stars(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, Json(req): Json<StarReq>) -> ApiResult {
    let a = album(&st, ip, &code)?;
    if req.ids.len() > 10_000 {
        return Err(ApiError::bad("一次太多了"));
    }
    let by: String = req.by.trim().chars().filter(|c| !c.is_control()).take(NAME_MAX).collect();
    let changed = st.db.set_stars(&a.id, &req.ids, req.starred, &by)?;
    if !changed.is_empty() {
        st.hub.send(&a.id, json!({ "type": "stars", "ids": changed, "starred": req.starred, "by": by }));
    }
    Ok(Json(json!({ "changed": changed })))
}

// ---------- 留言 ----------

const COMMENT_MAX: usize = 500;

#[derive(Deserialize)]
struct NewComment {
    text: String,
}

async fn add_comment(
    State(st): S,
    ClientIp(ip): ClientIp,
    UrlPath((code, photo_id)): UrlPath<(String, i64)>,
    Json(req): Json<NewComment>,
) -> ApiResult {
    let a = album(&st, ip, &code)?;
    // 换行保留，其它控制字符去掉
    let text: String = req.text.trim().chars().filter(|c| *c == '\n' || !c.is_control()).collect();
    if text.is_empty() {
        return Err(ApiError::bad("写点什么再发"));
    }
    if text.chars().count() > COMMENT_MAX {
        return Err(ApiError::bad(format!("留言太长了（最多 {COMMENT_MAX} 字）")));
    }
    let Some((comment, token)) = st.db.add_comment(&a.id, photo_id, &text)? else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "这张照片不在相册里"));
    };
    st.hub.send(&a.id, json!({ "type": "comment", "comment": comment }));
    Ok(Json(json!({ "comment": comment, "token": token })))
}

/// 删留言：`x-comment-token`（留言时拿到的）或 `x-owner-token`（相册创建者）
async fn delete_comment(
    State(st): S,
    ClientIp(ip): ClientIp,
    UrlPath((code, id)): UrlPath<(String, i64)>,
    headers: HeaderMap,
) -> ApiResult {
    let a = album(&st, ip, &code)?;
    let header = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    let owner = header("x-owner-token");
    let as_owner = !owner.is_empty() && owner == a.owner_token;
    if !st.db.delete_comment(&a.id, id, &header("x-comment-token"), as_owner)? {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "只能删自己的留言"));
    }
    st.hub.send(&a.id, json!({ "type": "comment_deleted", "id": id }));
    Ok(Json(json!({ "deleted": id })))
}
