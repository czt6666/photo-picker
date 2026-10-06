//! 支持哪些图片格式，以及每种格式该怎么显示。
//!
//! 显示链路分两类：
//! - **webview 原生能解码的**（JPEG/PNG/WebP/GIF/BMP，macOS 上还有 HEIC/TIFF/AVIF）：
//!   直接把原文件字节交给 webview；
//! - **webview 解不了的**（RAW、Linux 上的 TIFF）：后端先转成 JPEG 预览再交出去。
//!
//! macOS 用系统 ImageIO 解码，几乎什么都认（HEIC、各家 RAW）；其它平台只用纯 Rust 解码器，
//! 所以支持的格式少一些。

use std::path::Path;

/// 所有平台都能解码的格式（纯 Rust 解码器支持）。
const COMMON: &[&str] = &["jpg", "jpeg", "jpe", "png", "webp", "gif", "bmp", "tif", "tiff"];

/// 各家相机的 RAW 格式。与平台无关：即使当前平台解不了，也要认得出来，
/// 好把它当作同名 JPG 的“伴侣文件”（见 [`is_companion`]）。
pub const RAW: &[&str] = &[
    "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "dng", "raf", "orf", "rw2", "rwl", "pef",
    "srw", "x3f", "3fr", "fff", "iiq", "erf", "kdc", "mrw", "mos",
];

/// 只有 macOS（ImageIO）能解码的格式：苹果设备常见的 HEIC/AVIF，以及所有 RAW。
#[cfg(target_os = "macos")]
const MAC_ONLY: &[&str] = &["heic", "heif", "avif"];
#[cfg(not(target_os = "macos"))]
const MAC_ONLY: &[&str] = &[];

/// webview 一定能直接显示的格式。
const WEB_NATIVE: &[&str] = &["jpg", "jpeg", "jpe", "png", "webp", "gif", "bmp"];

/// macOS 的 WKWebView（Safari 17+）额外能显示的格式。老系统解不了时，前端会自动退回后端转码。
#[cfg(target_os = "macos")]
const WEB_NATIVE_MAC: &[&str] = &["heic", "heif", "avif", "tif", "tiff"];
#[cfg(not(target_os = "macos"))]
const WEB_NATIVE_MAC: &[&str] = &[];

/// “照片类”格式：原图可能很大，全屏看时值得先缩成屏幕大小的预览再显示。
/// PNG/GIF 这类可能带透明通道或动画，转 JPEG 会丢东西，所以不在其中。
const PHOTO_LIKE: &[&str] = &["jpg", "jpeg", "jpe", "heic", "heif", "tif", "tiff", "avif"];

/// 小写扩展名（不含点）。
pub fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
}

pub fn is_supported(path: &Path) -> bool {
    ext_of(path).is_some_and(|e| is_supported_ext(&e))
}

pub fn is_supported_ext(ext: &str) -> bool {
    COMMON.contains(&ext) || MAC_ONLY.contains(&ext) || (cfg!(target_os = "macos") && is_raw(ext))
}

pub fn is_raw(ext: &str) -> bool {
    RAW.contains(&ext)
}

/// “伴侣文件”：和 JPG 同名时并进那张 JPG，不单独显示（像 Lightroom 的 RAW+JPEG）。
/// 包括 RAW 本身，以及 Lightroom / Capture One 给 RAW 写的 .xmp 侧车文件。
pub fn is_companion(ext: &str) -> bool {
    is_raw(ext) || ext == "xmp"
}

pub fn is_web_native(ext: &str) -> bool {
    WEB_NATIVE.contains(&ext) || WEB_NATIVE_MAC.contains(&ext)
}

/// 大图时是否先缩成屏幕尺寸预览（RAW 本身就不是 web 原生，总会转码）。
pub fn prefers_screen_preview(ext: &str) -> bool {
    PHOTO_LIKE.contains(&ext) || !is_web_native(ext)
}

pub fn is_jpeg(ext: &str) -> bool {
    matches!(ext, "jpg" | "jpeg" | "jpe")
}

/// 纯 Rust 解码器能不能解这个格式（不能的话只能靠 macOS ImageIO）。
pub fn rust_decodable(ext: &str) -> bool {
    COMMON.contains(&ext)
}

pub fn mime_for(ext: &str) -> &'static str {
    match ext {
        "jpg" | "jpeg" | "jpe" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ext_is_case_insensitive() {
        assert!(is_supported(Path::new("/a/IMG_0001.JPG")));
        assert!(is_supported(Path::new("/a/x.Png")));
        assert!(!is_supported(Path::new("/a/notes.txt")));
        assert!(!is_supported(Path::new("/a/noext")));
    }

    #[test]
    fn raw_is_companion_everywhere_but_supported_only_on_mac() {
        assert!(is_companion("cr3") && is_companion("xmp") && !is_companion("jpg"));
        assert_eq!(is_supported(Path::new("/a/IMG_1.CR3")), cfg!(target_os = "macos"));
        assert!(!is_supported(Path::new("/a/IMG_1.xmp")));
    }

    #[test]
    fn preview_policy() {
        assert!(prefers_screen_preview("jpg"));
        assert!(!prefers_screen_preview("png"));
        assert!(!prefers_screen_preview("gif"));
        assert!(is_web_native("jpeg"));
    }
}
