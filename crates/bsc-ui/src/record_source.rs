//! How a FILE's source compares to a RECORD's — the primitives every comparison in this repo builds on.
//!
//! Derived from `scripts/lib/recordSource.mjs` and PROVED EQUAL to it through a shared fixture
//! (`recordSource.fixtures.json`), the same shape [`crate::import_scan`] uses. That module's own header
//! states the reason both exist as one implementation rather than two copies: a census that grades a
//! candidate differently from the refresh that fixes it is worse than either being wrong alone. The JS
//! keeps serving `emit-records.mjs` and four gate guards until the whole module has moved, so two
//! implementations proved equal is the intended intermediate state — and the fixture is what keeps it
//! honest rather than aspirational.
//!
//! ## UTF-16 vs char — measured, and it mattered
//!
//! JavaScript indexes strings by UTF-16 code unit; Rust by `char`. Everything inside the Basic
//! Multilingual Plane — the em dashes and arrows this repo's comments are full of — agrees either way.
//! ASTRAL characters do not: an emoji is two units to JS and one char to Rust.
//!
//! That is not theoretical here. The first char-based [`blank_comments`] failed the fixture's
//! `// 🎉 party` case, emitting 10 spaces where the JS emits 11 — and since this function exists to
//! PRESERVE OFFSETS so a scanner finds code at its true position, a one-column drift for the rest of the
//! line is exactly the bug it is meant to prevent. It operates on `u16` units now. The other four
//! primitives are position-agnostic and agree on chars.

/// LF, no trailing whitespace — the byte form every comparison here works in.
pub fn norm(s: &str) -> String {
    s.replace("\r\n", "\n").trim_end().to_string()
}

/// Blank every comment to spaces while PRESERVING newlines and every other offset, so a scanner run over
/// the result finds code at the position it really occupies.
///
/// A string or template literal is skipped whole and left untouched, so a `//` or `/*` inside one is
/// never mistaken for a comment — the false positive that defines this family of bugs. An UNTERMINATED
/// block comment blanks to end of input, which is what the JS does: there is no code after it to protect.
pub fn blank_comments(src: &str) -> String {
    // UTF-16 CODE UNITS, not chars — this function's contract is that every offset in the output is the
    // offset it had in the input, and the JS it must equal indexes by code unit. On an astral character
    // (an emoji) JS blanks TWO units where a char-based pass blanks one, so a char-based port drifts by
    // one column for the rest of the line. The fixture caught it on `// 🎉 party`: 11 spaces against 10.
    let u: Vec<u16> = src.encode_utf16().collect();
    let n = u.len();
    let mut out = u.clone();
    const NL: u16 = b'\n' as u16;
    const SP: u16 = b' ' as u16;
    const SLASH: u16 = b'/' as u16;
    const STAR: u16 = b'*' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let is_quote = |c: u16| c == b'"' as u16 || c == b'\'' as u16 || c == b'`' as u16;

    let mut i = 0usize;
    while i < n {
        let c = u[i];
        if is_quote(c) {
            let q = c;
            i += 1;
            while i < n {
                if u[i] == BACKSLASH {
                    i += 2;
                    continue;
                }
                if u[i] == q {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if c == SLASH && i + 1 < n && u[i + 1] == SLASH {
            let start = i;
            while i < n && u[i] != NL {
                i += 1;
            }
            for slot in &mut out[start..i] {
                if *slot != NL {
                    *slot = SP;
                }
            }
            continue;
        }
        if c == SLASH && i + 1 < n && u[i + 1] == STAR {
            let start = i;
            i += 2;
            while i < n && !(u[i] == STAR && i + 1 < n && u[i + 1] == SLASH) {
                i += 1;
            }
            i = (i + 2).min(n);
            for slot in &mut out[start..i] {
                if *slot != NL {
                    *slot = SP;
                }
            }
            continue;
        }
        i += 1;
    }
    String::from_utf16(&out).expect("blanking replaces units with ASCII spaces, never splitting a pair")
}

/// Remove every comment, keeping a block comment's NEWLINES so line numbers downstream still line up.
///
/// Same string/template handling as [`blank_comments`], and for the same reason. Differs from it in what
/// it leaves behind: this shortens the text, so it is for reading, while `blank_comments` preserves every
/// offset and is for scanning.
pub fn strip_comments(src: &str) -> String {
    let c: Vec<char> = src.chars().collect();
    let n = c.len();
    let mut out = String::with_capacity(src.len());
    let mut i = 0usize;
    while i < n {
        let ch = c[i];
        if ch == '"' || ch == '\'' || ch == '`' {
            let q = ch;
            out.push(ch);
            i += 1;
            while i < n {
                if c[i] == '\\' {
                    // The JS slices two units even at the very end; `.min(n)` reproduces that bound.
                    let end = (i + 2).min(n);
                    out.extend(&c[i..end]);
                    i += 2;
                    continue;
                }
                out.push(c[i]);
                if c[i] == q {
                    i += 1;
                    break;
                }
                i += 1;
            }
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '/' {
            while i < n && c[i] != '\n' {
                i += 1; // to end of line; the \n is copied on the next pass
            }
            continue;
        }
        if ch == '/' && i + 1 < n && c[i + 1] == '*' {
            i += 2;
            while i < n && !(c[i] == '*' && i + 1 < n && c[i + 1] == '/') {
                if c[i] == '\n' {
                    out.push('\n');
                }
                i += 1;
            }
            i += 2;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// Comments out, whitespace collapsed to single spaces, trimmed — the shape two BODIES are compared in,
/// so that reformatting alone never reads as drift.
///
/// The line-comment pass requires the `//` to be preceded by start-of-input or a NON-COLON character.
/// That guard is load-bearing: without it `https://…` inside a string is a comment and the rest of the
/// line disappears.
pub fn code_only(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let c: Vec<char> = s.chars().collect();
    let n = c.len();
    let mut i = 0usize;
    // Pass 1 — block comments to a single space (non-greedy, exactly like `/\/\*[\s\S]*?\*\//g`).
    while i < n {
        if c[i] == '/' && i + 1 < n && c[i + 1] == '*' {
            let mut j = i + 2;
            let mut closed = false;
            while j < n {
                if c[j] == '*' && j + 1 < n && c[j + 1] == '/' {
                    closed = true;
                    break;
                }
                j += 1;
            }
            if closed {
                out.push(' ');
                i = j + 2;
                continue;
            }
        }
        out.push(c[i]);
        i += 1;
    }
    // Pass 2 — `(^|[^:])//[^\n]*` to `$1 `.
    let c: Vec<char> = out.chars().collect();
    let n = c.len();
    let mut two = String::with_capacity(out.len());
    let mut i = 0usize;
    while i < n {
        let at_start = i == 0;
        let prev_ok = at_start || c[i - 1] != ':';
        // The regex consumes the preceding character too, so a match cannot start at the character that
        // was already consumed as `$1` — mirrored here by only testing a `//` the scan has reached.
        if c[i] == '/' && i + 1 < n && c[i + 1] == '/' && prev_ok {
            two.push(' ');
            while i < n && c[i] != '\n' {
                i += 1;
            }
            continue;
        }
        two.push(c[i]);
        i += 1;
    }
    // Pass 3 — collapse every whitespace run to one space, then trim.
    let mut three = String::with_capacity(two.len());
    let mut in_ws = false;
    for ch in two.chars() {
        if ch.is_whitespace() {
            if !in_ws {
                three.push(' ');
                in_ws = true;
            }
        } else {
            three.push(ch);
            in_ws = false;
        }
    }
    three.trim().to_string()
}

/// Split a record's source into `(preamble, body)` at the first line the FILE also contains.
///
/// Every migrated record opens with an "AS GRAPH SOURCE" block the file never had. Overwriting `srcText`
/// with the raw file DELETES it — that happened, and four records shrank when the change only meant to
/// add attributes.
///
/// THE FILE'S FIRST LINE IS TRIED BEFORE THE HEURISTIC, and that ordering is not cosmetic. The scan below
/// requires a matched line to be longer than 8 characters so a coincidental `}` or `);` cannot eat real
/// code — but a file OPENING with a JSDoc block starts with `/**`, three characters, which fails that
/// filter. The split then landed on line 2, classified the record's own `/**` as preamble, and the body
/// differed from the file by exactly one line: six records were held back as spurious drift,
/// `plannerCore/hash` among them, itself blocking three more modules.
pub fn split_preamble(record_src: &str, file_src: &str) -> (String, String) {
    let lines: Vec<&str> = record_src.split('\n').collect();
    let file_first = file_src.split('\n').next().unwrap_or("");
    if !file_first.is_empty() {
        if let Some(at) = lines.iter().position(|l| *l == file_first) {
            if at < 60 {
                return (lines[..at].join("\n"), lines[at..].join("\n"));
            }
        }
    }
    let file_lines: std::collections::HashSet<&str> = file_src
        .split('\n')
        .map(str::trim)
        .filter(|l| l.chars().count() > 8)
        .collect();
    for (i, line) in lines.iter().enumerate().take(60) {
        let t = line.trim();
        if t.chars().count() > 8 && file_lines.contains(t) {
            return (lines[..i].join("\n"), lines[i..].join("\n"));
        }
    }
    (String::new(), record_src.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The corpus is the TypeScript's OWN recorded answers, generated by
    /// `recordSource.fixtures.gen.test.ts`. Reading it — rather than restating expectations here — is
    /// what makes this a parity proof instead of two independently-written test suites that can both be
    /// confidently wrong in the same place.
    fn fixture() -> Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/shared/lib/runtime/shadow/recordSource.fixtures.json");
        let body = std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("{}: {e} — run UPDATE_FIXTURES=1 on the .gen.test.ts", p.display()));
        serde_json::from_str(&body).expect("the fixture is valid JSON")
    }

    #[test]
    fn every_primitive_matches_the_typescript_case_for_case() {
        let fx = fixture();
        let cases = fx["cases"].as_array().expect("cases[]");
        assert!(cases.len() >= 20, "a thin corpus proves little: {}", cases.len());

        let mut checked = 0usize;
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let src = c["source"].as_str().unwrap();
            let expect = |k: &str| c[k].as_str().unwrap().to_string();
            assert_eq!(norm(src), expect("norm"), "norm — {label}");
            assert_eq!(blank_comments(src), expect("blankComments"), "blankComments — {label}");
            assert_eq!(strip_comments(src), expect("stripComments"), "stripComments — {label}");
            assert_eq!(code_only(src), expect("codeOnly"), "codeOnly — {label}");
            checked += 1;
        }
        assert_eq!(checked, cases.len(), "every case must be asserted, not skipped");
    }

    #[test]
    fn split_preamble_matches_the_typescript_pair_for_pair() {
        let fx = fixture();
        let pairs = fx["pairs"].as_array().expect("pairs[]");
        assert!(pairs.len() >= 4, "too few pairs: {}", pairs.len());
        for p in pairs {
            let label = p["label"].as_str().unwrap();
            let (pre, body) =
                split_preamble(p["recordSrc"].as_str().unwrap(), p["fileSrc"].as_str().unwrap());
            assert_eq!(pre, p["preamble"].as_str().unwrap(), "preamble — {label}");
            assert_eq!(body, p["body"].as_str().unwrap(), "body — {label}");
        }
    }

    /// The corpus must keep BOTH directions, or a later regeneration could quietly turn this into a test
    /// that only proves the functions do something.
    #[test]
    fn the_corpus_still_carries_both_directions() {
        let fx = fixture();
        let cases = fx["cases"].as_array().unwrap();
        let srcs: Vec<&str> = cases.iter().map(|c| c["source"].as_str().unwrap()).collect();
        let changed = srcs.iter().filter(|s| blank_comments(s) != ***s).count();
        let untouched = srcs.iter().filter(|s| blank_comments(s) == ***s).count();
        assert!(changed >= 8, "nothing was blanked — {changed}");
        assert!(untouched >= 4, "plain code must survive untouched — {untouched}");

        let pairs = fx["pairs"].as_array().unwrap();
        let split = pairs.iter().filter(|p| !p["preamble"].as_str().unwrap().is_empty()).count();
        let declined = pairs.iter().filter(|p| p["preamble"].as_str().unwrap().is_empty()).count();
        assert!(split >= 2 && declined >= 2, "split {split}, declined {declined}");
    }
}
