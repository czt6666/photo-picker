//! 自然排序：让 IMG_2 排在 IMG_10 前面（逐段比较，数字段按数值比）。

use std::cmp::Ordering;

pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut ai, mut bi) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (ai.peek().copied(), bi.peek().copied()) {
            (None, None) => return a.cmp(b), // 完全“相等”时再按原串定序，保证全序
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(ca), Some(cb)) if ca.is_ascii_digit() && cb.is_ascii_digit() => {
                let na = take_digits(&mut ai);
                let nb = take_digits(&mut bi);
                let (ta, tb) = (na.trim_start_matches('0'), nb.trim_start_matches('0'));
                let ord = ta
                    .len()
                    .cmp(&tb.len())
                    .then_with(|| ta.cmp(tb))
                    .then_with(|| na.len().cmp(&nb.len()));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(ca), Some(cb)) => {
                let ord = ca.to_lowercase().cmp(cb.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                ai.next();
                bi.next();
            }
        }
    }
}

fn take_digits(it: &mut std::iter::Peekable<std::str::Chars<'_>>) -> String {
    let mut s = String::new();
    while let Some(c) = it.peek().copied() {
        if !c.is_ascii_digit() {
            break;
        }
        s.push(c);
        it.next();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_compare_by_value() {
        let mut v = vec!["IMG_10.jpg", "IMG_2.jpg", "IMG_1.jpg", "img_3.JPG"];
        v.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(v, ["IMG_1.jpg", "IMG_2.jpg", "img_3.JPG", "IMG_10.jpg"]);
    }

    #[test]
    fn leading_zeros_and_prefixes() {
        assert_eq!(natural_cmp("a01", "a1"), Ordering::Greater);
        assert_eq!(natural_cmp("a", "a1"), Ordering::Less);
        assert_eq!(natural_cmp("DSC_0099", "DSC_0100"), Ordering::Less);
        assert_eq!(natural_cmp("2024-05-01 旅行", "2024-12-01 回家"), Ordering::Less);
    }
}
