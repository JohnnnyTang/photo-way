//! Escaping rules of `docs/DATA_CONTRACT.md` §2.1.
//!
//! Special characters are built from code points so this file holds no escape sequences.

const BACKSLASH: char = 92u8 as char;
const LINE_SEP: char = match char::from_u32(0x2028) {
    Some(c) => c,
    None => ' ',
};
const PARA_SEP: char = match char::from_u32(0x2029) {
    Some(c) => c,
    None => ' ',
};

fn unicode_escape(c: char) -> String {
    format!("{BACKSLASH}u{:04x}", c as u32)
}

/// `& < > " '` for text and attribute values.
pub fn html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            c if c as u32 == 39 => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// JSON for a `<script>` body or a `.js` file: `<` and U+2028/U+2029 become `\uXXXX` escapes,
/// so neither `</script>` nor `<!--` can occur and the text is valid JavaScript.
pub fn json(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 16);
    for c in s.chars() {
        if c == '<' || c == LINE_SEP || c == PARA_SEP {
            out.push_str(&unicode_escape(c));
        } else {
            out.push(c);
        }
    }
    out
}

/// Inlined code: every `</script` / `</style` (any case) becomes `<\/script` / `<\/style`.
/// `tag` is the lowercase tag name.
pub fn code(src: &[u8], tag: &str) -> Vec<u8> {
    let tag = tag.as_bytes();
    let mut out = Vec::with_capacity(src.len() + 16);
    let mut i = 0;
    while i < src.len() {
        let b = src[i];
        if b == b'<'
            && src.get(i + 1) == Some(&b'/')
            && src
                .get(i + 2..i + 2 + tag.len())
                .is_some_and(|t| t.eq_ignore_ascii_case(tag))
        {
            out.extend_from_slice(&[b'<', BACKSLASH as u8, b'/']);
            i += 2;
        } else {
            out.push(b);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn json_escapes_lt_and_separators() {
        let s = format!("a<b{LINE_SEP}{PARA_SEP}");
        let bs = BACKSLASH;
        assert_eq!(json(&s), format!("a{bs}u003cb{bs}u2028{bs}u2029"));
    }

    #[test]
    fn code_breaks_close_tags_case_insensitively() {
        let out = code(b"x</ScRiPt>y</script", "script");
        assert_eq!(
            out,
            [&b"x<"[..], &[92u8], &b"/ScRiPt>y<"[..], &[92u8], &b"/script"[..]].concat()
        );
        assert_eq!(code(b"</style>", "script"), b"</style>");
    }

    #[test]
    fn html_escapes_five() {
        let apos = char::from(39u8);
        let quote = char::from(34u8);
        assert_eq!(html(&format!("&<>{quote}{apos}")), "&amp;&lt;&gt;&quot;&#39;");
    }
}
