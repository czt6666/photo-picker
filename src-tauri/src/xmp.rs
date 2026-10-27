//! 把星级写进照片文件本身的 XMP 元数据（`xmp:Rating`），让 Lightroom、Bridge、Capture One 这些软件也能看到。
//!
//! XMP 是 Adobe 定的一段 XML，几乎所有看图/修图软件都认它的星级字段。放在哪要看格式：
//! - **JPEG**：放在文件里面，一个 APP1 段（以 `http://ns.adobe.com/xap/1.0/\0` 开头）。
//!   Lightroom 对 JPEG 只读文件里面的这段，不认旁边的 .xmp。
//! - **RAW**（NEF、CR3…）：放在旁边同名的 `.xmp` 侧车文件里（`DSC_0001.NEF` → `DSC_0001.xmp`），
//!   RAW 原件一个字节都不动。DNG 例外：它的 XMP 在文件里面，这里不改。
//!
//! 只改 `xmp:Rating` 这一个字段，别的元数据（EXIF、色彩配置、Lightroom 写过的修图参数）原样保留。
//! 0 = 清除：把这个字段删掉（Lightroom 里就是没星级）。
//!
//! 改 JPEG 时：先把新文件完整写到旁边的临时文件，再原地覆盖原文件、删掉临时文件。
//! 原地覆盖（而不是改名替换）是为了保住文件本身：创建时间、权限、macOS 的 Finder 标签都还在；
//! 万一覆盖到一半断电，完整的内容还在临时文件里。修改时间改回原来的，和 `exiftool -P` 一样，
//! 免得照片在按修改时间排序的地方跑位。

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::formats::{ext_of, is_jpeg, is_raw};

const XMP_HEADER: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const XMP_NS: &str = "http://ns.adobe.com/xap/1.0/";
/// 一个 JPEG 段最长 65535 字节（含 2 字节长度），减掉 XMP 头
const MAX_PACKET: usize = 65533 - 29;

/// 这个文件的星级该写到哪：JPEG 写自己，RAW 写侧车，别的格式不写。
pub fn target_for(path: &Path) -> Option<PathBuf> {
    let ext = ext_of(path)?;
    if is_jpeg(&ext) {
        Some(path.to_path_buf())
    } else if is_raw(&ext) && ext != "dng" {
        Some(path.with_extension("xmp"))
    } else {
        None
    }
}

/// 给一张照片（JPEG 或 RAW）写星级。别的格式什么也不做。返回是否真的改了文件。
pub fn write_rating(path: &Path, rating: u8) -> Result<bool, String> {
    let Some(target) = target_for(path) else { return Ok(false) };
    let r = if target == path { write_jpeg(path, rating) } else { write_sidecar(&existing_sidecar(&target), rating) };
    r.map_err(|e| format!("{}：{e}", target.file_name().unwrap_or_default().to_string_lossy()))
}

// ---------------------------------------------------------------------------
// XMP 文本：只改 xmp:Rating
// ---------------------------------------------------------------------------

/// 一个只有星级的最小 XMP 包。
fn new_packet(rating: u8) -> String {
    format!(
        "<?xpacket begin=\"\u{feff}\" id=\"W5M0MpCehiHzreSzNTczkc9d\"?>\n\
<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\n\
 <rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\n\
  <rdf:Description rdf:about=\"\" xmlns:xmp=\"{XMP_NS}\" xmp:Rating=\"{rating}\"/>\n\
 </rdf:RDF>\n\
</x:xmpmeta>\n\
<?xpacket end=\"w\"?>"
    )
}

/// 在一段 XMP 文本里设置星级。原来就是这个值时返回 None（不用写盘）。
/// 认两种写法：属性 `xmp:Rating="3"`，和元素 `<xmp:Rating>3</xmp:Rating>`（Lightroom 两种都写过）。
fn set_in_packet(xml: &str, rating: u8) -> Option<String> {
    let current = find_rating(xml);
    if current.as_ref().map(|c| c.value) == Some(rating) || (current.is_none() && rating == 0) {
        return None;
    }
    if let Some(c) = current {
        let mut out = String::with_capacity(xml.len() + 16);
        out.push_str(&xml[..c.start]);
        if rating > 0 {
            out.push_str(&if c.element { format!("<xmp:Rating>{rating}</xmp:Rating>") } else { format!("xmp:Rating=\"{rating}\"") });
        }
        // 删属性时把前面多出来的空白也去掉
        if rating == 0 && !c.element {
            let trimmed = out.trim_end_matches([' ', '\t', '\n', '\r']).len();
            out.truncate(trimmed);
        }
        out.push_str(&xml[c.end..]);
        return Some(out);
    }
    // 没有星级：加到第一个 rdf:Description 上；它没声明 xmp 前缀就顺手声明
    let at = xml.find("<rdf:Description")?;
    let tag_end = at + xml[at..].find('>')?;
    let mut insert_at = tag_end;
    if xml[..tag_end].ends_with('/') {
        insert_at -= 1;
    }
    let tag = &xml[at..insert_at];
    let ns = if tag.contains("xmlns:xmp=") { String::new() } else { format!(" xmlns:xmp=\"{XMP_NS}\"") };
    Some(format!("{}{ns} xmp:Rating=\"{rating}\"{}", &xml[..insert_at], &xml[insert_at..]))
}

struct Found {
    start: usize,
    end: usize,
    value: u8,
    element: bool,
}

fn find_rating(xml: &str) -> Option<Found> {
    if let Some(i) = xml.find("xmp:Rating=") {
        let q = xml[i + 11..].chars().next()?;
        if q == '"' || q == '\'' {
            let vstart = i + 12;
            let vend = vstart + xml[vstart..].find(q)?;
            return Some(Found { start: i, end: vend + 1, value: parse_rating(&xml[vstart..vend]), element: false });
        }
    }
    let i = xml.find("<xmp:Rating>")?;
    let vstart = i + 12;
    let close = vstart + xml[vstart..].find("</xmp:Rating>")?;
    Some(Found { start: i, end: close + 13, value: parse_rating(&xml[vstart..close]), element: true })
}

/// Lightroom 用 -1 表示“拒绝”，这里不认，当没有星级
fn parse_rating(s: &str) -> u8 {
    s.trim().parse::<f32>().ok().filter(|v| *v > 0.0).map_or(0, |v| v.round().min(5.0) as u8)
}

// ---------------------------------------------------------------------------
// RAW：侧车 .xmp
// ---------------------------------------------------------------------------

/// 已有的侧车可能是大写的 `DSC_0001.XMP`：区分大小写的磁盘上要找到它，别另建一个
fn existing_sidecar(target: &Path) -> PathBuf {
    if target.exists() {
        return target.to_path_buf();
    }
    let (Some(dir), Some(name)) = (target.parent(), target.file_name()) else { return target.to_path_buf() };
    let want = name.to_string_lossy().to_lowercase();
    fs::read_dir(dir)
        .ok()
        .and_then(|rd| rd.flatten().find(|e| e.file_name().to_string_lossy().to_lowercase() == want))
        .map_or_else(|| target.to_path_buf(), |e| e.path())
}

fn write_sidecar(path: &Path, rating: u8) -> io::Result<bool> {
    let xml = match fs::read(path) {
        Ok(b) => String::from_utf8_lossy(&b).into_owned(),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            if rating == 0 {
                return Ok(false);
            }
            let tmp = tmp_path(path);
            fs::write(&tmp, new_packet(rating))?;
            return fs::rename(&tmp, path).map(|_| true).inspect_err(|_| drop(fs::remove_file(&tmp)));
        }
        Err(e) => return Err(e),
    };
    let Some(new) = set_in_packet(&xml, rating) else { return Ok(false) };
    let tmp = tmp_path(path);
    fs::write(&tmp, new)?;
    fs::rename(&tmp, path).map(|_| true).inspect_err(|_| drop(fs::remove_file(&tmp)))
}

// ---------------------------------------------------------------------------
// JPEG：文件里的 APP1 XMP 段
// ---------------------------------------------------------------------------

/// JPEG 头部的段：(标记, 段起点, 段终点)，到图像数据（SOS）为止。
fn segments(b: &[u8]) -> Option<Vec<(u8, usize, usize)>> {
    if b.len() < 4 || b[0] != 0xFF || b[1] != 0xD8 {
        return None;
    }
    let mut out = Vec::new();
    let mut i = 2;
    while i + 4 <= b.len() {
        if b[i] != 0xFF {
            return None;
        }
        let m = b[i + 1];
        if m == 0xFF {
            i += 1; // 填充字节
            continue;
        }
        if m == 0xDA || m == 0xD9 {
            return Some(out);
        }
        if (0xD0..=0xD7).contains(&m) || m == 0x01 {
            i += 2;
            continue;
        }
        let len = u16::from_be_bytes([b[i + 2], b[i + 3]]) as usize;
        if len < 2 || i + 2 + len > b.len() {
            return None;
        }
        out.push((m, i, i + 2 + len));
        i += 2 + len;
    }
    None
}

fn app1_xmp(xml: &str) -> io::Result<Vec<u8>> {
    let body = xml.as_bytes();
    if body.len() > MAX_PACKET {
        return Err(io::Error::other("XMP 太大，写不进一个 JPEG 段"));
    }
    let len = (2 + XMP_HEADER.len() + body.len()) as u16;
    let mut seg = vec![0xFF, 0xE1];
    seg.extend_from_slice(&len.to_be_bytes());
    seg.extend_from_slice(XMP_HEADER);
    seg.extend_from_slice(body);
    Ok(seg)
}

/// 算出改好星级的整个 JPEG。不用改时返回 None。
fn jpeg_with_rating(bytes: &[u8], rating: u8) -> io::Result<Option<Vec<u8>>> {
    let segs = segments(bytes).ok_or_else(|| io::Error::other("不是完整的 JPEG"))?;
    let xmp = segs.iter().find(|(m, s, e)| *m == 0xE1 && bytes[s + 4..*e].starts_with(XMP_HEADER));
    let (cut_start, cut_end, seg) = match xmp {
        Some(&(_, s, e)) => {
            let xml = String::from_utf8_lossy(&bytes[s + 4 + XMP_HEADER.len()..e]);
            match set_in_packet(&xml, rating) {
                Some(new) => (s, e, app1_xmp(&new)?),
                // 有 XMP 段但没有 rdf:Description（不正常）：整段换成新的
                None if find_rating(&xml).is_none() && rating > 0 => (s, e, app1_xmp(&new_packet(rating))?),
                None => return Ok(None),
            }
        }
        None => {
            if rating == 0 {
                return Ok(None);
            }
            // 新段放在 APP0/APP1(EXIF) 后面，和相机、Lightroom 写的位置一致
            let at = segs.iter().take_while(|(m, ..)| *m == 0xE0 || *m == 0xE1).last().map_or(2, |&(_, _, e)| e);
            (at, at, app1_xmp(&new_packet(rating))?)
        }
    };
    let mut out = Vec::with_capacity(bytes.len() + seg.len());
    out.extend_from_slice(&bytes[..cut_start]);
    out.extend_from_slice(&seg);
    out.extend_from_slice(&bytes[cut_end..]);
    Ok(Some(out))
}

fn write_jpeg(path: &Path, rating: u8) -> io::Result<bool> {
    let bytes = fs::read(path)?;
    let Some(out) = jpeg_with_rating(&bytes, rating)? else { return Ok(false) };
    let meta = fs::metadata(path)?;
    let mtime = meta.modified().ok();
    // 1. 完整的新内容先落到临时文件
    let tmp = tmp_path(path);
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&out)?;
        f.sync_all()?;
    }
    // 2. 原地覆盖原文件（文件身份不变），3. 删临时文件
    let r = (|| {
        let mut f = OpenOptions::new().write(true).truncate(true).open(path)?;
        f.write_all(&out)?;
        f.sync_all()?;
        if let Some(t) = mtime {
            let _ = f.set_modified(t);
        }
        Ok(())
    })();
    match r {
        Ok(()) => {
            let _ = fs::remove_file(&tmp);
            Ok(true)
        }
        // 覆盖失败：原文件可能已经被截断，临时文件是完整的，用它恢复
        Err(e) => {
            if fs::rename(&tmp, path).is_err() {
                let _ = fs::remove_file(&tmp);
            }
            Err(e)
        }
    }
}

/// 临时文件放在同一个文件夹（隐藏、名字带进程号），保证和原文件在同一块盘上
fn tmp_path(path: &Path) -> PathBuf {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    path.with_file_name(format!(".{name}.pp-tmp{}", std::process::id()))
}

/// 读一个文件里（或侧车里）的星级，测试和排查用。
#[cfg(test)]
pub fn read_rating(path: &Path) -> u8 {
    let Some(target) = target_for(path) else { return 0 };
    let xml = if target == path {
        let Ok(b) = fs::read(path) else { return 0 };
        let Some(segs) = segments(&b) else { return 0 };
        let Some(&(_, s, e)) = segs.iter().find(|(m, s, e)| *m == 0xE1 && b[s + 4..*e].starts_with(XMP_HEADER)) else { return 0 };
        String::from_utf8_lossy(&b[s + 4 + XMP_HEADER.len()..e]).into_owned()
    } else {
        fs::read_to_string(target).unwrap_or_default()
    };
    find_rating(&xml).map_or(0, |f| f.value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::tests::with_exif;

    fn tiny_jpeg() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(8, 8, image::Rgb([200, 100, 50]));
        let mut out = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).encode_image(&img).unwrap();
        out
    }

    #[test]
    fn packet_edits_only_rating() {
        let lr = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="2" crs:Exposure2012="+0.50">
  </rdf:Description></rdf:RDF></x:xmpmeta>"#;
        let s = set_in_packet(lr, 4).unwrap();
        assert!(s.contains(r#"xmp:Rating="4""#) && s.contains(r#"crs:Exposure2012="+0.50""#));
        assert!(set_in_packet(&s, 4).is_none(), "没变就不写");
        let cleared = set_in_packet(&s, 0).unwrap();
        assert!(!cleared.contains("Rating") && cleared.contains("crs:Exposure2012"));
        // 元素写法
        let el = "<rdf:Description rdf:about=\"\"><xmp:Rating>5</xmp:Rating></rdf:Description>";
        assert_eq!(set_in_packet(el, 1).unwrap(), "<rdf:Description rdf:about=\"\"><xmp:Rating>1</xmp:Rating></rdf:Description>");
        // 没有星级：加属性，没声明前缀就声明
        let bare = "<rdf:Description rdf:about=\"\" xmlns:dc=\"x\"/>";
        let s = set_in_packet(bare, 3).unwrap();
        assert_eq!(s, format!("<rdf:Description rdf:about=\"\" xmlns:dc=\"x\" xmlns:xmp=\"{XMP_NS}\" xmp:Rating=\"3\"/>"));
        assert_eq!(find_rating(&s).unwrap().value, 3);
    }

    #[test]
    fn jpeg_rating_roundtrip_keeps_exif_pixels_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("IMG_1.JPG");
        let orig = with_exif(&tiny_jpeg(), 6);
        fs::write(&p, &orig).unwrap();
        let old = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
        File::options().write(true).open(&p).unwrap().set_modified(old).unwrap();

        assert!(write_rating(&p, 3).unwrap());
        assert_eq!(read_rating(&p), 3);
        let b = fs::read(&p).unwrap();
        assert_eq!(crate::meta::read_orientation(&p), 6, "EXIF 还在");
        assert!(image::load_from_memory(&b).is_ok(), "还是一张能打开的 JPEG");
        assert_eq!(fs::metadata(&p).unwrap().modified().unwrap(), old, "修改时间不变");
        assert!(!write_rating(&p, 3).unwrap(), "没变就不写");
        assert!(write_rating(&p, 5).unwrap());
        assert_eq!(read_rating(&p), 5);
        assert_eq!(b.len(), fs::read(&p).unwrap().len(), "改星级不会越改越大");
        assert!(write_rating(&p, 0).unwrap());
        assert_eq!(read_rating(&p), 0);
        // 图像数据（SOS 之后）一个字节没变
        let tail = |v: &[u8]| v[v.windows(2).position(|w| w == [0xFF, 0xDA]).unwrap()..].to_vec();
        assert_eq!(tail(&fs::read(&p).unwrap()), tail(&orig));
        let leftovers: Vec<_> = fs::read_dir(dir.path()).unwrap().flatten().map(|e| e.file_name()).collect();
        assert_eq!(leftovers.len(), 1, "临时文件删干净了：{leftovers:?}");
    }

    #[test]
    fn raw_goes_to_sidecar_and_keeps_other_fields() {
        let dir = tempfile::tempdir().unwrap();
        let raw = dir.path().join("DSC_0001.NEF");
        fs::write(&raw, b"raw bytes").unwrap();
        assert!(!write_rating(&raw, 0).unwrap(), "没星级又没侧车：什么都不建");
        assert!(write_rating(&raw, 4).unwrap());
        assert_eq!(fs::read(&raw).unwrap(), b"raw bytes", "RAW 原件不动");
        let side = dir.path().join("DSC_0001.xmp");
        assert_eq!(read_rating(&raw), 4);
        // Lightroom 写过修图参数的侧车：只改星级
        fs::write(&side, r#"<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:Rating="1" crs:Temperature="5200"/>"#).unwrap();
        write_rating(&raw, 2).unwrap();
        let text = fs::read_to_string(&side).unwrap();
        assert!(text.contains(r#"xmp:Rating="2""#) && text.contains("crs:Temperature=\"5200\""), "{text}");
        assert!(target_for(&dir.path().join("a.dng")).is_none() && target_for(&dir.path().join("a.png")).is_none());
    }
}
