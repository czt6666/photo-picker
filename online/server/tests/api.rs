//! 远程相册的完整流程：创建、上传、两个人同时加星，WebSocket 实时收到对方的改动。

use std::net::SocketAddr;

use futures_util::{SinkExt, StreamExt};
use photo_picker_online::{app, Config};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

struct Srv {
    _dir: tempfile::TempDir,
    base: String,
    ws: String,
}

async fn start(password: Option<&str>) -> Srv {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("web")).unwrap();
    std::fs::write(dir.path().join("web/index.html"), "photo picker app").unwrap();
    let router = app(Config {
        data_dir: dir.path().join("data"),
        web_dir: dir.path().join("web"),
        create_password: password.map(String::from),
        behind_proxy: false,
    })
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await.unwrap();
    });
    Srv { _dir: dir, base: format!("http://{addr}"), ws: format!("ws://{addr}") }
}

/// 不引入 HTTP 客户端库：手写最小的 HTTP/1.1 请求
async fn http(srv: &Srv, method: &str, path: &str, headers: &[(&str, &str)], body: Vec<u8>, ctype: &str) -> (u16, Vec<u8>, String) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let host = srv.base.trim_start_matches("http://");
    let mut s = tokio::net::TcpStream::connect(host).await.unwrap();
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\nContent-Length: {}\r\n", body.len());
    if !body.is_empty() {
        req += &format!("Content-Type: {ctype}\r\n");
    }
    for (k, v) in headers {
        req += &format!("{k}: {v}\r\n");
    }
    req += "\r\n";
    s.write_all(req.as_bytes()).await.unwrap();
    s.write_all(&body).await.unwrap();
    let mut buf = vec![];
    s.read_to_end(&mut buf).await.unwrap();
    let split = buf.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&buf[..split]).to_string();
    let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
    let mut body = buf[split + 4..].to_vec();
    if head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        let mut out = vec![];
        let mut rest = &body[..];
        loop {
            let nl = rest.windows(2).position(|w| w == b"\r\n").unwrap();
            let n = usize::from_str_radix(std::str::from_utf8(&rest[..nl]).unwrap().trim(), 16).unwrap();
            if n == 0 {
                break;
            }
            out.extend_from_slice(&rest[nl + 2..nl + 2 + n]);
            rest = &rest[nl + 2 + n + 2..];
        }
        body = out;
    }
    (status, body, head)
}

async fn call(srv: &Srv, method: &str, path: &str, headers: &[(&str, &str)], body: Option<Value>) -> (u16, Value) {
    let b = body.map(|v| v.to_string().into_bytes()).unwrap_or_default();
    let (s, body, _) = http(srv, method, path, headers, b, "application/json").await;
    (s, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

async fn upload(srv: &Srv, code: &str, token: &str, key: &str, name: &str) -> (u16, Value) {
    let boundary = "XBOUNDARY";
    let meta = json!({ "key": key, "name": name, "folder": "外景", "companions": ["DSC.NEF"], "width": 2048, "height": 1365, "size": 12345 });
    let mut body = Vec::new();
    for (field, data) in [("meta", meta.to_string().into_bytes()), ("thumb", b"\xFF\xD8\xFF\xE0t".to_vec()), ("preview", b"\xFF\xD8\xFF\xE0p".to_vec())] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{field}\"\r\n\r\n").as_bytes());
        body.extend_from_slice(&data);
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let (s, b, _) = http(srv, "POST", &format!("/api/albums/{code}/photos"), &[("x-owner-token", token)], body, &format!("multipart/form-data; boundary={boundary}")).await;
    (s, serde_json::from_slice(&b).unwrap_or(Value::Null))
}

async fn next_json(ws: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin), want: &str) -> Value {
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(3), ws.next()).await.expect("等推送超时").unwrap().unwrap();
        if let Message::Text(t) = msg {
            let v: Value = serde_json::from_str(&t).unwrap();
            if v["type"] == want {
                return v;
            }
        }
    }
}

#[tokio::test]
async fn shared_album_with_live_stars() {
    let srv = start(None).await;
    let (s, v) = call(&srv, "POST", "/api/albums", &[], Some(json!({ "name": "小林 外景" }))).await;
    assert_eq!(s, 200, "{v}");
    let code = v["album"]["code"].as_str().unwrap().to_string();
    let album_id = v["album"]["id"].as_str().unwrap().to_string();
    let token = v["owner_token"].as_str().unwrap().to_string();
    assert!(v["album"].get("owner_token").is_none());

    // 两个人打开同一个相册
    let (mut a, _) = tokio_tungstenite::connect_async(format!("{}/api/albums/{code}/ws", srv.ws)).await.unwrap();
    let (mut b, _) = tokio_tungstenite::connect_async(format!("{}/api/albums/{}/ws", srv.ws, code.to_lowercase())).await.unwrap();
    a.send(Message::Text(json!({ "name": "摄影师" }).to_string().into())).await.unwrap();
    b.send(Message::Text(json!({ "name": "小林" }).to_string().into())).await.unwrap();
    loop {
        let p = next_json(&mut a, "presence").await;
        if p["names"] == json!(["小林", "摄影师"]) {
            break;
        }
    }

    // 只有创建者能上传；上传后两边都收到新照片
    let (s, _) = upload(&srv, &code, "wrong", "外景/dsc_0001", "DSC_0001.JPG").await;
    assert_eq!(s, 403);
    let (s, v) = upload(&srv, &code, &token, "外景/DSC_0001", "DSC_0001.JPG").await;
    assert_eq!(s, 200, "{v}");
    let p1 = v["photo"]["id"].as_i64().unwrap();
    assert_eq!(next_json(&mut b, "photos").await["photos"][0]["name"], "DSC_0001.JPG");
    let (_, v) = upload(&srv, &code, &token, "外景/dsc_0001", "DSC_0001.JPG").await;
    assert_eq!(v["existed"], true, "同一张再传 = 续传，不重复");
    let (_, v) = upload(&srv, &code, &token, "外景/dsc_0002", "DSC_0002.JPG").await;
    let p2 = v["photo"]["id"].as_i64().unwrap();

    // 模特加星 → 摄影师那边实时收到，带名字
    let (s, v) = call(&srv, "PUT", &format!("/api/albums/{code}/stars"), &[], Some(json!({ "ids": [p1, p2, 99999], "starred": true, "by": "小林" }))).await;
    assert_eq!(s, 200);
    assert_eq!(v["changed"], json!([p1, p2]));
    let ev = next_json(&mut a, "stars").await;
    assert_eq!(ev, json!({ "type": "stars", "ids": [p1, p2], "starred": true, "by": "小林" }));
    assert_eq!(next_json(&mut b, "stars").await["by"], "小林", "自己的改动也会推回来");
    // 摄影师取消一张
    call(&srv, "PUT", &format!("/api/albums/{code}/stars"), &[], Some(json!({ "ids": [p2], "starred": false, "by": "摄影师" }))).await;
    assert_eq!(next_json(&mut b, "stars").await["starred"], false);

    let (_, v) = call(&srv, "GET", &format!("/api/albums/{code}"), &[], None).await;
    assert_eq!(v["photos"][0]["starred"], true);
    assert_eq!(v["photos"][0]["starred_by"], "小林");
    assert_eq!(v["photos"][0]["companions"], json!(["DSC.NEF"]));
    assert_eq!(v["photos"][1]["starred"], false);

    // 图片可直接取，且可长期缓存、可跨域
    let (s, body, head) = http(&srv, "GET", &format!("/img/{album_id}/{p1}_p.jpg"), &[("Origin", "tauri://localhost")], vec![], "").await;
    assert_eq!(s, 200);
    assert!(body.ends_with(b"p"));
    let head = head.to_ascii_lowercase();
    assert!(head.contains("immutable"));
    assert!(head.contains("access-control-allow-origin"));

    // 删照片：推送 + 文件没了
    let (s, _) = call(&srv, "POST", &format!("/api/albums/{code}/photos/delete"), &[], Some(json!({ "ids": [p2] }))).await;
    assert_eq!(s, 403);
    call(&srv, "POST", &format!("/api/albums/{code}/photos/delete"), &[("x-owner-token", &token)], Some(json!({ "ids": [p2] }))).await;
    assert_eq!(next_json(&mut b, "deleted").await["ids"], json!([p2]));
    let (s, _, _) = http(&srv, "GET", &format!("/img/{album_id}/{p2}_t.jpg"), &[], vec![], "").await;
    assert_eq!(s, 404);

    // 链接 /r/<code> 打开的就是 PhotoPicker 本身
    let (s, body, _) = http(&srv, "GET", &format!("/r/{code}"), &[], vec![], "").await;
    assert_eq!(s, 200);
    assert_eq!(body, b"photo picker app");

    // 删相册：所有人收到 gone
    call(&srv, "DELETE", &format!("/api/albums/{code}"), &[("x-owner-token", &token)], None).await;
    next_json(&mut a, "gone").await;
    let (s, _) = call(&srv, "GET", &format!("/api/albums/{code}"), &[], None).await;
    assert_eq!(s, 404);
}

#[tokio::test]
async fn create_password_and_guess_limit() {
    let srv = start(Some("abc")).await;
    let (_, v) = call(&srv, "GET", "/api/config", &[], None).await;
    assert_eq!(v["create_password_required"], true);
    let (s, _) = call(&srv, "POST", "/api/albums", &[], Some(json!({ "name": "x" }))).await;
    assert_eq!(s, 403);
    let (s, v) = call(&srv, "POST", "/api/albums", &[], Some(json!({ "name": "x", "password": "abc" }))).await;
    assert_eq!(s, 200);
    let code = v["album"]["code"].as_str().unwrap().to_string();
    for _ in 0..30 {
        let (s, _) = call(&srv, "GET", "/api/albums/ZZZZZZ", &[], None).await;
        assert_eq!(s, 404);
    }
    // 猜错太多次后，连对的码也先挡住
    let (s, _) = call(&srv, "GET", &format!("/api/albums/{code}"), &[], None).await;
    assert_eq!(s, 429);
}

#[tokio::test]
async fn pages_declare_utf8() {
    let srv = start(None).await;
    let (s, _, head) = http(&srv, "GET", "/", &[], vec![], "").await;
    assert_eq!(s, 200);
    assert!(head.to_ascii_lowercase().contains("content-type: text/html; charset=utf-8"), "{head}");
    let (_, _, head) = http(&srv, "GET", "/api/albums/ABCDEFGHJKLMNPQR", &[], vec![], "").await;
    assert!(head.to_ascii_lowercase().contains("content-type: application/json"), "{head}");
}
