// The manifest as a RECORD — a `Cargo.toml` parsed into structure and rendered back byte-identically.
//
// # Why this is structural and not a text blob
//
// A manifest could be stored as its own source text, and that would round-trip trivially. It would
// also be worthless: 419 of the 1153 dependency entries across this workspace carry PROSE explaining
// why the dependency is there, and that reasoning is load-bearing — `bsc-sqlite-util`'s
// `features = ["conn"]` comment records that backups use `VACUUM INTO` and silently corrupt without
// it. Stored as a blob that rationale is a comment nobody can query; stored as a field it is data
// hanging off the dependency it explains.
//
// So `render` deliberately reconstructs from `key`/`value`/`lead` rather than from a retained raw
// line. Byte-identity is then a property of the MODEL being complete, not of having kept a copy —
// which is the only version of the claim worth making. `manifest_roundtrip_is_byte_identical` proves
// it over every manifest in the repo, and `a_planted_change_is_detected` proves the check can fail.
//
// # The shape this relies on, and what happens when it stops holding
//
// MEASURED across all 81 manifests: no multi-line values, and 13 distinct section kinds. So a
// line-oriented parse is sufficient. A line that is neither blank, comment, section header nor
// `key = value` is UNMODELLED and is a hard error naming the file and line — never a silent skip,
// because a parser that quietly drops a line renders a manifest that is subtly wrong and still
// "round-trips" for every line it did keep.

use std::fmt::Write as _;

/// A comment/blank run preceding an item. This is where the prose lives.
pub type Lead = Vec<String>;

/// One `key = value` line, with the prose that explains it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub key: String,
    /// The value EXACTLY as written, un-parsed — `{ path = "../data", default-features = false }`.
    /// Kept verbatim on purpose: re-quoting a TOML value is a second chance to be wrong about
    /// escaping, and nothing here needs the value's interior.
    pub value: String,
    pub lead: Lead,
}

impl Entry {
    /// The prose attached to this entry, comment markers stripped, blanks dropped.
    pub fn why(&self) -> Option<String> {
        let t: Vec<&str> = self
            .lead
            .iter()
            .filter(|l| l.trim_start().starts_with('#'))
            .map(|l| l.trim_start().trim_start_matches('#').trim())
            .collect();
        if t.is_empty() { None } else { Some(t.join(" ")) }
    }
}

/// One `[section]` and the entries under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// The header as written, including brackets — `[dependencies]`, `[target.'cfg(unix)'.dependencies]`.
    pub name: String,
    pub entries: Vec<Entry>,
    pub lead: Lead,
}

/// A whole `Cargo.toml`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub sections: Vec<Section>,
    /// Comments/blanks after the last entry, so the tail of the file is not lost.
    pub tail: Lead,
    /// Whether the file ended with a newline. Without this, render is off by one byte.
    pub ends_nl: bool,
}

/// A line the model does not cover. Loud by construction — see the module note.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unmodelled {
    pub line_no: usize,
    pub line: String,
}

impl std::fmt::Display for Unmodelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "line {}: {:?} is neither blank, comment, section header nor `key = value`. The manifest \
             model is line-oriented because MEASURED across all 81 manifests there are no multi-line \
             values; this line breaks that assumption and the model must grow before it is stored.",
            self.line_no, self.line
        )
    }
}

/// Is this line a section header? `[deps]` yes; `key = [1]` no.
///
/// The rule is deliberately just "starts with `[` and ends with `]`". An earlier version also
/// required no `=` before the first `]`, which looks safer and is wrong:
/// `[target.'cfg(target_os = "linux")'.dependencies]` — a real header in `bsc-secret` — carries an
/// `=` inside its key. That version mis-read it as a `key = value` pair, and the mis-read was
/// INVISIBLE to a byte-comparison because re-rendering `key = value` happened to reproduce the line
/// exactly. A value line cannot begin with `[`, so nothing needs the extra condition.
fn is_header(s: &str) -> bool {
    s.starts_with('[') && s.ends_with(']')
}

/// Are a value's `{}` and `[]` balanced, ignoring anything inside a double-quoted string?
///
/// This is what detects a value CONTINUED onto the next line. Without it the continuation parses as
/// a second `key = value` pair — `features = ["derive"] }` — and renders back without its original
/// indentation. That is a silent corruption: it survives `tomllib` (the halves still form valid TOML
/// in aggregate) and is caught only by byte-comparison, so it would pass unnoticed on any manifest
/// the round-trip corpus does not happen to include.
fn is_balanced(v: &str) -> bool {
    let (mut curly, mut square, mut in_str, mut esc) = (0i32, 0i32, false, false);
    for c in v.chars() {
        if esc {
            esc = false;
            continue;
        }
        match c {
            '\\' if in_str => esc = true,
            '"' => in_str = !in_str,
            '{' if !in_str => curly += 1,
            '}' if !in_str => curly -= 1,
            '[' if !in_str => square += 1,
            ']' if !in_str => square -= 1,
            _ => {}
        }
        if curly < 0 || square < 0 {
            return false;
        }
    }
    curly == 0 && square == 0 && !in_str
}

impl Manifest {
    /// Parse a manifest. Returns the unmodelled lines rather than guessing at them.
    pub fn parse(text: &str) -> Result<Manifest, Unmodelled> {
        let ends_nl = text.ends_with('\n');
        let mut lines: Vec<&str> = text.split('\n').collect();
        if ends_nl {
            lines.pop();
        }
        let mut sections: Vec<Section> = Vec::new();
        let mut lead: Lead = Vec::new();
        for (i, raw) in lines.iter().enumerate() {
            let s = raw.trim();
            if is_header(s) {
                sections.push(Section { name: s.to_string(), entries: Vec::new(), lead: std::mem::take(&mut lead) });
            } else if s.is_empty() || s.starts_with('#') {
                lead.push((*raw).to_string());
            } else if let Some((k, v)) = s.split_once('=') {
                let Some(cur) = sections.last_mut() else {
                    return Err(Unmodelled { line_no: i + 1, line: (*raw).to_string() });
                };
                if !is_balanced(v.trim()) {
                    return Err(Unmodelled { line_no: i + 1, line: (*raw).to_string() });
                }
                cur.entries.push(Entry {
                    key: k.trim().to_string(),
                    value: v.trim().to_string(),
                    lead: std::mem::take(&mut lead),
                });
            } else {
                return Err(Unmodelled { line_no: i + 1, line: (*raw).to_string() });
            }
        }
        Ok(Manifest { sections, tail: lead, ends_nl })
    }

    /// Render back to TOML from the MODEL — never from a retained raw line. See the module note.
    pub fn render(&self) -> String {
        let mut out = String::new();
        for sec in &self.sections {
            for l in &sec.lead {
                let _ = writeln!(out, "{l}");
            }
            let _ = writeln!(out, "{}", sec.name);
            for e in &sec.entries {
                for l in &e.lead {
                    let _ = writeln!(out, "{l}");
                }
                let _ = writeln!(out, "{} = {}", e.key, e.value);
            }
        }
        for l in &self.tail {
            let _ = writeln!(out, "{l}");
        }
        if !self.ends_nl {
            out.pop();
        }
        out
    }

    /// The named section, if present.
    pub fn section(&self, name: &str) -> Option<&Section> {
        self.sections.iter().find(|s| s.name == name)
    }

    /// One key out of `[package]` — `name`, `edition` — with its quotes stripped.
    pub fn package(&self, key: &str) -> Option<String> {
        let e = self.section("[package]")?.entries.iter().find(|e| e.key == key)?;
        Some(e.value.trim_matches('"').to_string())
    }

    /// Every dependency across `[dependencies]` and any `[target.*.dependencies]`, WITH its prose.
    ///
    /// `[dev-dependencies]` is deliberately separate: it widens only the test build's extern set, and
    /// conflating the two is how a dev-only crate ends up linked into a shipped binary.
    pub fn dependencies(&self) -> Vec<&Entry> {
        self.sections
            .iter()
            .filter(|s| s.name == "[dependencies]" || (s.name.starts_with("[target.") && s.name.ends_with(".dependencies]")))
            .flat_map(|s| s.entries.iter())
            .collect()
    }

    /// The `[dev-dependencies]` entries — extra externs for a `--test` build only.
    pub fn dev_dependencies(&self) -> Vec<&Entry> {
        self.section("[dev-dependencies]").map(|s| s.entries.iter().collect()).unwrap_or_default()
    }

    /// The prose attached to a named dependency, so a rationale is REACHABLE rather than merely present.
    pub fn why(&self, dep: &str) -> Option<String> {
        self.dependencies().into_iter().chain(self.dev_dependencies()).find(|e| e.key == dep)?.why()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every manifest in the repo, so the population is the corpus rather than a fixture.
    fn manifests() -> Vec<(String, String)> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let mut v = Vec::new();
        for e in std::fs::read_dir(root.join("crates")).unwrap().flatten() {
            let p = e.path().join("Cargo.toml");
            if p.is_file() {
                v.push((p.display().to_string(), std::fs::read_to_string(&p).unwrap()));
            }
        }
        let r = root.join("Cargo.toml");
        v.push((r.display().to_string(), std::fs::read_to_string(&r).unwrap()));
        v.sort();
        v
    }

    use std::path::Path;

    #[test]
    fn manifest_roundtrip_is_byte_identical() {
        let all = manifests();
        // A POPULATION FLOOR, not a comment: discovery that silently found nothing would otherwise
        // report a pass over zero manifests, which is this repo's signature failure shape.
        assert!(all.len() >= 80, "expected >=80 manifests, found {} — discovery is broken", all.len());
        for (path, src) in &all {
            let m = Manifest::parse(src).unwrap_or_else(|e| panic!("{path}: {e}"));
            assert_eq!(&m.render(), src, "{path} did not round-trip byte-identically");
        }
    }

    /// The round-trip above is only evidence if it CAN fail. Planting a change must break it.
    #[test]
    fn a_planted_change_is_detected() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let src = std::fs::read_to_string(root.join("crates/plandb/Cargo.toml")).unwrap();
        let anchor = r#"features = ["conn"]"#;
        assert!(src.contains(anchor), "the anchor this bite test plants against is gone; re-aim it");
        let mutated = src.replacen(anchor, "features = []", 1);
        assert_ne!(mutated, src, "planting failed");
        let rendered = Manifest::parse(&mutated).unwrap().render();
        assert_ne!(rendered, src, "the round-trip did NOT notice a planted change — it is inert");
        assert_eq!(rendered, mutated, "the model should reproduce the mutated file exactly");
    }

    /// The 36% of manifest lines that are prose must survive as DATA, not decoration.
    #[test]
    fn prose_is_reachable_by_query() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let src = std::fs::read_to_string(root.join("crates/plandb/Cargo.toml")).unwrap();
        let m = Manifest::parse(&src).unwrap();
        let why = m.why("bsc-sqlite-util").expect("bsc-sqlite-util carries prose and it must be queryable");
        assert!(
            why.contains("conn"),
            "the rationale for `features = [\"conn\"]` is what makes the flag un-droppable; got: {why}"
        );
        assert_eq!(m.package("name").as_deref(), Some("plandb"));
        assert_eq!(m.package("edition").as_deref(), Some("2021"));
    }

    /// A line the model does not cover is an ERROR. A parser that silently skips renders a manifest
    /// that is subtly wrong while every line it kept still round-trips.
    #[test]
    fn an_unmodelled_line_is_an_error() {
        let bad = "[dependencies]\nserde = { version = \"1\",\n  features = [\"derive\"] }\n";
        let err = Manifest::parse(bad).expect_err("a multi-line value must not parse silently");
        assert_eq!(err.line_no, 2, "the error names where the unbalanced value STARTS");
        assert!(format!("{err}").contains("multi-line"), "the error must say what assumption broke");
    }

    /// A key/value before any section header has nowhere to go and must not be dropped.
    #[test]
    fn an_entry_before_any_section_is_an_error() {
        assert!(Manifest::parse("name = \"x\"\n").is_err());
    }
}
