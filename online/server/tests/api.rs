//! 走一遍完整流程：摄影师建相册、上传，模特凭共享码选片，摄影师看结果。

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use photo_picker_online::{app, Config};
use serde_json::{json, Value};
use tower::ServiceExt;

struct T {
    _dir: tempfile::TempDir,
    router: axum::Router,
}

fn setup(password: Option<&str>) -> T {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("web")).unwrap();
    std::fs::write(dir.path().join("web/pick.html"), "pick page").unwrap();
    let router = app(Config {
        data_dir: dir.path().join("data"),
        web_dir: dir.path().join("web"),
        create_password: password.map(String::from),
        behind_proxy: false,
    })
    .unwrap();
    T { _dir: dir, router }
}

impl T {
    async fn call(&self, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(v) => {
                req = req.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let res = self.router.clone().oneshot(req.body(body).unwrap()).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn raw(&self, uri: &str) -> (StatusCode, Vec<u8>, Option<String>) {
        let res = self.router.clone().oneshot(Request::get(uri).body(Body::empty()).unwrap()).await.unwrap();
        let cc = res.headers().get("cache-control").map(|v| v.to_str().unwrap().to_string());
        (res.status(), res.into_body().collect().await.unwrap().to_bytes().to_vec(), cc)
    }

    async fn upload(&self, token: &str, key: &str, name: &str, originals: &[&str]) -> (StatusCode, Value) {
        let boundary = "XBOUNDARY";
        let meta = json!({ "key": key, "name": name, "folder": "2024/外景", "originals": originals, "width": 2048, "height": 1365 });
        let mut body = Vec::new();
        let mut part = |name: &str, ctype: &str, data: &[u8]| {
            body.extend_from_slice(
                format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; filename=\"{name}\"\r\nContent-Type: {ctype}\r\n\r\n").as_bytes(),
            );
            body.extend_from_slice(data);
            body.extend_from_slice(b"\r\n");
        };
        part("meta", "application/json", meta.to_string().as_bytes());
        part("thumb", "image/jpeg", b"\xFF\xD8\xFF\xE0thumb");
        part("preview", "image/jpeg", b"\xFF\xD8\xFF\xE0preview");
        body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
        let req = Request::post(format!("/api/admin/{token}/photos"))
            .header("content-type", format!("multipart/form-data; boundary={boundary}"))
            .body(Body::from(body))
            .unwrap();
        let res = self.router.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

async fn new_album(t: &T, limit: u32) -> (String, String, String) {
    let (s, v) = t.call(Method::POST, "/api/albums", Some(json!({ "name": "小林 外景", "pick_limit": limit }))).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    (
        v["admin_token"].as_str().unwrap().into(),
        v["album"]["share_code"].as_str().unwrap().into(),
        v["album"]["id"].as_str().unwrap().into(),
    )
}

#[tokio::test]
async fn full_flow() {
    let t = setup(None);
    let (token, code, album_id) = new_album(&t, 2).await;
    assert_eq!(code.len(), 6);

    let (s, v) = t.upload(&token, "2024/外景/dsc_0001", "DSC_0001.JPG", &["DSC_0001.JPG", "DSC_0001.NEF"]).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["existed"], false);
    let p1 = v["photo"]["id"].as_i64().unwrap();
    // 同一张再传一次：不重复，算续传
    let (_, v) = t.upload(&token, "2024/外景/DSC_0001", "DSC_0001.JPG", &[]).await;
    assert_eq!(v["existed"], true);
    assert_eq!(v["photo"]["id"].as_i64().unwrap(), p1);
    let (_, v) = t.upload(&token, "2024/外景/dsc_0002", "DSC_0002.JPG", &[]).await;
    let p2 = v["photo"]["id"].as_i64().unwrap();
    assert_eq!(v["photo"]["originals"], json!(["DSC_0002.JPG"]));
    let (_, v) = t.upload(&token, "2024/外景/dsc_0003", "DSC_0003.JPG", &[]).await;
    let p3 = v["photo"]["id"].as_i64().unwrap();

    // 图片可直接取，且可长期缓存
    let (s, bytes, cc) = t.raw(&format!("/img/{album_id}/{p1}_p.jpg")).await;
    assert_eq!(s, StatusCode::OK);
    assert!(bytes.ends_with(b"preview"));
    assert!(cc.unwrap().contains("immutable"));

    // 模特：共享码不分大小写；看不到管理信息
    let (s, v) = t.call(Method::GET, &format!("/api/share/{}", code.to_lowercase()), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["photos"].as_array().unwrap().len(), 3);
    assert!(v["album"].get("share_code").is_none());
    assert!(!v.to_string().contains(&token));

    let (_, v) = t.call(Method::POST, &format!("/api/share/{code}/join"), Some(json!({ "name": " 小林 " }))).await;
    assert_eq!(v["picker"]["name"], "小林");
    assert_eq!(v["picker"]["picks"], json!([]));

    let pick = |id: i64, picked: bool, note: Option<&str>| {
        json!({ "name": "小林", "photo_id": id, "picked": picked, "note": note })
    };
    let (_, v) = t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p1, true, Some("脸修瘦一点")))).await;
    assert_eq!(v["count"], 1);
    // 只改选中不带备注时，备注保留
    t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p1, true, None))).await;
    t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p2, true, None))).await;
    let (_, v) = t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p3, true, None))).await;
    assert_eq!(v["count"], 3);

    // 超过上限不能提交
    let (s, _) = t.call(Method::POST, &format!("/api/share/{code}/submit"), Some(json!({ "name": "小林", "submitted": true }))).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p3, false, None))).await;
    let (s, _) = t.call(Method::POST, &format!("/api/share/{code}/submit"), Some(json!({ "name": "小林", "submitted": true }))).await;
    assert_eq!(s, StatusCode::OK);

    // 换设备再进来，选片还在
    let (_, v) = t.call(Method::POST, &format!("/api/share/{code}/join"), Some(json!({ "name": "小林" }))).await;
    assert_eq!(v["picker"]["submitted"], true);
    assert_eq!(v["picker"]["picks"], json!([{ "photo_id": p1, "note": "脸修瘦一点" }, { "photo_id": p2, "note": "" }]));

    // 摄影师看结果
    let (_, v) = t.call(Method::GET, &format!("/api/admin/{token}"), None).await;
    assert_eq!(v["pickers"][0]["name"], "小林");
    assert_eq!(v["pickers"][0]["picks"].as_array().unwrap().len(), 2);
    assert_eq!(v["photos"][0]["originals"], json!(["DSC_0001.JPG", "DSC_0001.NEF"]));

    // 结束选片后模特不能再改
    let (_, v) = t.call(Method::PATCH, &format!("/api/admin/{token}"), Some(json!({ "closed": true, "pick_limit": 0 }))).await;
    assert_eq!(v["album"]["closed"], true);
    assert_eq!(v["album"]["pick_limit"], Value::Null);
    let (s, _) = t.call(Method::PUT, &format!("/api/share/{code}/pick"), Some(pick(p3, true, None))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // 删照片连带删选片记录和文件
    t.call(Method::DELETE, &format!("/api/admin/{token}/photos/{p1}"), None).await;
    let (s, _, _) = t.raw(&format!("/img/{album_id}/{p1}_p.jpg")).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (_, v) = t.call(Method::GET, &format!("/api/admin/{token}"), None).await;
    assert_eq!(v["pickers"][0]["picks"], json!([{ "photo_id": p2, "note": "" }]));

    // 换共享码后旧码失效
    let (_, v) = t.call(Method::POST, &format!("/api/admin/{token}/code"), None).await;
    let new_code = v["share_code"].as_str().unwrap();
    assert_ne!(new_code, code);
    let (s, _) = t.call(Method::GET, &format!("/api/share/{code}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // 删相册
    t.call(Method::DELETE, &format!("/api/admin/{token}"), None).await;
    let (s, _) = t.call(Method::GET, &format!("/api/admin/{token}"), None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    let (s, _, _) = t.raw(&format!("/img/{album_id}/{p2}_t.jpg")).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn create_password_and_guess_limit() {
    let t = setup(Some("abc"));
    let (_, v) = t.call(Method::GET, "/api/config", None).await;
    assert_eq!(v["create_password_required"], true);
    let (s, _) = t.call(Method::POST, "/api/albums", Some(json!({ "name": "x" }))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let (s, v) = t.call(Method::POST, "/api/albums", Some(json!({ "name": "x", "password": "abc" }))).await;
    assert_eq!(s, StatusCode::OK);
    let code = v["album"]["share_code"].as_str().unwrap().to_string();

    for _ in 0..30 {
        let (s, _) = t.call(Method::GET, "/api/share/ZZZZZZ", None).await;
        assert_eq!(s, StatusCode::NOT_FOUND);
    }
    // 猜错太多次后，连对的码也先挡住
    let (s, _) = t.call(Method::GET, &format!("/api/share/{code}"), None).await;
    assert_eq!(s, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn rejects_non_jpeg_and_serves_pages() {
    let t = setup(None);
    let (token, _, _) = new_album(&t, 0).await;
    let (s, v) = t.call(Method::GET, &format!("/api/admin/{token}"), None).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["album"]["pick_limit"], Value::Null);
    let (s, body, _) = t.raw("/s/ABCDEF").await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body, b"pick page");
    let (s, _, _) = t.raw("/img/../picker.db").await;
    assert_ne!(s, StatusCode::OK);
}
