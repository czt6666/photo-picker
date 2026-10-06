//! 把任意支持的图片渲染成“长边不超过 N 像素、已按 EXIF 转正”的 JPEG。
//! 缩略图（N=400）、全屏预览（N≈屏幕像素）、缩图导出都用它。
//!
//! 性能关键：**别把大图完整解码再缩小**。
//! 一张 2400 万像素的 JPEG 完整解码要产出 72MB 像素数据，而我们只要 400 像素宽的缩略图。
//! JPEG 是按 8×8 块做 DCT 压缩的，解码时可以只做 1/2、1/4、1/8 尺寸的反变换（DCT 域缩放），
//! 计算量和内存都成倍下降。
//!
//! - macOS：交给系统 ImageIO（`CGImageSourceCreateThumbnailAtIndex`），它内部就做了上述缩放，
//!   而且有硬件解码，还能处理 HEIC 和各家 RAW。
//! - 其它平台 / ImageIO 失败时：JPEG 用 jpeg-decoder 的 DCT 缩放，其它格式用 image crate 完整解码。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use image::{imageops, DynamicImage, RgbImage};

use crate::formats::{ext_of, is_jpeg, rust_decodable};
use crate::meta::read_orientation;

#[cfg_attr(not(test), allow(dead_code))]
pub struct Rendered {
    pub jpeg: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

/// `max_px == 0` 表示不缩小（全尺寸）。输出长边恰好是 max_px（原图更小则保持原尺寸）。
pub fn render_jpeg(path: &Path, max_px: u32, quality: u8) -> Result<Rendered, String> {
    render(path, max_px, quality, 1.0)
}

/// 屏幕预览用：允许比 max_px 小最多 12%，换来 JPEG 能用更小的 DCT 缩放档直接解码、省掉缩放步骤。
/// （目标尺寸本来就是向上取档的，小一点肉眼看不出来；导出和缩略图要用精确的 [`render_jpeg`]。）
pub fn render_jpeg_for_screen(path: &Path, max_px: u32, quality: u8) -> Result<Rendered, String> {
    render(path, max_px, quality, 0.88)
}

fn render(path: &Path, max_px: u32, quality: u8, tolerance: f64) -> Result<Rendered, String> {
    let ext = ext_of(path).unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        match crate::macos::render_jpeg(path, max_px, quality) {
            Ok(r) => return Ok(r),
            Err(e) if !rust_decodable(&ext) => return Err(e),
            Err(e) => eprintln!("[decode] ImageIO 失败，改用内置解码器：{e}"),
        }
    }
    if !rust_decodable(&ext) {
        return Err(format!("此平台不支持 .{ext} 格式"));
    }
    let img = load_rgb(path, (max_px as f64 * tolerance) as u32)?;
    let img = fit_within(img, max_px);
    let mut out = Vec::with_capacity((img.width() * img.height() / 4) as usize);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality)
        .encode_image(&img)
        .map_err(|e| e.to_string())?;
    Ok(Rendered { width: img.width(), height: img.height(), jpeg: out })
}

/// 解码并转正。`min_long_edge > 0` 时允许解码器偷懒输出更小的图，但长边不小于它。
pub fn load_rgb(path: &Path, min_long_edge: u32) -> Result<RgbImage, String> {
    let ext = ext_of(path).unwrap_or_default();
    if is_jpeg(&ext) {
        match decode_jpeg_scaled(path, min_long_edge) {
            Ok(Some(img)) => return Ok(apply_orientation(img, read_orientation(path))),
            Ok(None) => {} // CMYK 等少见格式，交给 image crate
            Err(e) => eprintln!("[decode] jpeg-decoder 失败，改用通用解码器：{e}"),
        }
    }
    let reader = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    use image::ImageDecoder;
    let orientation = decoder.orientation().unwrap_or(image::metadata::Orientation::NoTransforms);
    let mut img = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img.into_rgb8())
}

/// 用 DCT 域缩放解码 JPEG。返回 None 表示像素格式不常见，调用方应换解码器。
fn decode_jpeg_scaled(path: &Path, min_long_edge: u32) -> Result<Option<RgbImage>, String> {
    let file = File::open(path).map_err(|e| e.to_string())?;
    let mut dec = jpeg_decoder::Decoder::new(BufReader::with_capacity(256 << 10, file));
    dec.read_info().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("无法读取 JPEG 信息")?;
    let (w, h) = (info.width as u32, info.height as u32);
    if min_long_edge > 0 && w.max(h) > min_long_edge {
        // 解码器会挑“结果仍 ≥ 请求尺寸”的最小缩放档（1/8、1/4、1/2、1）
        let f = min_long_edge as f64 / w.max(h) as f64;
        let rw = ((w as f64 * f).ceil() as u16).max(1);
        let rh = ((h as f64 * f).ceil() as u16).max(1);
        dec.scale(rw, rh).map_err(|e| e.to_string())?;
    }
    let pixels = dec.decode().map_err(|e| e.to_string())?;
    let info = dec.info().ok_or("无法读取 JPEG 信息")?;
    let (w, h) = (info.width as u32, info.height as u32);
    Ok(match info.pixel_format {
        jpeg_decoder::PixelFormat::RGB24 => RgbImage::from_raw(w, h, pixels),
        jpeg_decoder::PixelFormat::L8 => {
            image::GrayImage::from_raw(w, h, pixels).map(|g| DynamicImage::ImageLuma8(g).into_rgb8())
        }
        _ => None,
    })
}

/// 按 EXIF 方向转正（1..=8，含镜像）。
pub fn apply_orientation(img: RgbImage, orientation: u16) -> RgbImage {
    match orientation {
        2 => imageops::flip_horizontal(&img),
        3 => imageops::rotate180(&img),
        4 => imageops::flip_vertical(&img),
        5 => imageops::flip_horizontal(&imageops::rotate90(&img)),
        6 => imageops::rotate90(&img),
        7 => imageops::flip_horizontal(&imageops::rotate270(&img)),
        8 => imageops::rotate270(&img),
        _ => img,
    }
}

/// 等比缩小到长边 ≤ max_px（不放大）。
pub fn fit_within(img: RgbImage, max_px: u32) -> RgbImage {
    let (w, h) = img.dimensions();
    if max_px == 0 || w.max(h) <= max_px {
        return img;
    }
    let s = max_px as f64 / w.max(h) as f64;
    let nw = ((w as f64 * s).round() as u32).max(1);
    let nh = ((h as f64 * s).round() as u32).max(1);
    // thumbnail() 是按面积平均的快速缩小，DCT 缩放后剩下的倍数不大（<2 倍），质量足够
    imageops::thumbnail(&img, nw, nh)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::meta::tests::with_exif;

    /// 生成一张“左红右蓝”的测试 JPEG，方便检查方向。
    pub fn make_jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = RgbImage::from_fn(w, h, |x, _| if x < w / 2 { image::Rgb([220, 20, 20]) } else { image::Rgb([20, 20, 220]) });
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn thumbnail_of_large_jpeg_uses_dct_scaling_and_fits() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.jpg");
        std::fs::write(&p, make_jpeg(4000, 3000)).unwrap();
        let r = render_jpeg(&p, 400, 80).unwrap();
        assert_eq!((r.width, r.height), (400, 300));
        let back = image::load_from_memory(&r.jpeg).unwrap();
        assert_eq!((back.width(), back.height()), (400, 300));
    }

    #[test]
    fn exif_orientation_6_rotates_clockwise() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("rot.jpg");
        std::fs::write(&p, with_exif(&make_jpeg(800, 400), 6)).unwrap();
        let r = render_jpeg(&p, 200, 90).unwrap();
        assert_eq!((r.width, r.height), (100, 200), "横图带方向 6 → 竖图");
        // 顺时针转 90° 后，原来的左边（红）到了上面
        let img = image::load_from_memory(&r.jpeg).unwrap().into_rgb8();
        let top = img.get_pixel(50, 10);
        let bottom = img.get_pixel(50, 190);
        assert!(top[0] > 150 && top[2] < 100, "top = {top:?}");
        assert!(bottom[2] > 150 && bottom[0] < 100, "bottom = {bottom:?}");
    }

    #[test]
    fn screen_preview_may_be_slightly_smaller_but_exact_render_is_exact() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("big.jpg");
        std::fs::write(&p, make_jpeg(4000, 2000)).unwrap();
        let exact = render_jpeg(&p, 2048, 80).unwrap();
        assert_eq!((exact.width, exact.height), (2048, 1024));
        let screen = render_jpeg_for_screen(&p, 2048, 80).unwrap();
        assert!(screen.width >= 1800 && screen.width <= 2048, "{}", screen.width);
    }

    #[test]
    fn small_image_is_not_upscaled_and_png_works() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.png");
        RgbImage::from_pixel(120, 80, image::Rgb([1, 2, 3])).save(&p).unwrap();
        let r = render_jpeg(&p, 400, 80).unwrap();
        assert_eq!((r.width, r.height), (120, 80));
    }

    #[test]
    fn corrupt_file_is_an_error_not_a_panic() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.jpg");
        std::fs::write(&p, b"\xFF\xD8\xFF\xE0 not really a jpeg").unwrap();
        assert!(render_jpeg(&p, 400, 80).is_err());
    }
}

/// 手动跑的基准：PP_BENCH_FILE=/path/to/big.jpg cargo test --release bench_render -- --ignored --nocapture
#[cfg(test)]
mod bench {
    use super::*;
    use std::time::Instant;

    #[test]
    #[ignore]
    fn bench_render() {
        let Some(p) = std::env::var_os("PP_BENCH_FILE") else { return };
        let p = std::path::PathBuf::from(p);
        for max in [400u32, 1600, 3200] {
            let t = Instant::now();
            let n = 5;
            for _ in 0..n {
                render_jpeg(&p, max, 88).unwrap();
            }
            println!("max={max}: {:.1} ms/张", t.elapsed().as_secs_f64() * 1000.0 / n as f64);
        }
        let t = Instant::now();
        let img = load_rgb(&p, 1600).unwrap();
        let t_dec = t.elapsed();
        let t = Instant::now();
        let small = fit_within(img, 1600);
        let t_resize = t.elapsed();
        let t = Instant::now();
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 88).encode_image(&small).unwrap();
        println!("分解(1600)：解码 {:?}，缩放 {:?}，编码 {:?}", t_dec, t_resize, t.elapsed());
    }
}
