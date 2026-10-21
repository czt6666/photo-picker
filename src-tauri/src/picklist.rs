//! 导入选片清单：把在线选片导出的“原图文件名清单”对回本机照片，好给它们加星标、导出原图去修。
//!
//! 线上只有压缩预览，两边靠文件名对号。清单可以是：
//! - 在线选片下载的 .txt：每行一个相对路径（`外景/DSC_0001.JPG`），`#` 开头的是说明；
//! - 复制来的文件名：`DSC_0001 DSC_0005, IMG_2.jpg`（空格、逗号都行，扩展名可有可无）。
//!
//! 按“去掉扩展名的文件名”匹配（JPG 和 RAW 是同一张）。同名照片在好几个文件夹里都有时，
//! 用清单里的文件夹去区分；区分不了就都算上（宁可多标几张，也别漏掉模特选的）。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::formats::{is_companion, is_supported_ext};
use crate::picasa_ini::norm_name;
use crate::scan::{group_key, Photo};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Entry {
    /// 规范化后的相对文件夹，`/` 分隔；没给就是空
    pub folder: String,
    /// 规范化后的文件名主干（不含扩展名）
    pub stem: String,
    /// 原样，报“没找到”时给人看
    pub raw: String,
}

fn known_ext(ext: &str) -> bool {
    is_supported_ext(ext) || is_companion(ext) || matches!(ext, "heic" | "heif" | "avif")
}

fn entry(token: &str) -> Option<Entry> {
    let token = token.trim().trim_matches('"');
    let token = token.replace('\\', "/");
    let (folder, name) = match token.rsplit_once('/') {
        Some((f, n)) => (f.trim_matches('/'), n),
        None => ("", token.as_str()),
    };
    if name.is_empty() {
        return None;
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let stem = if known_ext(&ext) { group_key(name) } else { norm_name(name) };
    Some(Entry { folder: norm_name(folder), stem, raw: token.to_string() })
}

pub fn parse(text: &str) -> Vec<Entry> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in text.trim_start_matches('\u{feff}').lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // 带路径的一行就是一个文件（路径里可能有空格）；否则按空白/逗号拆成多个文件名
        let tokens: Vec<&str> = if line.contains('/') || line.contains('\\') {
            vec![line]
        } else {
            line.split(|c: char| c.is_whitespace() || matches!(c, ',' | '，' | ';' | '、')).collect()
        };
        for t in tokens {
            if let Some(e) = entry(t) {
                // 同一张的 JPG 和 RAW 两行合成一条
                if seen.insert((e.folder.clone(), e.stem.clone())) {
                    out.push(e);
                }
            }
        }
    }
    out
}

#[derive(Debug, Default, Serialize)]
pub struct MatchResult {
    /// 要加星标的照片（主文件路径）
    pub paths: Vec<String>,
    /// 清单里有、本机找不到的
    pub missing: Vec<String>,
    /// 同名照片在多个文件夹、清单又没法区分，所以都标上了的条数
    pub ambiguous: usize,
}

pub fn match_entries(entries: &[Entry], photos: &[Photo]) -> MatchResult {
    let mut by_stem: HashMap<String, Vec<&Photo>> = HashMap::new();
    for p in photos {
        by_stem.entry(group_key(&p.name)).or_default().push(p);
    }
    let mut res = MatchResult::default();
    let mut picked = HashSet::new();
    for e in entries {
        let Some(cands) = by_stem.get(&e.stem) else {
            res.missing.push(e.raw.clone());
            continue;
        };
        let mut chosen: Vec<&Photo> = cands.clone();
        if cands.len() > 1 {
            let in_folder: Vec<&Photo> = if e.folder.is_empty() {
                vec![]
            } else {
                // 清单里的文件夹是摄影师上传时选的那层往下的相对路径，本机路径以它结尾就算对上
                let suffix = format!("/{}", e.folder);
                cands
                    .iter()
                    .copied()
                    .filter(|p| {
                        let dir = norm_name(&p.dir.replace('\\', "/"));
                        dir.ends_with(&suffix) || dir == e.folder
                    })
                    .collect()
            };
            if in_folder.len() == 1 {
                chosen = in_folder;
            } else {
                if !in_folder.is_empty() {
                    chosen = in_folder;
                }
                res.ambiguous += 1;
            }
        }
        for p in chosen {
            if picked.insert(p.path.clone()) {
                res.paths.push(p.path.clone());
            }
        }
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    fn photo(dir: &str, name: &str) -> Photo {
        Photo {
            path: format!("{dir}/{name}"),
            name: name.into(),
            dir: dir.into(),
            size: 0,
            mtime: 0,
            starred: false,
            rating: 0,
            companions: vec![],
        }
    }

    #[test]
    fn parses_exported_list_and_pasted_names() {
        let text = "\u{feff}# 小林 10.20 外景\n# 3 张\n外景/DSC_0001.JPG\n外景/DSC_0001.NEF\n# 小林: 修瘦\n2024/外景/DSC_0003.JPG\n\nDSC_0005 DSC_0006.jpg, IMG.2024\n";
        let e = parse(text);
        let got: Vec<(&str, &str)> = e.iter().map(|e| (e.folder.as_str(), e.stem.as_str())).collect();
        assert_eq!(
            got,
            vec![("外景", "dsc_0001"), ("2024/外景", "dsc_0003"), ("", "dsc_0005"), ("", "dsc_0006"), ("", "img.2024")]
        );
    }

    #[test]
    fn matches_by_stem_and_uses_folder_to_disambiguate() {
        let photos = vec![
            photo("/Users/a/拍摄/2024/外景", "DSC_0001.JPG"),
            photo("/Users/a/拍摄/2024/棚拍", "DSC_0001.JPG"),
            photo("/Users/a/拍摄/2024/外景", "DSC_0003.NEF"),
            photo("/Users/a/拍摄/2024/外景", "DSC_0005.JPG"),
            photo("/Users/a/拍摄/2024/棚拍", "DSC_0005.JPG"),
        ];
        let r = match_entries(&parse("外景/DSC_0001.JPG\n外景/DSC_0003.JPG\nDSC_0005\nDSC_9999\n"), &photos);
        assert_eq!(
            r.paths,
            vec![
                "/Users/a/拍摄/2024/外景/DSC_0001.JPG",
                // 预览用的 JPG、本机只有 RAW：照样对上
                "/Users/a/拍摄/2024/外景/DSC_0003.NEF",
                // 没给文件夹、两处都有：都标上
                "/Users/a/拍摄/2024/外景/DSC_0005.JPG",
                "/Users/a/拍摄/2024/棚拍/DSC_0005.JPG",
            ]
        );
        assert_eq!(r.ambiguous, 1);
        assert_eq!(r.missing, vec!["DSC_9999"]);
    }

    #[test]
    fn windows_paths_and_case() {
        let photos = vec![photo("D:\\Shoot\\Outdoor", "dsc_0001.jpg"), photo("D:\\Shoot\\Studio", "dsc_0001.jpg")];
        let r = match_entries(&parse("outdoor\\DSC_0001.JPG"), &photos);
        assert_eq!(r.paths, vec!["D:\\Shoot\\Outdoor/dsc_0001.jpg"]);
        assert_eq!(r.ambiguous, 0);
    }
}
