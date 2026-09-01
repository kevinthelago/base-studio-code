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

/// Which names a module EXPORTS — or `None` when it re-exports a star, because the set is then
/// unknowable from this file alone and a partial answer is worse than no answer.
///
/// `export type { X } from "…"` COUNTS. The `type` keyword between `export` and the brace used to defeat
/// the pattern, so a module re-exporting a type read as not exporting it — which made the retirement
/// guard refuse `treeexplorerpage` for "dropping" `TreeNodeData` that its file exports on the very next
/// line. Harmless in that direction (over-refusal); the dangerous direction is the same miss on the
/// RECORD's side, where an export it really has would not be counted as lost.
///
/// A renamed export takes the name on the MODULE side: `export { a as b }` exports `b`.
pub fn exported_names(raw_src: &str) -> Option<std::collections::BTreeSet<String>> {
    let src = strip_comments(raw_src);
    // A star re-export makes the set unknowable — say so rather than return a subset.
    for line in src.split('\n') {
        let t = line.trim_start();
        if let Some(rest) = t.strip_prefix("export") {
            let rest = rest.trim_start();
            if let Some(after) = rest.strip_prefix('*') {
                if after.trim_start().starts_with("from") {
                    return None;
                }
            }
        }
    }

    let mut out = std::collections::BTreeSet::new();
    const DECLS: [&str; 8] =
        ["function", "const", "let", "var", "class", "interface", "type", "enum"];

    for line in src.split('\n') {
        let t = line.trim_start();
        let Some(rest) = t.strip_prefix("export") else { continue };
        if !rest.starts_with(char::is_whitespace) {
            continue;
        }
        let mut rest = rest.trim_start();
        for kw in ["default", "async"] {
            if let Some(r) = rest.strip_prefix(kw) {
                if r.starts_with(char::is_whitespace) {
                    rest = r.trim_start();
                }
            }
        }
        for kw in DECLS {
            let Some(r) = rest.strip_prefix(kw) else { continue };
            if !r.starts_with(char::is_whitespace) {
                continue;
            }
            let name: String = r
                .trim_start()
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '$')
                .collect();
            // The JS pattern requires an identifier START, so a name beginning with a digit is no match.
            if !name.is_empty() && !name.starts_with(|c: char| c.is_ascii_digit()) {
                out.insert(name);
            }
            break;
        }
    }

    // Brace clauses, which may span lines: `export [type] { a, type B, c as d }`.
    let chars: Vec<char> = src.chars().collect();
    let mut i = 0usize;
    while let Some(rel) = find_line_anchored_export_brace(&chars, i) {
        let (open, close) = rel;
        let inner: String = chars[open + 1..close].iter().collect();
        for part in inner.split(',') {
            let part = part.trim();
            let part = part.strip_prefix("type").map_or(part, |r| {
                if r.starts_with(char::is_whitespace) { r.trim_start() } else { part }
            });
            // `a as b` exports `b` — the MODULE-side name is the last segment.
            let name = part.split_whitespace().last().unwrap_or("").trim();
            if !name.is_empty() {
                out.insert(name.to_string());
            }
        }
        i = close + 1;
    }
    Some(out)
}

/// The next line-anchored `export [type] {` … `}` after `from`, as (open-brace, close-brace) indices.
fn find_line_anchored_export_brace(c: &[char], from: usize) -> Option<(usize, usize)> {
    let n = c.len();
    let mut i = from;
    while i < n {
        // Line-anchored: at input start, or the first non-space thing on its line.
        let at_line_start = i == 0 || {
            let mut k = i;
            let mut ok = false;
            while k > 0 {
                k -= 1;
                match c[k] {
                    '\n' => {
                        ok = true;
                        break;
                    }
                    ' ' | '\t' => continue,
                    _ => break,
                }
            }
            ok || k == 0 && matches!(c[0], ' ' | '\t')
        };
        if at_line_start && c[i..].starts_with(&['e', 'x', 'p', 'o', 'r', 't']) {
            let mut j = i + 6;
            while j < n && (c[j] == ' ' || c[j] == '\t') {
                j += 1;
            }
            if c[j..].starts_with(&['t', 'y', 'p', 'e']) {
                let k = j + 4;
                if k < n && (c[k] == ' ' || c[k] == '\t' || c[k] == '{') {
                    j = k;
                    while j < n && (c[j] == ' ' || c[j] == '\t') {
                        j += 1;
                    }
                }
            }
            if j < n && c[j] == '{' {
                if let Some(off) = c[j..].iter().position(|ch| *ch == '}') {
                    return Some((j, j + off));
                }
            }
        }
        i += 1;
    }
    None
}

/// Does a seed's BODY equal the file it mirrors — exactly, or once both are reduced to code?
///
/// The preamble is stripped first: every migrated record opens with a block the file never had, so a raw
/// comparison reports every one of them as drift.
pub fn seed_matches_file(seed_src_text: &str, file_src: &str) -> bool {
    let file = norm(file_src);
    let (_, body) = split_preamble(&norm(seed_src_text), &file);
    body == file || code_only(&body) == code_only(&file)
}

/// Does a record import a sibling BY RECORD ID — `@/components/<id>` — and which ones?
///
/// There is no physical `@/components/` directory; the runtime loader intercepts the specifier and
/// vendors the sibling's source in its place, so this form is invisible to any check that resolves
/// against the file tree.
pub fn imports_siblings_by_record_id(src_text: &str) -> (bool, Vec<String>) {
    let mut hits: Vec<String> = Vec::new();
    let c: Vec<char> = src_text.chars().collect();
    let n = c.len();
    let mut i = 0usize;
    while i + 4 < n {
        if c[i..].starts_with(&['f', 'r', 'o', 'm']) {
            let mut j = i + 4;
            while j < n && c[j].is_whitespace() {
                j += 1;
            }
            if j < n && matches!(c[j], '"' | '\'' | '`') {
                let q = c[j];
                let start = j + 1;
                if let Some(off) = c[start..].iter().position(|ch| *ch == q) {
                    let spec: String = c[start..start + off].iter().collect();
                    if let Some(id) = spec.strip_prefix("@/components/") {
                        if !id.is_empty()
                            && id.chars().all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
                        {
                            hits.push(spec);
                        }
                    }
                    i = start + off + 1;
                    continue;
                }
            }
        }
        i += 1;
    }
    let mut seen = std::collections::BTreeSet::new();
    let uniq: Vec<String> = hits.into_iter().filter(|h| seen.insert(h.clone())).collect();
    (!uniq.is_empty(), uniq)
}

/// Is `rel_specifier` imported STATICALLY by an app entry — and by which one?
///
/// THE RULE, and why it is its own class. The dev server's pre-transform pass resolves an `@/…` alias to
/// `/src/…` BEFORE the records plugin is installed, so a module an entry imports statically must exist as
/// a FILE however good its record is. Retire one and the app fails to boot with `tsc`, `lint`, `vitest`
/// and `vite build` all green, because only a real boot observes it — `ConsoleGraphHost` was retired and
/// restored for exactly this.
///
/// ONE definition, shared by the tool that DELETES and the census that GRADES. They disagreed before it
/// existed: the census offered four candidates the tool refused, every one for this rule.
///
/// `read` and `exists` are injected so the decision is testable with no filesystem, matching the JS.
pub fn entries_importing_statically(
    repo: &str,
    rel_specifier: &str,
    read: &dyn Fn(&str) -> String,
    exists: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    const ENTRIES: [&str; 2] = ["app/main.tsx", "app/App.tsx"];
    let needle_a = format!("\"@/{rel_specifier}\"");
    let needle_b = format!("'@/{rel_specifier}'");
    ENTRIES
        .iter()
        .filter(|e| exists(&format!("{repo}/src/{e}")))
        .filter(|e| {
            let body = read(&format!("{repo}/src/{e}"));
            body.split('\n').any(|line| {
                let t = line.trim_start();
                // `^\s*import\s+[^;]*from\s+["']@/<spec>["']` — line-anchored, so a comment continuation
                // cannot match, and the specifier must be the WHOLE quoted string.
                t.strip_prefix("import").is_some_and(|r| r.starts_with(char::is_whitespace))
                    && !t.contains(';')
                    && t.contains(" from ")
                    && (t.ends_with(&needle_a) || t.ends_with(&needle_b))
            })
        })
        .map(|e| (*e).to_string())
        .collect()
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

    #[test]
    fn exported_names_matches_the_typescript() {
        let fx = fixture();
        let cases = fx["exports"].as_array().expect("exports[]");
        assert!(cases.len() >= 12, "thin corpus: {}", cases.len());
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let got = exported_names(c["source"].as_str().unwrap());
            match c["names"].as_array() {
                // `null` is the STAR RE-EXPORT case and must stay distinguishable from an empty set —
                // a partial answer about what a module exports is worse than admitting it is unknowable.
                None => assert_eq!(got, None, "expected the unknowable answer — {label}"),
                Some(want) => {
                    let want: Vec<String> =
                        want.iter().map(|v| v.as_str().unwrap().to_string()).collect();
                    let got: Vec<String> = got
                        .unwrap_or_else(|| panic!("unexpected None — {label}"))
                        .into_iter()
                        .collect();
                    assert_eq!(got, want, "{label}");
                }
            }
        }
    }

    #[test]
    fn the_sibling_by_id_and_entry_probes_match_the_typescript() {
        let fx = fixture();
        for c in fx["siblings"].as_array().expect("siblings[]") {
            let label = c["label"].as_str().unwrap();
            let (any, specs) = imports_siblings_by_record_id(c["source"].as_str().unwrap());
            assert_eq!(any, c["any"].as_bool().unwrap(), "any — {label}");
            let want: Vec<String> = c["specifiers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(specs, want, "specifiers — {label}");
        }

        for c in fx["entries"].as_array().expect("entries[]") {
            let label = c["label"].as_str().unwrap();
            let files = c["files"].as_object().unwrap().clone();
            let rel = |p: &str| p.replace("/repo/src/", "");
            let read = |p: &str| {
                files.get(&rel(p)).and_then(|v| v.as_str()).unwrap_or_default().to_string()
            };
            let exists = |p: &str| files.contains_key(&rel(p));
            let got =
                entries_importing_statically("/repo", c["relSpecifier"].as_str().unwrap(), &read, &exists);
            let want: Vec<String> = c["importedBy"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "{label}");
        }
    }

    #[test]
    fn seed_matches_file_matches_the_typescript() {
        let fx = fixture();
        let cases = fx["seedFile"].as_array().expect("seedFile[]");
        assert!(cases.len() >= 4);
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let got =
                seed_matches_file(c["seedSrcText"].as_str().unwrap(), c["fileSrc"].as_str().unwrap());
            assert_eq!(got, c["ok"].as_bool().unwrap(), "{label}");
        }
    }

    /// Each decision function must answer BOTH ways somewhere in the corpus, mirrored from the generator
    /// so a regeneration cannot hollow out either side without both languages noticing.
    #[test]
    fn each_decision_function_answers_both_ways() {
        let fx = fixture();
        let exports = fx["exports"].as_array().unwrap();
        let unknowable = exports.iter().filter(|c| c["names"].is_null()).count();
        let found = exports
            .iter()
            .filter(|c| c["names"].as_array().is_some_and(|a| !a.is_empty()))
            .count();
        let empty = exports
            .iter()
            .filter(|c| c["names"].as_array().is_some_and(std::vec::Vec::is_empty))
            .count();
        assert!(found >= 6, "never found an export — {found}");
        assert!(empty >= 2, "never found an empty module — {empty}");
        assert!(unknowable >= 1, "the star re-export case is missing");

        let sib = fx["siblings"].as_array().unwrap();
        assert!(sib.iter().filter(|c| c["any"].as_bool().unwrap()).count() >= 3);
        assert!(sib.iter().filter(|c| !c["any"].as_bool().unwrap()).count() >= 3);

        let ent = fx["entries"].as_array().unwrap();
        let hit = ent.iter().filter(|c| !c["importedBy"].as_array().unwrap().is_empty()).count();
        let miss = ent.iter().filter(|c| c["importedBy"].as_array().unwrap().is_empty()).count();
        assert!(hit >= 2 && miss >= 2, "hit {hit}, miss {miss}");
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
