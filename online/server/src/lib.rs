//! PhotoPicker 在线选片服务。
//!
//! 三种人、三种入口：
//! - 摄影师：创建相册后拿到一个**管理链接**（`/a/<admin_token>`），在那里上传、看结果、导出清单；
//! - 模特：拿到 6 位**共享码**（`/s/<code>`），输入名字后在手机/平板/电脑上选片；
//! - 浏览器直接取图：`/img/<album_id>/<photo_id>_t.jpg`（缩略图）和 `_p.jpg`（预览图）。
//!
//! 服务器上**只有压缩后的预览**，没有原图：压缩在摄影师的浏览器里做（见 web/src/upload.ts），
//! 原图一直留在摄影师电脑上。选完后摄影师导出“原图文件名清单”，用它在本地找回原图去修。

pub mod db;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, DefaultBodyLimit, FromRequestParts, Multipart, Path as UrlPath, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::services::{ServeDir, ServeFile};
use tower_http::set_header::SetResponseHeaderLayer;

use db::{Album, Db, NewPhoto};

pub struct Config {
    /// 数据目录：里面是 picker.db 和 photos/
    pub data_dir: PathBuf,
    /// 前端构建产物（web/dist）
    pub web_dir: PathBuf,
    /// 设了的话，创建相册要输这个密码，防止陌生人拿你的服务器当图床
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
}

type S = State<Arc<AppState>>;

pub const THUMB_MAX_BYTES: usize = 1024 * 1024;
pub const PREVIEW_MAX_BYTES: usize = 10 * 1024 * 1024;
const NAME_MAX: usize = 40;
const NOTE_MAX: usize = 500;

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
    });

    let api = Router::new()
        .route("/config", get(config))
        .route("/albums", post(create_album))
        .route("/admin/{token}", get(admin_get).patch(admin_update).delete(admin_delete))
        .route("/admin/{token}/code", post(admin_reset_code))
        .route("/admin/{token}/photos", post(admin_upload).layer(DefaultBodyLimit::max(PREVIEW_MAX_BYTES + THUMB_MAX_BYTES + 64 * 1024)))
        .route("/admin/{token}/photos/{id}", delete(admin_delete_photo))
        .route("/admin/{token}/pickers/{name}", delete(admin_delete_picker))
        .route("/share/{code}", get(share_get))
        .route("/share/{code}/join", post(share_join))
        .route("/share/{code}/pick", put(share_pick))
        .route("/share/{code}/submit", post(share_submit))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "没有这个接口") });

    // 预览图的文件名里带着自增 id，同一个 URL 的内容永远不变，可以让浏览器/CDN 缓存一年。
    let images = Router::new()
        .fallback_service(ServeDir::new(&photos_dir))
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=31536000, immutable"),
        ));

    let web = &cfg.web_dir;
    let page = |name: &str| ServeFile::new(web.join(name));
    Ok(Router::new()
        .nest("/api", api)
        .nest("/img", images)
        .route_service("/", page("index.html"))
        .route_service("/new", page("index.html"))
        .route_service("/a/{token}", page("admin.html"))
        .route_service("/s/{code}", page("pick.html"))
        .fallback_service(ServeDir::new(web))
        .with_state(state))
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

/// 共享码只有 6 位，挡一下暴力枚举：同一 IP 10 分钟内输错 30 次就先歇着。
#[derive(Default)]
struct Limiter {
    fails: Mutex<HashMap<IpAddr, (u32, Instant)>>,
}

const FAIL_WINDOW: Duration = Duration::from_secs(600);
const FAIL_MAX: u32 = 30;

impl Limiter {
    fn blocked(&self, ip: IpAddr) -> bool {
        let m = self.fails.lock();
        m.get(&ip).is_some_and(|(n, t)| *n >= FAIL_MAX && t.elapsed() < FAIL_WINDOW)
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
        let ip = parts
            .extensions
            .get::<ConnectInfo<SocketAddr>>()
            .map(|c| c.0.ip())
            .unwrap_or(IpAddr::from([0, 0, 0, 0]));
        Ok(ClientIp(ip))
    }
}

// ---------- 查相册 ----------

fn album_by_token(st: &AppState, token: &str) -> ApiResult<Album> {
    st.db
        .album_by_token(token)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "管理链接无效，相册可能已删除"))
}

fn album_by_code(st: &AppState, ip: IpAddr, code: &str) -> ApiResult<Album> {
    if st.limiter.blocked(ip) {
        return Err(ApiError::new(StatusCode::TOO_MANY_REQUESTS, "输错太多次，请 10 分钟后再试"));
    }
    match st.db.album_by_code(code)? {
        Some(a) => Ok(a),
        None => {
            st.limiter.fail(ip);
            Err(ApiError::new(StatusCode::NOT_FOUND, "共享码不对，或相册已删除"))
        }
    }
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

fn album_json(a: &Album, admin: bool) -> Value {
    let mut v = json!({
        "id": a.id,
        "name": a.name,
        "pick_limit": a.pick_limit,
        "closed": a.closed,
        "created_at": a.created_at,
    });
    if admin {
        v["share_code"] = json!(a.share_code);
    }
    v
}

// ---------- 摄影师 ----------

async fn config(State(st): S) -> Json<Value> {
    Json(json!({ "create_password_required": st.create_password.is_some() }))
}

#[derive(Deserialize)]
struct CreateAlbum {
    name: String,
    pick_limit: Option<u32>,
    password: Option<String>,
}

async fn create_album(State(st): S, Json(req): Json<CreateAlbum>) -> ApiResult {
    if let Some(pw) = &st.create_password {
        if req.password.as_deref() != Some(pw.as_str()) {
            return Err(ApiError::new(StatusCode::FORBIDDEN, "创建密码不对"));
        }
    }
    let name = clean_name(&req.name, "相册名")?;
    let album = st.db.create_album(&name, req.pick_limit.filter(|n| *n > 0))?;
    Ok(Json(json!({ "album": album_json(&album, true), "admin_token": album.admin_token })))
}

async fn admin_get(State(st): S, UrlPath(token): UrlPath<String>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    Ok(Json(json!({
        "album": album_json(&a, true),
        "photos": st.db.photos(&a.id)?,
        "pickers": st.db.pickers(&a.id)?,
    })))
}

#[derive(Deserialize)]
struct UpdateAlbum {
    name: Option<String>,
    /// 0 表示不限
    pick_limit: Option<u32>,
    closed: Option<bool>,
}

async fn admin_update(State(st): S, UrlPath(token): UrlPath<String>, Json(req): Json<UpdateAlbum>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    let name = req.name.as_deref().map(|n| clean_name(n, "相册名")).transpose()?;
    let limit = req.pick_limit.map(|n| (n > 0).then_some(n));
    st.db.update_album(&a.id, name.as_deref(), limit, req.closed)?;
    let a = album_by_token(&st, &token)?;
    Ok(Json(json!({ "album": album_json(&a, true) })))
}

async fn admin_reset_code(State(st): S, UrlPath(token): UrlPath<String>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    let code = st.db.reset_code(&a.id)?;
    Ok(Json(json!({ "share_code": code })))
}

async fn admin_delete(State(st): S, UrlPath(token): UrlPath<String>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    st.db.delete_album(&a.id)?;
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
    originals: Vec<String>,
    width: u32,
    height: u32,
}

fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF
}

fn photo_file(dir: &Path, album_id: &str, photo_id: i64, kind: char) -> PathBuf {
    dir.join(album_id).join(format!("{photo_id}_{kind}.jpg"))
}

/// 上传一张：表单里 `meta`（JSON）、`thumb`、`preview`（都是浏览器压好的 JPEG）。
/// 同一个 key 传过了就直接返回已有的那张，所以断网后重新选文件夹就是“续传”。
async fn admin_upload(State(st): S, UrlPath(token): UrlPath<String>, mut form: Multipart) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    let (mut meta, mut thumb, mut preview) = (None, None, None);
    while let Some(field) = form.next_field().await.map_err(|e| ApiError::bad(format!("表单不完整：{e}")))? {
        let name = field.name().unwrap_or_default().to_string();
        let bytes = field.bytes().await.map_err(|e| ApiError::bad(format!("上传中断：{e}")))?;
        match name.as_str() {
            "meta" => {
                meta = Some(serde_json::from_slice::<UploadMeta>(&bytes).map_err(|e| ApiError::bad(format!("meta 格式不对：{e}")))?)
            }
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
    if key.is_empty() || key.len() > 1024 || meta.name.len() > 512 || meta.folder.len() > 1024 || meta.originals.len() > 20 {
        return Err(ApiError::bad("照片信息不对"));
    }
    let mut originals = meta.originals;
    if originals.is_empty() {
        originals.push(meta.name.clone());
    }
    let new = NewPhoto { key, name: meta.name, folder: meta.folder, originals, width: meta.width, height: meta.height };
    let photo = match st.db.insert_photo(&a.id, new) {
        Ok(p) => p,
        Err(Ok(existing)) => return Ok(Json(json!({ "photo": existing, "existed": true }))),
        Err(Err(e)) => return Err(e.into()),
    };

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
        let _ = st.db.delete_photo(&a.id, photo.id);
        return Err(format!("保存图片失败：{e}").into());
    }
    Ok(Json(json!({ "photo": photo, "existed": false })))
}

async fn admin_delete_photo(State(st): S, UrlPath((token, id)): UrlPath<(String, i64)>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    if !st.db.delete_photo(&a.id, id)? {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "照片不存在"));
    }
    for kind in ['t', 'p'] {
        let _ = tokio::fs::remove_file(photo_file(&st.photos_dir, &a.id, id, kind)).await;
    }
    Ok(Json(json!({ "ok": true })))
}

async fn admin_delete_picker(State(st): S, UrlPath((token, name)): UrlPath<(String, String)>) -> ApiResult {
    let a = album_by_token(&st, &token)?;
    st.db.delete_picker(&a.id, &name)?;
    Ok(Json(json!({ "ok": true })))
}

// ---------- 模特 ----------

async fn share_get(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>) -> ApiResult {
    let a = album_by_code(&st, ip, &code)?;
    Ok(Json(json!({ "album": album_json(&a, false), "photos": st.db.photos(&a.id)? })))
}

#[derive(Deserialize)]
struct Join {
    name: String,
}

async fn share_join(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, Json(req): Json<Join>) -> ApiResult {
    let a = album_by_code(&st, ip, &code)?;
    let name = clean_name(&req.name, "名字")?;
    Ok(Json(json!({ "picker": st.db.join(&a.id, &name)? })))
}

#[derive(Deserialize)]
struct PickReq {
    name: String,
    photo_id: i64,
    picked: bool,
    note: Option<String>,
}

async fn share_pick(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, Json(req): Json<PickReq>) -> ApiResult {
    let a = album_by_code(&st, ip, &code)?;
    if a.closed {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "摄影师已结束选片"));
    }
    let name = clean_name(&req.name, "名字")?;
    let note: Option<String> = req.note.map(|n| n.trim().chars().take(NOTE_MAX).collect());
    let count = st.db.set_pick(&a.id, &name, req.photo_id, req.picked, note.as_deref()).map_err(ApiError::bad)?;
    Ok(Json(json!({ "count": count })))
}

#[derive(Deserialize)]
struct SubmitReq {
    name: String,
    submitted: bool,
}

async fn share_submit(State(st): S, ClientIp(ip): ClientIp, UrlPath(code): UrlPath<String>, Json(req): Json<SubmitReq>) -> ApiResult {
    let a = album_by_code(&st, ip, &code)?;
    if a.closed {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "摄影师已结束选片"));
    }
    let name = clean_name(&req.name, "名字")?;
    if req.submitted {
        let n = st.db.pick_count(&a.id, &name)?;
        if let Some(limit) = a.pick_limit {
            if n > limit as usize {
                return Err(ApiError::bad(format!("最多选 {limit} 张，现在选了 {n} 张")));
            }
        }
    }
    st.db.set_submitted(&a.id, &name, req.submitted)?;
    Ok(Json(json!({ "ok": true })))
}
