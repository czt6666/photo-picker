//! 读写 Picasa 的 `.picasa.ini`。
//!
//! Picasa 3 把每个文件夹的星标存在该文件夹下的隐藏文件 `.picasa.ini` 里，格式是普通 INI：
//!
//! ```ini
//! [Picasa]
//! name=2024 旅行
//! [IMG_0001.JPG]
//! star=yes
//! rotate=rotate(1)
//! ```
//!
//! 我们沿用同一格式，好处是：在 Windows 上用 Picasa 标过的星，拷到 Mac 上直接能看到；
//! 文件夹整体移动/拷贝，星标跟着走。
//!
//! 星级（1～5 星，相当于 Lightroom 的星级）是我们自己加的，和星标（相当于 Lightroom 的“选取”）互不相干：
//! 在同一段里另写一行 `rating=N`。Picasa 不认识这个键，会原样留着；有星级没星标的照片就只有 `rating=` 一行。
//!
//! 实现上把文件当成“行数组”编辑，只改 `star=` / `rating=` 这一行（或增删整个空段），
//! 其它内容（人脸、旋转、相册信息等 Picasa 写的东西）原样保留，换行风格（CRLF/LF）也保持不变。

use std::collections::{HashMap, HashSet};

use unicode_normalization::UnicodeNormalization;

#[derive(Debug, Clone, Default)]
pub struct IniDoc {
    lines: Vec<String>,
    crlf: bool,
    bom: bool,
}

/// 文件名比较用的规范形式：Unicode NFC + 小写。
/// macOS 的文件系统大小写不敏感，且老 HFS+ 拷来的文件名可能是 NFD（如带浊点的日文假名），
/// 统一规范化后再比，避免“明明标了星却显示没标”。
pub fn norm_name(s: &str) -> String {
    s.nfc().collect::<String>().to_lowercase()
}

fn section_of(line: &str) -> Option<&str> {
    let t = line.trim();
    if t.len() >= 2 && t.starts_with('[') && t.ends_with(']') {
        Some(&t[1..t.len() - 1])
    } else {
        None
    }
}

fn key_of(line: &str) -> Option<(&str, &str)> {
    let t = line.trim();
    if t.starts_with(';') || t.starts_with('#') {
        return None;
    }
    let (k, v) = t.split_once('=')?;
    Some((k.trim(), v.trim()))
}

fn is_key_line(line: &str, key: &str) -> bool {
    matches!(key_of(line), Some((k, _)) if k.eq_ignore_ascii_case(key))
}

const STAR: &str = "star";
const RATING: &str = "rating";
/// 最高星级
pub const MAX_RATING: u8 = 5;

impl IniDoc {
    pub fn parse(text: &str) -> Self {
        let bom = text.starts_with('\u{feff}');
        let text = text.trim_start_matches('\u{feff}');
        let crlf = text.contains("\r\n");
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
            .collect();
        // split 会在末尾换行后多出一个空串
        if lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        IniDoc { lines, crlf, bom }
    }

    pub fn render(&self) -> String {
        let nl = if self.crlf { "\r\n" } else { "\n" };
        let mut out = String::new();
        if self.bom {
            out.push('\u{feff}');
        }
        for l in &self.lines {
            out.push_str(l);
            out.push_str(nl);
        }
        out
    }

    /// 所有 `star=yes` 的文件名（已规范化，见 [`norm_name`]）。
    pub fn starred(&self) -> Vec<String> {
        let mut out = Vec::new();
        let mut cur: Option<&str> = None;
        for l in &self.lines {
            if let Some(s) = section_of(l) {
                cur = Some(s);
            } else if let (Some(sec), Some((k, v))) = (cur, key_of(l)) {
                if k.eq_ignore_ascii_case("star") && v.eq_ignore_ascii_case("yes") {
                    out.push(norm_name(sec));
                }
            }
        }
        out.sort();
        out.dedup();
        out
    }

    /// 所有带星级的文件：文件名（已规范化，见 [`norm_name`]）→ 1～5。写坏了的值（0、6、字母）不算。
    /// 同一个文件有好几个段时取最高的。
    pub fn ratings(&self) -> HashMap<String, u8> {
        let mut out: HashMap<String, u8> = HashMap::new();
        let mut cur: Option<&str> = None;
        for l in &self.lines {
            if let Some(s) = section_of(l) {
                cur = Some(s);
            } else if let (Some(sec), Some((k, v))) = (cur, key_of(l)) {
                if !k.eq_ignore_ascii_case(RATING) {
                    continue;
                }
                if let Some(r) = v.parse::<u8>().ok().filter(|r| (1..=MAX_RATING).contains(r)) {
                    let e = out.entry(norm_name(sec)).or_insert(0);
                    *e = (*e).max(r);
                }
            }
        }
        out
    }

    /// 从段头 `start` 开始的段的结束行（下一个段头或文件末尾）。
    fn section_end(&self, start: usize) -> usize {
        self.lines[start + 1..]
            .iter()
            .position(|l| section_of(l).is_some())
            .map_or(self.lines.len(), |i| start + 1 + i)
    }

    /// 段 `[file]` 的行范围 [header, end)。
    #[cfg(test)]
    fn section_range(&self, file: &str) -> Option<(usize, usize)> {
        let want = norm_name(file);
        let start = self
            .lines
            .iter()
            .position(|l| section_of(l).is_some_and(|s| norm_name(s) == want))?;
        Some((start, self.section_end(start)))
    }

    /// 设置/取消某个文件的星标。返回内容是否有变化。（正式代码用批量版 [`Self::set_star_many`]）
    #[cfg(test)]
    pub fn set_star(&mut self, file: &str, starred: bool) -> bool {
        match self.section_range(file) {
            Some((start, _)) => self.set_key_at(start, STAR, starred.then_some("yes")),
            None if starred => {
                self.lines.push(format!("[{file}]"));
                self.lines.push("star=yes".into());
                true
            }
            None => false,
        }
    }

    /// 批量设置。逐个调用 [`set_star`] 时每个文件都要从头扫一遍整个文件找段，
    /// 几千张一起打星就是“几千 × 几千行”，要好几秒；这里先建一次“文件名 → 行号”索引，
    /// 已有的段从后往前改（前面的行号不受影响），新段统一追加到末尾。
    pub fn set_star_many(&mut self, files: &[String], starred: bool) -> bool {
        self.set_key_many(files, STAR, starred.then_some("yes"))
    }

    /// 批量设置星级：0 = 清除，1～5 = 星级。只动 `rating=` 这一行，星标不受影响。
    pub fn set_rating_many(&mut self, files: &[String], rating: u8) -> bool {
        let value = (rating > 0).then(|| rating.min(MAX_RATING).to_string());
        self.set_key_many(files, RATING, value.as_deref())
    }

    /// 批量把各文件段里的 `key` 设成 `value`；`None` = 删掉这一行（段里没别的东西了就整段删掉）。
    fn set_key_many(&mut self, files: &[String], key: &str, value: Option<&str>) -> bool {
        let starred = value.is_some();
        // 同一个文件可能有好几个段（例如在 Windows 上改过文件名大小写）：取消时每个段都要清，否则永远“取消不掉”
        let mut index: HashMap<String, Vec<usize>> = HashMap::new();
        for (i, l) in self.lines.iter().enumerate() {
            if let Some(sec) = section_of(l) {
                index.entry(norm_name(sec)).or_default().push(i);
            }
        }
        let mut existing = Vec::new();
        let mut appended = Vec::new();
        let mut seen = HashSet::new();
        for f in files {
            let name = norm_name(f);
            if !seen.insert(name.clone()) {
                continue;
            }
            match index.get(&name) {
                // 加星：第一个段写上就够了。星级读的时候取各段最高的，所以别的段里的旧星级要清掉，否则降不下来
                Some(all) if starred => {
                    existing.push((all[0], true));
                    if key == RATING {
                        existing.extend(all[1..].iter().map(|&i| (i, false)));
                    }
                }
                Some(all) => existing.extend(all.iter().map(|&i| (i, false))),
                None if starred => appended.push(f),
                None => {}
            }
        }
        existing.sort_unstable_by(|a, b| b.0.cmp(&a.0));
        let mut changed = false;
        for (start, set) in existing {
            changed |= self.set_key_at(start, key, if set { value } else { None });
        }
        for f in appended {
            self.lines.push(format!("[{f}]"));
            self.lines.push(format!("{key}={}", value.unwrap_or_default()));
            changed = true;
        }
        changed
    }

    /// 修改从 `start` 行开始的那个段。
    fn set_key_at(&mut self, start: usize, key: &str, value: Option<&str>) -> bool {
        let end = self.section_end(start);
        if let Some(value) = value {
            let want = format!("{key}={value}");
            if let Some(i) = (start + 1..end).find(|&i| is_key_line(&self.lines[i], key)) {
                if self.lines[i].trim() == want {
                    return false;
                }
                self.lines[i] = want;
            } else {
                self.lines.insert(start + 1, want);
            }
            return true;
        }
        let body: Vec<String> = self.lines[start + 1..end].iter().filter(|l| !is_key_line(l, key)).cloned().collect();
        if body.len() + 1 == end - start {
            return false; // 本来就没有这一行
        }
        let has_content = body.iter().any(|l| key_of(l).is_some());
        let replacement: Vec<String> = if has_content {
            std::iter::once(self.lines[start].clone()).chain(body).collect()
        } else {
            Vec::new() // 段里只剩空行/注释，整段删掉
        };
        self.lines.splice(start..end, replacement);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "[Picasa]\r\nname=旅行\r\n[IMG_0001.JPG]\r\nstar=yes\r\nrotate=rotate(1)\r\n[IMG_0002.JPG]\r\nfaces=rect64(1234),ffff\r\n";

    #[test]
    fn reads_stars_from_picasa_file() {
        let d = IniDoc::parse(SAMPLE);
        assert_eq!(d.starred(), vec!["img_0001.jpg"]);
    }

    #[test]
    fn add_star_to_existing_section_keeps_other_keys_and_crlf() {
        let mut d = IniDoc::parse(SAMPLE);
        assert!(d.set_star("IMG_0002.JPG", true));
        let out = d.render();
        assert!(out.contains("[IMG_0002.JPG]\r\nstar=yes\r\nfaces=rect64(1234),ffff\r\n"));
        assert!(out.contains("name=旅行\r\n"));
        assert_eq!(d.starred(), vec!["img_0001.jpg", "img_0002.jpg"]);
    }

    #[test]
    fn add_star_new_section_and_idempotent() {
        let mut d = IniDoc::parse("");
        assert!(d.set_star("a.jpg", true));
        assert!(!d.set_star("A.JPG", true), "大小写不同也视为同一文件，且不重复写");
        assert_eq!(d.render(), "[a.jpg]\nstar=yes\n");
    }

    #[test]
    fn remove_star_keeps_section_with_other_keys() {
        let mut d = IniDoc::parse(SAMPLE);
        assert!(d.set_star("img_0001.jpg", false));
        let out = d.render();
        assert!(out.contains("[IMG_0001.JPG]\r\nrotate=rotate(1)\r\n"));
        assert!(!out.contains("star="));
        assert!(d.starred().is_empty());
    }

    #[test]
    fn remove_star_drops_empty_section() {
        let mut d = IniDoc::parse("[Picasa]\nname=x\n[a.jpg]\nstar=yes\n\n[b.jpg]\nstar=yes\n");
        assert!(d.set_star("a.jpg", false));
        assert_eq!(d.render(), "[Picasa]\nname=x\n[b.jpg]\nstar=yes\n");
        assert!(!d.set_star("a.jpg", false));
        assert!(!d.set_star("nope.jpg", false));
    }

    #[test]
    fn star_value_variants_and_bom() {
        let mut d = IniDoc::parse("\u{feff}[x.jpg]\nStar = YES\n[y.jpg]\nstar=no\n");
        assert_eq!(d.starred(), vec!["x.jpg"]);
        assert!(d.set_star("y.jpg", true));
        assert_eq!(d.starred(), vec!["x.jpg", "y.jpg"]);
        assert!(d.render().starts_with('\u{feff}'));
    }

    #[test]
    fn batch_matches_one_by_one_and_is_fast() {
        let base = "[Picasa]\nname=x\n[a.jpg]\nrotate=rotate(1)\n[b.jpg]\nstar=yes\n[c.jpg]\nstar=yes\nfaces=f\n";
        let names: Vec<String> = ["c.jpg", "A.JPG", "new.jpg", "b.jpg", "new.jpg"].iter().map(|s| s.to_string()).collect();
        for starred in [true, false] {
            let mut one = IniDoc::parse(base);
            let mut many = IniDoc::parse(base);
            let c1 = names.iter().fold(false, |acc, n| one.set_star(n, starred) | acc);
            let c2 = many.set_star_many(&names, starred);
            assert_eq!(c1, c2);
            assert_eq!(one.starred(), many.starred(), "starred={starred}");
        }
        // 4000 个名字批量加星、再全部取消：要在毫秒级完成（逐个查找是平方级，要好几秒）
        let big: Vec<String> = (0..4000).map(|i| format!("IMG_{i:04}.JPG")).collect();
        let mut d = IniDoc::parse("");
        let t = std::time::Instant::now();
        assert!(d.set_star_many(&big, true));
        assert_eq!(d.starred().len(), 4000);
        assert!(d.set_star_many(&big, false));
        assert!(d.starred().is_empty());
        assert!(t.elapsed() < std::time::Duration::from_millis(500), "{:?}", t.elapsed());
    }

    #[test]
    fn unstar_clears_duplicate_sections() {
        let mut d = IniDoc::parse("[IMG_1.JPG]\nstar=yes\n[img_1.jpg]\nstar=yes\nrotate=rotate(1)\n");
        assert!(d.set_star_many(&["IMG_1.JPG".into()], false));
        assert!(d.starred().is_empty(), "{}", d.render());
        assert_eq!(d.render(), "[img_1.jpg]\nrotate=rotate(1)\n");
    }

    #[test]
    fn rating_is_independent_of_the_star() {
        let mut d = IniDoc::parse(SAMPLE);
        assert!(d.ratings().is_empty(), "Picasa 标的星不是星级");
        assert!(d.set_rating_many(&["IMG_0001.JPG".into(), "new.jpg".into()], 4));
        let out = d.render();
        assert!(out.contains("[IMG_0001.JPG]\r\nrating=4\r\nstar=yes\r\nrotate=rotate(1)\r\n"), "{out}");
        assert!(out.ends_with("[new.jpg]\r\nrating=4\r\n"), "{out}");
        // 标星级不会顺带加星标
        assert_eq!(d.starred(), vec!["img_0001.jpg"]);
        assert_eq!((d.ratings()["img_0001.jpg"], d.ratings()["new.jpg"]), (4, 4));
        // 同样的星级再写一次：没有变化；改成别的星级：原地改
        assert!(!d.set_rating_many(&["new.jpg".into()], 4));
        assert!(d.set_rating_many(&["NEW.JPG".into()], 1));
        assert!(d.render().ends_with("[new.jpg]\r\nrating=1\r\n"));
        // 取消星标不动星级，清除星级不动星标
        assert!(d.set_star_many(&["IMG_0001.JPG".into()], false));
        assert_eq!(d.ratings()["img_0001.jpg"], 4);
        assert!(d.set_star_many(&["IMG_0001.JPG".into()], true));
        assert!(d.set_rating_many(&["IMG_0001.JPG".into(), "new.jpg".into()], 0));
        assert_eq!(d.starred(), vec!["img_0001.jpg"]);
        assert!(d.ratings().is_empty());
        // 只剩星级的段，清掉星级后整段删掉
        assert!(!d.render().contains("new.jpg"));
    }

    #[test]
    fn lowering_a_rating_clears_duplicate_sections() {
        let mut d = IniDoc::parse("[IMG_1.JPG]\nrating=2\n[img_1.jpg]\nrating=5\nstar=yes\n");
        assert!(d.set_rating_many(&["IMG_1.JPG".into()], 3));
        assert_eq!(d.ratings()["img_1.jpg"], 3, "{}", d.render());
        assert_eq!(d.starred(), vec!["img_1.jpg"]);
    }

    #[test]
    fn odd_rating_values_are_ignored() {
        let d = IniDoc::parse("[a.jpg]\nstar=yes\nrating=9\n[b.jpg]\nrating=3\n[c.jpg]\nRating = 5\n[d.jpg]\nrating=0\n[e.jpg]\nrating=x\n");
        let r = d.ratings();
        assert_eq!(r.len(), 2, "{r:?}");
        assert_eq!((r["b.jpg"], r["c.jpg"]), (3, 5));
    }

    #[test]
    fn unicode_normalization_matches_nfd_names() {
        // "が" 的 NFD 形式是 か + 浊点组合符
        let nfd = "か\u{3099}.jpg";
        let mut d = IniDoc::parse("[が.jpg]\nstar=yes\n");
        assert_eq!(d.starred(), vec![norm_name(nfd)]);
        assert!(d.set_star(nfd, false));
        assert!(d.starred().is_empty());
    }
}
