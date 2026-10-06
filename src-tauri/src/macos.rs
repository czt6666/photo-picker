//! macOS 专用：用系统 ImageIO 生成缩略图/预览。
//!
//! `CGImageSourceCreateThumbnailAtIndex` + `kCGImageSourceThumbnailMaxPixelSize` 是 macOS 上
//! 生成缩略图最快的方式（“访达”和“照片”App 都靠它）：
//! - JPEG 在解码阶段就按目标尺寸缩小（DCT 域缩放），Apple 芯片上还有硬件解码；
//! - HEIC、ProRAW、各家相机 RAW 统统支持；
//! - `kCGImageSourceCreateThumbnailWithTransform` 自动按 EXIF 方向转正；
//! - 输出 JPEG 时保留原图色彩空间（如 iPhone 的 Display P3），颜色不发灰。

use std::ffi::c_void;
use std::path::Path;

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation::url::CFURL;
use core_foundation_sys::base::{kCFAllocatorDefault, CFRelease, CFTypeRef};
use core_foundation_sys::data::{CFDataCreateMutable, CFDataGetBytePtr, CFDataGetLength, CFDataRef, CFMutableDataRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use core_foundation_sys::url::CFURLRef;

use crate::decode::Rendered;

type CGImageSourceRef = *const c_void;
type CGImageDestinationRef = *const c_void;
type CGImageRef = *const c_void;

#[link(name = "ImageIO", kind = "framework")]
extern "C" {
    static kCGImageSourceCreateThumbnailFromImageAlways: CFStringRef;
    static kCGImageSourceCreateThumbnailWithTransform: CFStringRef;
    static kCGImageSourceThumbnailMaxPixelSize: CFStringRef;
    static kCGImageSourceShouldCacheImmediately: CFStringRef;
    static kCGImageDestinationLossyCompressionQuality: CFStringRef;
    static kCGImagePropertyPixelWidth: CFStringRef;
    static kCGImagePropertyPixelHeight: CFStringRef;
    static kCGImagePropertyOrientation: CFStringRef;

    fn CGImageSourceCreateWithURL(url: CFURLRef, options: CFDictionaryRef) -> CGImageSourceRef;
    fn CGImageSourceCopyPropertiesAtIndex(isrc: CGImageSourceRef, index: usize, options: CFDictionaryRef) -> CFDictionaryRef;
    fn CGImageSourceCreateThumbnailAtIndex(isrc: CGImageSourceRef, index: usize, options: CFDictionaryRef) -> CGImageRef;
    fn CGImageDestinationCreateWithData(data: CFMutableDataRef, ty: CFStringRef, count: usize, options: CFDictionaryRef) -> CGImageDestinationRef;
    fn CGImageDestinationAddImage(idst: CGImageDestinationRef, image: CGImageRef, properties: CFDictionaryRef);
    fn CGImageDestinationFinalize(idst: CGImageDestinationRef) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGImageGetWidth(image: CGImageRef) -> usize;
    fn CGImageGetHeight(image: CGImageRef) -> usize;
}

/// 持有一个 Create/Copy 规则得到的 CF 对象，离开作用域自动 CFRelease。
struct Owned(*const c_void);

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { CFRelease(self.0 as CFTypeRef) }
        }
    }
}

fn key(k: CFStringRef) -> CFString {
    unsafe { CFString::wrap_under_get_rule(k) }
}

fn open_source(path: &Path) -> Result<Owned, String> {
    let url = CFURL::from_path(path, false).ok_or("路径无法转换为 URL")?;
    let src = unsafe { CGImageSourceCreateWithURL(url.as_concrete_TypeRef(), std::ptr::null()) };
    if src.is_null() {
        return Err("ImageIO 无法打开文件".into());
    }
    Ok(Owned(src))
}

pub fn render_jpeg(path: &Path, max_px: u32, quality: u8) -> Result<Rendered, String> {
    let src = open_source(path)?;

    let mut pairs: Vec<(CFString, CFType)> = vec![
        (key(unsafe { kCGImageSourceCreateThumbnailFromImageAlways }), CFBoolean::true_value().as_CFType()),
        (key(unsafe { kCGImageSourceCreateThumbnailWithTransform }), CFBoolean::true_value().as_CFType()),
        (key(unsafe { kCGImageSourceShouldCacheImmediately }), CFBoolean::true_value().as_CFType()),
    ];
    if max_px > 0 {
        pairs.push((key(unsafe { kCGImageSourceThumbnailMaxPixelSize }), CFNumber::from(max_px as i64).as_CFType()));
    }
    let opts = CFDictionary::from_CFType_pairs(&pairs);

    let image = unsafe { CGImageSourceCreateThumbnailAtIndex(src.0, 0, opts.as_concrete_TypeRef()) };
    if image.is_null() {
        return Err("ImageIO 解码失败".into());
    }
    let image = Owned(image);
    let (width, height) = unsafe { (CGImageGetWidth(image.0) as u32, CGImageGetHeight(image.0) as u32) };

    let data = unsafe { CFDataCreateMutable(kCFAllocatorDefault, 0) };
    if data.is_null() {
        return Err("内存不足".into());
    }
    let data = Owned(data as *const c_void);
    let jpeg_type = CFString::from_static_string("public.jpeg");
    let dest = unsafe {
        CGImageDestinationCreateWithData(data.0 as CFMutableDataRef, jpeg_type.as_concrete_TypeRef(), 1, std::ptr::null())
    };
    if dest.is_null() {
        return Err("ImageIO 无法创建 JPEG 编码器".into());
    }
    let dest = Owned(dest);
    let props = CFDictionary::from_CFType_pairs(&[(
        key(unsafe { kCGImageDestinationLossyCompressionQuality }),
        CFNumber::from(quality.min(100) as f64 / 100.0).as_CFType(),
    )]);
    let ok = unsafe {
        CGImageDestinationAddImage(dest.0, image.0, props.as_concrete_TypeRef());
        CGImageDestinationFinalize(dest.0)
    };
    if !ok {
        return Err("ImageIO JPEG 编码失败".into());
    }
    let jpeg = unsafe {
        let d = data.0 as CFDataRef;
        let len = CFDataGetLength(d);
        let ptr = CFDataGetBytePtr(d);
        if ptr.is_null() || len <= 0 {
            return Err("ImageIO 输出为空".into());
        }
        std::slice::from_raw_parts(ptr, len as usize).to_vec()
    };
    Ok(Rendered { jpeg, width, height })
}

/// 读图片尺寸（已按方向转正）。只读文件头，不解码像素。
pub fn image_size(path: &Path) -> Option<(u32, u32)> {
    let src = open_source(path).ok()?;
    let raw = unsafe { CGImageSourceCopyPropertiesAtIndex(src.0, 0, std::ptr::null()) };
    if raw.is_null() {
        return None;
    }
    let props: CFDictionary<CFString, CFType> = unsafe { CFDictionary::wrap_under_create_rule(raw) };
    let num = |k: CFStringRef| -> Option<i64> {
        props.find(key(k)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_i64())
    };
    let w = num(unsafe { kCGImagePropertyPixelWidth })?;
    let h = num(unsafe { kCGImagePropertyPixelHeight })?;
    let orientation = num(unsafe { kCGImagePropertyOrientation }).unwrap_or(1);
    let (w, h) = (w as u32, h as u32);
    Some(if (5..=8).contains(&orientation) { (h, w) } else { (w, h) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decode::tests::make_jpeg;
    use crate::meta::tests::with_exif;

    #[test]
    fn imageio_thumbnail_applies_orientation_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("rot.jpg");
        std::fs::write(&p, with_exif(&make_jpeg(800, 400), 6)).unwrap();
        let r = render_jpeg(&p, 200, 85).unwrap();
        assert_eq!((r.width, r.height), (100, 200));
        // 方向 6 = 顺时针转 90°：原来左半边的红色转到上面
        let img = image::load_from_memory(&r.jpeg).unwrap().into_rgb8();
        assert!(img.get_pixel(50, 10)[0] > 150, "{:?}", img.get_pixel(50, 10));
        assert!(img.get_pixel(50, 190)[2] > 150, "{:?}", img.get_pixel(50, 190));
    }

    #[test]
    fn imageio_full_size_when_max_is_zero() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        std::fs::write(&p, make_jpeg(640, 480)).unwrap();
        let r = render_jpeg(&p, 0, 85).unwrap();
        assert_eq!((r.width, r.height), (640, 480));
    }

    #[test]
    fn imageio_size_swaps_for_rotated() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("rot.jpg");
        std::fs::write(&p, with_exif(&make_jpeg(800, 400), 6)).unwrap();
        assert_eq!(image_size(&p), Some((400, 800)));
        let q = dir.path().join("plain.jpg");
        std::fs::write(&q, make_jpeg(800, 400)).unwrap();
        assert_eq!(image_size(&q), Some((800, 400)));
    }

    #[test]
    fn imageio_rejects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.heic");
        std::fs::write(&p, b"definitely not an image").unwrap();
        assert!(render_jpeg(&p, 400, 80).is_err());
    }
}
