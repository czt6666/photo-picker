//! 启动远程相册服务。配置全走环境变量，方便放进 Docker：
//!
//! - `PP_ADDR`            监听地址，默认 0.0.0.0:8080
//! - `PP_DATA_DIR`        数据目录（数据库 + 预览图），默认 ./data
//! - `PP_WEB_DIR`         网页版 PhotoPicker（仓库根目录 npm run build 的 dist），默认 ../../dist
//! - `PP_CREATE_PASSWORD` 创建远程相册要输的密码，不设则谁都能建
//! - `PP_BEHIND_PROXY`    在 Nginx/CDN 后面时设为 1

use std::net::SocketAddr;
use std::path::PathBuf;

use photo_picker_online::{app, Config};

fn env(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

#[tokio::main]
async fn main() {
    let cfg = Config {
        data_dir: PathBuf::from(env("PP_DATA_DIR", "./data")),
        web_dir: PathBuf::from(env("PP_WEB_DIR", "../../dist")),
        create_password: std::env::var("PP_CREATE_PASSWORD").ok(),
        behind_proxy: matches!(env("PP_BEHIND_PROXY", "").as_str(), "1" | "true"),
    };
    let addr: SocketAddr = env("PP_ADDR", "0.0.0.0:8080").parse().expect("PP_ADDR 格式不对");
    let router = match app(cfg) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("启动失败：{e}");
            std::process::exit(1);
        }
    };
    let listener = tokio::net::TcpListener::bind(addr).await.expect("端口被占用？");
    println!("PhotoPicker 远程相册：http://{addr}");
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap();
}
