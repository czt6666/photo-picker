//! 照片元数据：EXIF 方向、拍摄参数、尺寸；以及导出缩图时把原图 EXIF/ICC“移植”到新 JPEG 里。

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use serde::Serialize;

use crate::formats::ext_of;

/// EXIF 方向（1..=8）。相机竖着拍时，像素其实是横着存的，靠这个标记告诉看图软件“该转 90°”。
pub fn read_orientation(path: &Path) -> u16 {
    let Ok(file) = File::open(path) else { return 1 };
    let Ok(exif) = exif::Reader::new().read_from_container(&mut BufReader::new(file)) else { return 1 };
    exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)
        .and_then(|f| f.value.get_uint(0))
        .map_or(1, |v| if (1..=8).contains(&v) { v as u16 } else { 1 })
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct PhotoInfo {
    /// 按 EXIF 方向转正后的宽高
    pub width: u32,
    pub height: u32,
    pub size: u64,
    pub mtime: i64,
    pub taken: Option<String>,
    pub camera: Option<String>,
    pub lens: Option<String>,
    /// 例如 "f/1.8 · 1/120s · ISO 50 · 26mm"
    pub exposure: Option<String>,
}

pub fn photo_info(path: &Path) -> Result<PhotoInfo, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mut info = PhotoInfo { size: meta.len(), mtime: crate::scan::mtime_ms(&meta), ..Default::default() };
    if let Ok(dim) = imagesize::size(path) {
        info.width = dim.width as u32;
        info.height = dim.height as u32;
    }
    let exif = File::open(path)
        .ok()
        .and_then(|f| exif::Reader::new().read_from_container(&mut BufReader::new(f)).ok());
    let Some(exif) = exif else { return Ok(info) };

    let text = |tag| {
        exif.get_field(tag, exif::In::PRIMARY).map(|f| {
            f.display_value().to_string().trim_matches('"').trim().to_string()
        }).filter(|s| !s.is_empty())
    };
    let orientation = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)).unwrap_or(1);
    // HEIF 的像素尺寸本身已是转正后的（旋转写在容器里），只有 JPEG/TIFF 需要按 EXIF 交换宽高
    let ext = ext_of(path).unwrap_or_default();
    if (5..=8).contains(&orientation) && !matches!(ext.as_str(), "heic" | "heif" | "avif") {
        std::mem::swap(&mut info.width, &mut info.height);
    }
    info.taken = text(exif::Tag::DateTimeOriginal).or_else(|| text(exif::Tag::DateTime));
    let make = text(exif::Tag::Make).unwrap_or_default();
    let model = text(exif::Tag::Model).unwrap_or_default();
    // 很多机型的 Model 已经带了厂商名（"Canon EOS R5"），避免显示成 "Canon Canon EOS R5"
    let first_word = make.split_whitespace().next().unwrap_or("").to_lowercase();
    info.camera = match (make.is_empty(), model.is_empty()) {
        (_, true) if make.is_empty() => None,
        (_, true) => Some(make),
        (true, false) => Some(model),
        _ if model.to_lowercase().starts_with(&first_word) => Some(model),
        _ => Some(format!("{make} {model}")),
    };
    info.lens = text(exif::Tag::LensModel);

    let rational = |tag| match exif.get_field(tag, exif::In::PRIMARY).map(|f| &f.value) {
        Some(exif::Value::Rational(v)) if !v.is_empty() && v[0].denom != 0 => Some((v[0].num, v[0].denom)),
        _ => None,
    };
    let mut parts = Vec::new();
    if let Some((n, d)) = rational(exif::Tag::FNumber) {
        parts.push(format!("f/{}", trim_float(n as f64 / d as f64)));
    }
    if let Some((n, d)) = rational(exif::Tag::ExposureTime) {
        let secs = n as f64 / d as f64;
        parts.push(if secs >= 1.0 || n == 0 { format!("{}s", trim_float(secs)) } else { format!("1/{}s", (1.0 / secs).round()) });
    }
    if let Some(iso) = exif.get_field(exif::Tag::PhotographicSensitivity, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0)) {
        parts.push(format!("ISO {iso}"));
    }
    if let Some((n, d)) = rational(exif::Tag::FocalLength) {
        parts.push(format!("{}mm", trim_float(n as f64 / d as f64)));
    }
    if !parts.is_empty() {
        info.exposure = Some(parts.join(" · "));
    }
    Ok(info)
}

fn trim_float(v: f64) -> String {
    let s = format!("{v:.1}");
    s.strip_suffix(".0").map(str::to_string).unwrap_or(s)
}

// ---------------------------------------------------------------------------
// JPEG 段操作：导出缩图时保留 EXIF（拍摄时间、GPS、相机参数）和 ICC 色彩配置
// ---------------------------------------------------------------------------

/// JPEG 头部各个段的位置：(marker, 段起点, 段终点)。只解析到 SOS（图像数据开始）为止。
fn jpeg_segments(data: &[u8]) -> Vec<(u8, usize, usize)> {
    let mut out = Vec::new();
    if data.len() < 4 || data[0] != 0xFF || data[1] != 0xD8 {
        return out;
    }
    let mut i = 2;
    while i + 4 <= data.len() {
        if data[i] != 0xFF {
            break;
        }
        let marker = data[i + 1];
        match marker {
            0xFF => {
                i += 1; // 填充字节
                continue;
            }
            0x01 | 0xD0..=0xD8 => {
                i += 2; // 无长度的独立标记
                continue;
            }
            0xDA | 0xD9 => break, // SOS / EOI
            _ => {}
        }
        let len = u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
        if len < 2 || i + 2 + len > data.len() {
            break;
        }
        out.push((marker, i, i + 2 + len));
        i += 2 + len;
    }
    out
}

fn is_exif(data: &[u8], seg: &(u8, usize, usize)) -> bool {
    seg.0 == 0xE1 && data[seg.1 + 4..seg.2].starts_with(b"Exif\0\0")
}

fn is_icc(data: &[u8], seg: &(u8, usize, usize)) -> bool {
    seg.0 == 0xE2 && data[seg.1 + 4..seg.2].starts_with(b"ICC_PROFILE\0")
}

/// 把 EXIF 段里 IFD0 的 Orientation 改成 1（导出的像素已经转正，再带着旧方向会被转两次）。
pub fn patch_orientation(app1: &mut [u8]) -> bool {
    const TIFF: usize = 10; // FF E1 + 长度(2) + "Exif\0\0"(6)
    if app1.len() < TIFF + 8 {
        return false;
    }
    let le = match &app1[TIFF..TIFF + 2] {
        b"II" => true,
        b"MM" => false,
        _ => return false,
    };
    let rd16 = |b: &[u8], o: usize| -> Option<u16> {
        let s = b.get(o..o + 2)?;
        Some(if le { u16::from_le_bytes([s[0], s[1]]) } else { u16::from_be_bytes([s[0], s[1]]) })
    };
    let rd32 = |b: &[u8], o: usize| -> Option<u32> {
        let s = b.get(o..o + 4)?;
        let a = [s[0], s[1], s[2], s[3]];
        Some(if le { u32::from_le_bytes(a) } else { u32::from_be_bytes(a) })
    };
    let Some(ifd0) = rd32(app1, TIFF + 4) else { return false };
    let ifd0 = TIFF + ifd0 as usize;
    let Some(count) = rd16(app1, ifd0) else { return false };
    for k in 0..count as usize {
        let e = ifd0 + 2 + k * 12;
        if rd16(app1, e) == Some(0x0112) && rd16(app1, e + 2) == Some(3) {
            let one = if le { 1u16.to_le_bytes() } else { 1u16.to_be_bytes() };
            if let Some(dst) = app1.get_mut(e + 8..e + 10) {
                dst.copy_from_slice(&one);
                return true;
            }
        }
    }
    false
}

/// 读原图 JPEG 的头部（不读整张图，EXIF/ICC 都在前面）。
pub fn read_jpeg_head(path: &Path) -> Vec<u8> {
    let mut buf = Vec::new();
    if let Ok(f) = File::open(path) {
        let _ = f.take(2 << 20).read_to_end(&mut buf);
    }
    buf
}

/// 把原图的 EXIF（方向置 1）和 ICC 配置移植到新编码的 JPEG 里。
/// 新 JPEG 自带 ICC 时（macOS ImageIO 会写）就不再重复放。
pub fn transplant_metadata(src_head: &[u8], out: Vec<u8>) -> Vec<u8> {
    let src_segs = jpeg_segments(src_head);
    let exif = src_segs.iter().find(|s| is_exif(src_head, s)).map(|s| {
        let mut seg = src_head[s.1..s.2].to_vec();
        patch_orientation(&mut seg);
        seg
    });
    let out_segs = jpeg_segments(&out);
    let out_has_icc = out_segs.iter().any(|s| is_icc(&out, s));
    let icc: Vec<&[u8]> = if out_has_icc {
        Vec::new()
    } else {
        src_segs.iter().filter(|s| is_icc(src_head, s)).map(|s| &src_head[s.1..s.2]).collect()
    };
    if exif.is_none() && icc.is_empty() || out.len() < 2 {
        return out;
    }
    let mut res = Vec::with_capacity(out.len() + 70_000);
    res.extend_from_slice(&out[..2]); // SOI
    if let Some(e) = &exif {
        res.extend_from_slice(e);
    }
    for seg in icc {
        res.extend_from_slice(seg);
    }
    // 原输出里自带的 EXIF 段丢掉，其余照抄
    let mut cursor = 2;
    for s in out_segs.iter().filter(|s| is_exif(&out, s)) {
        res.extend_from_slice(&out[cursor..s.1]);
        cursor = s.2;
    }
    res.extend_from_slice(&out[cursor..]);
    res
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// 构造一个最小的 EXIF APP1 段（只有 Orientation 一个字段）。
    pub fn exif_app1(orientation: u16, little_endian: bool) -> Vec<u8> {
        let mut tiff = Vec::new();
        let w16 = |v: u16| if little_endian { v.to_le_bytes() } else { v.to_be_bytes() };
        let w32 = |v: u32| if little_endian { v.to_le_bytes() } else { v.to_be_bytes() };
        tiff.extend_from_slice(if little_endian { b"II" } else { b"MM" });
        tiff.extend_from_slice(&w16(42));
        tiff.extend_from_slice(&w32(8));
        tiff.extend_from_slice(&w16(1)); // 1 个条目
        tiff.extend_from_slice(&w16(0x0112));
        tiff.extend_from_slice(&w16(3));
        tiff.extend_from_slice(&w32(1));
        tiff.extend_from_slice(&w16(orientation));
        tiff.extend_from_slice(&[0, 0]);
        tiff.extend_from_slice(&w32(0)); // 无下一个 IFD
        let mut seg = vec![0xFF, 0xE1];
        let len = (2 + 6 + tiff.len()) as u16;
        seg.extend_from_slice(&len.to_be_bytes());
        seg.extend_from_slice(b"Exif\0\0");
        seg.extend_from_slice(&tiff);
        seg
    }

    /// 在一个 JPEG 的 SOI 后面插入 EXIF 段。
    pub fn with_exif(jpeg: &[u8], orientation: u16) -> Vec<u8> {
        let mut v = jpeg[..2].to_vec();
        v.extend_from_slice(&exif_app1(orientation, false));
        v.extend_from_slice(&jpeg[2..]);
        v
    }

    fn tiny_jpeg() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(4, 2, image::Rgb([200, 10, 10]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn patch_orientation_both_endians() {
        for le in [true, false] {
            let mut seg = exif_app1(6, le);
            assert!(patch_orientation(&mut seg));
            let exif = exif::Reader::new().read_raw(seg[10..].to_vec()).unwrap();
            let o = exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0);
            assert_eq!(o, Some(1));
        }
    }

    #[test]
    fn transplant_keeps_exif_and_decodes() {
        let src = with_exif(&tiny_jpeg(), 6);
        let out = transplant_metadata(&src, tiny_jpeg());
        // 仍是合法 JPEG
        let img = image::load_from_memory(&out).unwrap();
        assert_eq!((img.width(), img.height()), (4, 2));
        // 带上了 EXIF，且方向已重置为 1
        let exif = exif::Reader::new().read_from_container(&mut std::io::Cursor::new(&out)).unwrap();
        assert_eq!(exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY).unwrap().value.get_uint(0), Some(1));
    }

    #[test]
    fn transplant_without_metadata_is_noop() {
        let out = tiny_jpeg();
        assert_eq!(transplant_metadata(&tiny_jpeg(), out.clone()), out);
    }

    #[test]
    fn orientation_and_info_from_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a.jpg");
        std::fs::write(&p, with_exif(&tiny_jpeg(), 6)).unwrap();
        assert_eq!(read_orientation(&p), 6);
        let info = photo_info(&p).unwrap();
        assert_eq!((info.width, info.height), (2, 4), "方向 6 时宽高互换");
    }
}
