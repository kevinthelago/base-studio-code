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
use std::path::{Path, PathBuf};

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
    /// The CONTINUATION lines of a value spread over several lines, verbatim and with their own
    /// indentation. `src-tauri` has one: `windows-sys = { version = "0.61", features = [` runs to a
    /// closing `] }` three lines later.
    ///
    /// Stored raw rather than reflowed because the indentation is the only thing making the rendered
    /// file byte-identical, and there is no formatting decision here that we would want to own.
    pub cont: Vec<String>,
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
        let mut i = 0usize;
        while i < lines.len() {
            let raw = lines[i];
            let s = raw.trim();
            if is_header(s) {
                sections.push(Section { name: s.to_string(), entries: Vec::new(), lead: std::mem::take(&mut lead) });
            } else if s.is_empty() || s.starts_with('#') {
                lead.push(raw.to_string());
            } else if let Some((k, v)) = s.split_once('=') {
                let started_at = i;
                if sections.last().is_none() {
                    return Err(Unmodelled { line_no: i + 1, line: raw.to_string() });
                }
                // A value whose brackets do not close continues onto the following lines. Consume them
                // VERBATIM until the whole thing balances; running out of file is an error rather than
                // an implicit close, because a truncated value would render as valid-looking TOML that
                // says something different.
                let value = v.trim().to_string();
                let mut cont: Vec<String> = Vec::new();
                while !is_balanced(&std::iter::once(value.as_str())
                    .chain(cont.iter().map(String::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"))
                {
                    i += 1;
                    if i >= lines.len() {
                        return Err(Unmodelled { line_no: started_at + 1, line: lines[started_at].to_string() });
                    }
                    cont.push(lines[i].to_string());
                }
                let cur = sections.last_mut().expect("checked above");
                cur.entries.push(Entry {
                    key: k.trim().to_string(),
                    value,
                    cont,
                    lead: std::mem::take(&mut lead),
                });
            } else {
                return Err(Unmodelled { line_no: i + 1, line: raw.to_string() });
            }
            i += 1;
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
                for c in &e.cont {
                    let _ = writeln!(out, "{c}");
                }
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

// ── The record form ─────────────────────────────────────────────────────────────────────────────
//
// The stored record is the LOSSLESS manifest, not the `CrateRecord` projection. Storing the
// projection would be smaller and would also be a second source of truth: the projection cannot
// reproduce the file, so the file would have to stay authoritative and the record would be a
// description of it that drifts. Storing the manifest means the record can regenerate the file
// byte-for-byte, and the projection is derived on read.
//
// Serialized by hand through `serde_json::Value` rather than with derives, because this crate is a
// build-dependency of 74 others and its manifest says so in as many words — "LEAN ON PURPOSE:
// serde_json and nothing else". Adding `serde` with `derive` here would put a proc-macro in front of
// every one of those builds.

impl Manifest {
    /// The record body for this manifest.
    pub fn to_json(&self, src: &str) -> serde_json::Value {
        let secs: Vec<serde_json::Value> = self
            .sections
            .iter()
            .map(|s| {
                serde_json::json!({
                    "name": s.name,
                    "lead": s.lead,
                    "entries": s.entries.iter().map(|e| serde_json::json!({
                        "key": e.key, "value": e.value, "cont": e.cont, "lead": e.lead,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        serde_json::json!({
            "src": src,
            "kind": "manifest",
            "sections": secs,
            "tail": self.tail,
            "endsNewline": self.ends_nl,
        })
    }

    /// Read a manifest back out of its record.
    ///
    /// Every field is REQUIRED. A tolerant reader that defaulted a missing `endsNewline` would render
    /// a file one byte different from its source and pass every check that is not byte-exact.
    pub fn from_json(v: &serde_json::Value) -> Result<Manifest, String> {
        let strs = |v: Option<&serde_json::Value>, what: &str| -> Result<Vec<String>, String> {
            v.and_then(|x| x.as_array())
                .ok_or_else(|| format!("record is missing the `{what}` array"))?
                .iter()
                .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("`{what}` holds a non-string")))
                .collect()
        };
        let secs = v
            .get("sections")
            .and_then(|x| x.as_array())
            .ok_or("record is missing the `sections` array")?;
        let mut sections = Vec::new();
        for s in secs {
            let name = s.get("name").and_then(|x| x.as_str()).ok_or("a section has no `name`")?.to_string();
            let lead = strs(s.get("lead"), "lead")?;
            let mut entries = Vec::new();
            for e in s.get("entries").and_then(|x| x.as_array()).ok_or("a section has no `entries`")? {
                entries.push(Entry {
                    key: e.get("key").and_then(|x| x.as_str()).ok_or("an entry has no `key`")?.to_string(),
                    value: e
                        .get("value")
                        .and_then(|x| x.as_str())
                        .ok_or("an entry has no `value`")?
                        .to_string(),
                    cont: strs(e.get("cont"), "cont")?,
                    lead: strs(e.get("lead"), "lead")?,
                });
            }
            sections.push(Section { name, entries, lead });
        }
        Ok(Manifest {
            sections,
            tail: strs(v.get("tail"), "tail")?,
            ends_nl: v
                .get("endsNewline")
                .and_then(|x| x.as_bool())
                .ok_or("record is missing `endsNewline` — defaulting it renders a file one byte off")?,
        })
    }
}

/// Build order for a set of crates: every crate after the first-party crates it depends on.
///
/// Cargo derives this from the manifests it reads; a driver that replaces cargo must derive it too.
/// It is cheap here — MEASURED, the first-party graph is 8 deep at its worst and mostly 2 — but a
/// CYCLE must be an error rather than an arbitrary order, because the arbitrary order compiles
/// something and produces a link failure that names neither crate in the cycle.
pub fn topo_order(crates: &[CrateRecord]) -> Result<Vec<String>, String> {
    use std::collections::{HashMap, HashSet};
    let by_name: HashMap<&str, &CrateRecord> = crates.iter().map(|c| (c.name.as_str(), c)).collect();
    let mut order: Vec<String> = Vec::new();
    let mut done: HashSet<String> = HashSet::new();
    // Iterative rather than recursive: `visit` on a cycle recurses until the stack ends, and a stack
    // overflow is a worse diagnostic than the error this returns.
    let mut progress = true;
    while progress && done.len() < crates.len() {
        progress = false;
        for c in crates {
            if done.contains(&c.name) {
                continue;
            }
            let ready = c
                .first_party_deps()
                .iter()
                .all(|d| !by_name.contains_key(d.name.as_str()) || done.contains(&d.name));
            if ready {
                done.insert(c.name.clone());
                order.push(c.name.clone());
                progress = true;
            }
        }
    }
    if done.len() != crates.len() {
        let stuck: Vec<&str> =
            crates.iter().filter(|c| !done.contains(&c.name)).map(|c| c.name.as_str()).collect();
        return Err(format!(
            "dependency cycle among {} crate(s): {stuck:?} — no build order exists, and picking one              anyway produces a link failure that names neither crate in the cycle",
            stuck.len()
        ));
    }
    Ok(order)
}

// ── Where manifest records live, and why NOT beside the implementations ─────────────────────────
//
// `graph/manifests/`, a sibling of `graph/records/` — deliberately, on evidence.
//
// `graph/records/` was tried first and is unsafe for this. Two independent reasons, both measured
// rather than reasoned about:
//
//  1. EVERY file there is appended to the store's `implementations` array by `load_merged_store`. A
//     Cargo.toml is not an implementation: it has no `code`, `tech`, `role`, `provides` or `feature`,
//     so it would appear as a malformed implementation to every consumer that iterates them — the
//     census, doctor, dedup, method extraction and the Algorithms page. (An `id` alone is enough to
//     satisfy the store's own parse guard; all 506 `bsc-graph` tests pass with one present. The
//     objection is a category error, not a crash.)
//  2. IT WOULD NOT SURVIVE. `bsc_graph::repo_store::write_at` says it plainly: "any record file whose
//     id is no longer in the document is removed". Manifest records exist only in the repo store and
//     never in the runtime ledger, so the next `bsc algorithms` write by ANY session on the box would
//     delete all 80 — silently, and long after whoever wrote them had moved on.
//
// A sibling directory is swept by nothing and merged into nothing, so both problems disappear rather
// than being managed.

/// The record name for the workspace manifest, which has no crate directory. Leading underscore so
/// it sorts before every crate and cannot collide with one — a crate directory cannot start with `_`
/// and also be a valid package name.
pub const WORKSPACE: &str = "_workspace";

/// The app crate, a workspace member that does not live under `crates/`.
pub const APP: &str = "src-tauri";

/// The directory holding one manifest record per crate.
pub fn manifests_dir(repo_root: &Path) -> PathBuf {
    repo_root.join("graph").join("manifests")
}

/// The record file for one crate directory.
fn manifest_record_path(repo_root: &Path, crate_dir: &str) -> PathBuf {
    manifests_dir(repo_root).join(format!("{crate_dir}.json"))
}

/// What a sync did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    pub written: Vec<String>,
    pub unchanged: Vec<String>,
    pub removed: Vec<String>,
}

/// Rebuild a document with every object's keys in sorted order.
///
/// THIS IS NOT COSMETIC. `serde_json::Value` is a `BTreeMap` (sorted) normally and an `IndexMap`
/// (insertion-ordered) when the `preserve_order` feature is on. Four crates here enable it —
/// `bsc-graph`, `bsc-graph-store`, `bsc-json-store`, `bsc-ui` — each documenting it as load-bearing,
/// and cargo unifies features per INVOCATION. So the same `to_string_pretty` call emits sorted keys
/// under `cargo run -p graph-materialize` and insertion-ordered keys under `cargo nextest run
/// --workspace`: the bytes on disk depended on which command wrote them.
///
/// MEASURED 2026-09-09: the two encodings of the workspace record were both 11313 bytes and differed
/// at byte 5, which is why the length check in a hand-written comparison would not have caught it.
/// Sorting explicitly makes the format identical under both, so a record written by one command is
/// byte-identical to one written by the other.
fn canonicalize(v: &serde_json::Value) -> serde_json::Value {
    match v {
        serde_json::Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            let mut out = serde_json::Map::new();
            for k in keys {
                out.insert(k.clone(), canonicalize(&m[k.as_str()]));
            }
            serde_json::Value::Object(out)
        }
        serde_json::Value::Array(a) => serde_json::Value::Array(a.iter().map(canonicalize).collect()),
        other => other.clone(),
    }
}

/// The committed on-disk format: two-space pretty JSON, keys sorted, one trailing newline.
fn encode(v: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string_pretty(&canonicalize(v))
        .map(|s| s + "\n")
        .map_err(|e| format!("cannot serialize: {e}"))
}

/// Options for [`sync_records`].
#[derive(Debug, Clone, Copy, Default)]
pub struct SyncOptions {
    pub dry_run: bool,
    /// Delete a record whose manifest is absent from disk.
    ///
    /// OFF by default, and that default is load-bearing. See the refusal in [`sync_records`].
    pub prune: bool,
}

/// IMPORT manifests into records — the MIGRATION direction, file to record.
///
/// This is not the authoring path and must not be used as one. The records are the source of truth
/// and `Cargo.toml` is generated from them (`scripts/emit-manifests.mjs`); this exists to bring an
/// existing file INTO the store, which is how the original 82 were created and how a vendored crate
/// would arrive. To create a crate, write a RECORD — see [`new_crate_record`].
///
/// # It refuses rather than prunes, and that refusal prevents total data loss
///
/// A file-derived sync CANNOT distinguish "this crate was deleted" from "this crate has not been
/// emitted yet". Since the flip those are the same observation — a missing `Cargo.toml` — and they
/// want opposite actions.
///
/// MEASURED 2026-09-09 on a fresh-clone-shaped tree: 56 of 80 crate directories contain nothing but
/// their (now untracked) manifest, so those directories DO NOT EXIST in a fresh checkout at all. An
/// earlier version of this function removed records for crates it could not find, and in that tree it
/// reported `78 removed` — of 82 records that are now the only copy of the manifest. So a missing
/// manifest is a REFUSAL by default, and pruning is opt-in for the caller who has actually deleted a
/// crate and can say so.
pub fn sync_records(repo_root: &Path, opts: SyncOptions) -> Result<SyncReport, String> {
    let dry_run = opts.dry_run;
    let dir = manifests_dir(repo_root);
    if !dry_run {
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    let mut report = SyncReport::default();
    let mut seen: Vec<String> = Vec::new();

    let crates = repo_root.join("crates");
    let mut dirs: Vec<String> = std::fs::read_dir(&crates)
        .map_err(|e| format!("cannot read {}: {e}", crates.display()))?
        .flatten()
        .filter(|e| e.path().join("Cargo.toml").is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    dirs.sort();

    // The WORKSPACE manifest is the 81st and carries the most prose in the repo — the whole
    // `[profile.dev]` reasoning, plus the hand-maintained `members` list. Excluding it because it is
    // not under `crates/` would leave the one manifest whose comments are most load-bearing as the
    // only file with no record.
    let mut dirs: Vec<String> = dirs;
    dirs.insert(0, WORKSPACE.to_string());
    // `src-tauri` is a workspace member like any other, it just does not live under `crates/`. Leaving
    // it out would make the migration 81-of-82 and leave the app's own manifest as the one file still
    // authoritative over its record — the exact split this change exists to remove.
    if repo_root.join(APP).join("Cargo.toml").is_file() {
        dirs.insert(1, APP.to_string());
    }

    for d in dirs {
        let toml = match d.as_str() {
            WORKSPACE => repo_root.join("Cargo.toml"),
            APP => repo_root.join(APP).join("Cargo.toml"),
            _ => crates.join(&d).join("Cargo.toml"),
        };
        // A manifest that is not on disk is simply not IMPORTED — it is not an error here. Since the
        // flip that is the normal state of a fresh checkout, and erroring would replace the refusal
        // below (which explains the situation and how to fix it) with a bare "cannot read Cargo.toml"
        // naming a file the reader is not expecting to exist.
        let Ok(text) = std::fs::read_to_string(&toml) else { continue };
        let m = Manifest::parse(&text).map_err(|e| format!("{}: {e}", toml.display()))?;
        let src = match d.as_str() {
            WORKSPACE => "Cargo.toml".to_string(),
            APP => format!("{APP}/Cargo.toml"),
            _ => format!("crates/{d}/Cargo.toml"),
        };
        let body = encode(&m.to_json(&src))?;
        let dest = manifest_record_path(repo_root, &d);
        seen.push(d.clone());
        if std::fs::read_to_string(&dest).is_ok_and(|cur| cur == body) {
            report.unchanged.push(d);
            continue;
        }
        if !dry_run {
            std::fs::write(&dest, &body).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
        }
        report.written.push(d);
    }

    let mut orphaned: Vec<String> = Vec::new();
    for e in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let p = e.path();
        if p.extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_string();
        if !seen.contains(&stem) {
            orphaned.push(stem);
        }
    }
    orphaned.sort();

    if !orphaned.is_empty() && !opts.prune {
        return Err(format!(
            "{} record(s) have no manifest on disk: {}{}\n\n\
             REFUSING, because this cannot tell a DELETED crate from an UN-EMITTED one — since the \
             manifests became generated and untracked, both look like a missing file, and 56 of 80 \
             crate directories do not exist at all in a fresh checkout. Pruning here once reported 78 \
             removals of 82 records that are the only copy.\n\n\
             Emit first (`npm run emit:manifests`) and re-run; pass --prune only if you really did \
             delete these crates.",
            orphaned.len(),
            orphaned.iter().take(6).cloned().collect::<Vec<_>>().join(", "),
            if orphaned.len() > 6 { format!(", … and {} more", orphaned.len() - 6) } else { String::new() },
        ));
    }
    for stem in orphaned {
        if !dry_run {
            let p = dir.join(format!("{stem}.json"));
            std::fs::remove_file(&p).map_err(|e| format!("cannot remove {}: {e}", p.display()))?;
        }
        report.removed.push(stem);
    }
    Ok(report)
}

// ── The authoring direction: create a crate BY CREATING A RECORD ────────────────────────────────
//
// The point of the migration, and the half that was missing while `sync_records` was the only path
// in. Importing a file is a MIGRATION; this is how a crate comes into existence now.

/// The workspace `members` entries, parsed out of the workspace record.
pub fn workspace_members(repo_root: &Path) -> Result<Vec<String>, String> {
    let p = manifest_record_path(repo_root, WORKSPACE);
    let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", p.display()))?;
    let m = Manifest::from_json(&v)?;
    let e = m
        .section("[workspace]")
        .and_then(|s| s.entries.iter().find(|e| e.key == "members"))
        .ok_or("the workspace record has no `members`")?;
    // The value is a TOML array of strings on one line, which is also valid JSON.
    let arr: Vec<String> = serde_json::from_str(&e.value)
        .map_err(|err| format!("`members` is not a parseable array: {err}"))?;
    Ok(arr)
}

/// Author a NEW crate as a record, and register it in the workspace.
///
/// This is the only supported way to add a crate now. It writes no `Cargo.toml` — the emit does that
/// — so the record is the thing that exists first, which is what "the database is authoritative"
/// has to mean in practice rather than only in the read direction.
///
/// Registration is part of the SAME call on purpose: a crate record without a `members` entry is
/// invisible to cargo, and a `members` entry without a record makes every cargo command fail on a
/// manifest that no emit will ever produce. Those two halves drifting is the failure this repo would
/// otherwise discover at the next build, so they are written together or not at all.
pub fn new_crate_record(repo_root: &Path, name: &str) -> Result<PathBuf, String> {
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err(format!(
            "`{name}` is not a usable crate directory name — lowercase letters, digits and dashes only"
        ));
    }
    let dest = manifest_record_path(repo_root, name);
    if dest.exists() {
        return Err(format!("{} already has a manifest record at {}", name, dest.display()));
    }
    let members = workspace_members(repo_root)?;
    let entry = format!("crates/{name}");
    if members.contains(&entry) {
        return Err(format!("the workspace already lists `{entry}` but it has no record — fix that first"));
    }

    // The FLOOR shape: a crate whose whole source lives in the graph owns no file but this manifest,
    // and after the flip it does not own that either. `build` and `[lib] path` are what point it at
    // the shared materializer and the shared crate root.
    let lib = name.replace('-', "_");
    let toml = format!(
        "[package]\n\
         name = \"{name}\"\n\
         version = \"0.1.0\"\n\
         edition = \"2021\"\n\
         build = \"../graph-materialize/build.rs\"\n\
         \n\
         [lib]\n\
         name = \"{lib}\"\n\
         # THE SHARED CRATE ROOT — this crate owns no source file at all.\n\
         path = \"../graph-materialize/crate_root.rs\"\n\
         \n\
         [dependencies]\n\
         \n\
         [build-dependencies]\n\
         # build.rs parses the committed graph store directly.\n\
         serde_json = \"1\"\n"
    );
    let m = Manifest::parse(&toml).map_err(|e| format!("the generated floor manifest does not parse: {e}"))?;
    let body = encode(&m.to_json(&format!("crates/{name}/Cargo.toml")))?;

    // Register FIRST in memory, write both, so a failure cannot leave a half-registered crate.
    let wsp = manifest_record_path(repo_root, WORKSPACE);
    let wtext = std::fs::read_to_string(&wsp).map_err(|e| format!("cannot read {}: {e}", wsp.display()))?;
    let wv: serde_json::Value = serde_json::from_str(&wtext).map_err(|e| format!("{}: {e}", wsp.display()))?;
    let mut wm = Manifest::from_json(&wv)?;
    let me = wm
        .sections
        .iter_mut()
        .find(|s| s.name == "[workspace]")
        .and_then(|s| s.entries.iter_mut().find(|e| e.key == "members"))
        .ok_or("the workspace record has no `members`")?;
    // Textual insert before the closing bracket, so every other byte of the line is untouched — the
    // list is not sorted (it is historical) and re-serializing it would reorder 80 entries into a
    // diff that hides the one real change.
    let close = me.value.rfind(']').ok_or("`members` has no closing bracket")?;
    me.value = format!("{}, \"{entry}\"{}", &me.value[..close], &me.value[close..]);
    let wbody = encode(&wm.to_json("Cargo.toml"))?;

    std::fs::create_dir_all(manifests_dir(repo_root))
        .map_err(|e| format!("cannot create the manifests dir: {e}"))?;
    std::fs::write(&dest, &body).map_err(|e| format!("cannot write {}: {e}", dest.display()))?;
    std::fs::write(&wsp, &wbody).map_err(|e| format!("cannot write {}: {e}", wsp.display()))?;
    Ok(dest)
}

/// Read every stored manifest record back, as `(crate dir, manifest)`.
pub fn load_records(repo_root: &Path) -> Result<Vec<(String, Manifest)>, String> {
    // Keyed by the record's OWN `src`, not by its filename: the workspace record is `_workspace.json`
    // and regenerates `Cargo.toml`, so deriving the path from the filename would look for
    // `crates/_workspace/Cargo.toml` and report a drift that does not exist.
    let dir = manifests_dir(repo_root);
    let mut out = Vec::new();
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    files.sort();
    for p in files {
        let text = std::fs::read_to_string(&p).map_err(|e| format!("cannot read {}: {e}", p.display()))?;
        let v: serde_json::Value =
            serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", p.display()))?;
        let m = Manifest::from_json(&v).map_err(|e| format!("{}: {e}", p.display()))?;
        let src = v
            .get("src")
            .and_then(|x| x.as_str())
            .ok_or_else(|| format!("{} has no `src`", p.display()))?
            .to_string();
        out.push((src, m));
    }
    Ok(out)
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
        let bad = "[dependencies]\nthis line is not a key value pair\n";
        let err = Manifest::parse(bad).expect_err("an unmodelled line must not parse silently");
        assert_eq!(err.line_no, 2);
        assert!(format!("{err}").contains("neither blank"), "the error must say what shapes ARE covered");
    }

    /// A MULTI-LINE value round-trips, continuation lines and indentation intact.
    ///
    /// This shape was refused until `src-tauri` turned out to have one —
    /// `windows-sys = { version = "0.61", features = [` closing three lines later. The refusal was
    /// right (mis-parsing it silently loses the indentation) and the fix is to model it, not to
    /// exclude the crate.
    #[test]
    fn a_multi_line_value_round_trips_with_its_indentation() {
        let src = "[dependencies]\nwin = { version = \"1\", features = [\n  \"a\",\n  \"b\",\n] }\n";
        let m = Manifest::parse(src).expect("a multi-line value must parse");
        assert_eq!(m.render(), src, "it must render back byte-identically, indentation included");
        let e = &m.sections[0].entries[0];
        assert_eq!(e.key, "win");
        assert_eq!(e.cont.len(), 3, "three continuation lines");
        assert_eq!(e.cont[0], "  \"a\",", "indentation is preserved verbatim");
        // …and it survives the record form.
        let back = Manifest::from_json(&m.to_json("x")).unwrap();
        assert_eq!(back.render(), src);
    }

    /// A value that never closes is an error, not an implicit close — a truncated value renders as
    /// valid-looking TOML that says something different.
    #[test]
    fn an_unterminated_value_is_refused() {
        let bad = "[dependencies]\nwin = { version = \"1\", features = [\n  \"a\",\n";
        let err = Manifest::parse(bad).expect_err("an unterminated value must not parse");
        assert_eq!(err.line_no, 2, "the error names where the value STARTS, not where the file ends");
    }

    /// A key/value before any section header has nowhere to go and must not be dropped.
    #[test]
    fn an_entry_before_any_section_is_an_error() {
        assert!(Manifest::parse("name = \"x\"\n").is_err());
    }
}

// ── The crate record ────────────────────────────────────────────────────────────────────────────
//
// What a manifest MEANS, as opposed to how it is written. `Manifest` is the lossless textual model;
// `CrateRecord` is the build-relevant projection of it — the fields a driver needs to construct a
// rustc invocation, with the prose still attached to the dependency it explains.
//
// The two are kept apart on purpose. Round-tripping needs every byte; building needs a handful of
// facts. Collapsing them would mean either a record that cannot reproduce its file or a driver that
// has to re-derive meaning from formatting.

/// Which dependency table an entry came from. Dev-deps widen ONLY the `--test` extern set; conflating
/// them is how a dev-only crate ends up linked into a shipped artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DepKind {
    Normal,
    Dev,
    Build,
}

/// One dependency, with the reasoning that justifies it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dep {
    pub name: String,
    /// The spec exactly as written — `"1"`, `{ path = "../data", default-features = false }`.
    pub spec: String,
    pub kind: DepKind,
    pub why: Option<String>,
}

impl Dep {
    /// A path dependency is FIRST-PARTY: built by us, in topological order. Everything else is
    /// third-party and resolved through the captured extern map.
    pub fn is_first_party(&self) -> bool {
        self.spec.contains("path =")
    }

    /// The features this dependency is taken with. `bsc-sqlite-util`'s `["conn"]` is the case that
    /// matters: its own prose records that backups use `VACUUM INTO` and silently corrupt without it,
    /// so a generator that dropped the flag would ship a working build and broken backups.
    pub fn features(&self) -> Vec<String> {
        let Some(rest) = self.spec.split("features").nth(1) else { return Vec::new() };
        let Some(open) = rest.find('[') else { return Vec::new() };
        let Some(close) = rest[open..].find(']') else { return Vec::new() };
        rest[open + 1..open + close]
            .split(',')
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }
}

/// A build target the crate declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetKind {
    Lib { path: Option<String> },
    Bin { name: String, path: Option<String> },
    /// A `[[test]]` integration target. Its body is selected by `CARGO_CRATE_NAME`, which is the
    /// TARGET's name rather than the package's — so the driver must set that variable per target,
    /// not once per crate.
    Test { name: String, path: Option<String> },
}

/// The build-relevant projection of a manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CrateRecord {
    /// The directory under `crates/` — also the id prefix of every record the crate owns.
    pub dir: String,
    pub name: String,
    pub edition: String,
    /// Whether the crate's source lives in the graph (`build = "../graph-materialize/build.rs"`).
    /// The 6 that do not keep real files and stay on cargo.
    pub materialized: bool,
    pub targets: Vec<TargetKind>,
    pub deps: Vec<Dep>,
    pub features: Vec<String>,
    /// The package-level prose — the `#` block before `[dependencies]` or above `[package]`.
    pub doc: Option<String>,
}

fn quoted(v: &str) -> String {
    v.trim().trim_matches('"').to_string()
}

impl CrateRecord {
    pub fn extract(m: &Manifest, dir: &str) -> CrateRecord {
        let mut targets = Vec::new();
        let mut deps = Vec::new();
        let mut features = Vec::new();

        for sec in &m.sections {
            let get = |k: &str| sec.entries.iter().find(|e| e.key == k).map(|e| quoted(&e.value));
            match sec.name.as_str() {
                "[lib]" => targets.push(TargetKind::Lib { path: get("path") }),
                "[[bin]]" => targets.push(TargetKind::Bin {
                    name: get("name").unwrap_or_else(|| dir.to_string()),
                    path: get("path"),
                }),
                "[[test]]" => targets.push(TargetKind::Test {
                    name: get("name").unwrap_or_default(),
                    path: get("path"),
                }),
                "[features]" => features.extend(sec.entries.iter().map(|e| e.key.clone())),
                _ => {}
            }
            let kind = match sec.name.as_str() {
                "[dependencies]" => Some(DepKind::Normal),
                "[dev-dependencies]" => Some(DepKind::Dev),
                "[build-dependencies]" => Some(DepKind::Build),
                n if n.starts_with("[target.") && n.ends_with(".dependencies]") => Some(DepKind::Normal),
                _ => None,
            };
            if let Some(kind) = kind {
                deps.extend(sec.entries.iter().map(|e| Dep {
                    name: e.key.clone(),
                    spec: e.value.clone(),
                    kind,
                    why: e.why(),
                }));
            }
        }

        let materialized = m
            .section("[package]")
            .and_then(|s| s.entries.iter().find(|e| e.key == "build"))
            .is_some_and(|e| e.value.contains("graph-materialize/build.rs"));

        // The package prose is the lead of whichever section first carries one after `[package]` —
        // in practice `[dependencies]` or `[build-dependencies]`. Taking the FIRST non-empty one
        // rather than concatenating keeps a dependency's own rationale out of the crate's summary.
        let doc = m
            .sections
            .iter()
            .skip(1)
            .find_map(|s| {
                let t: Vec<&str> = s
                    .lead
                    .iter()
                    .filter(|l| l.trim_start().starts_with('#'))
                    .map(|l| l.trim_start().trim_start_matches('#').trim())
                    .collect();
                (!t.is_empty()).then(|| t.join(" "))
            });

        CrateRecord {
            dir: dir.to_string(),
            name: m.package("name").unwrap_or_else(|| dir.to_string()),
            edition: m.package("edition").unwrap_or_else(|| "2021".into()),
            materialized,
            targets,
            deps,
            features,
            doc,
        }
    }

    /// Dependencies that widen a normal build.
    pub fn normal_deps(&self) -> Vec<&Dep> {
        self.deps.iter().filter(|d| d.kind == DepKind::Normal).collect()
    }

    /// Dependencies that widen ONLY the `--test` extern set.
    pub fn dev_deps(&self) -> Vec<&Dep> {
        self.deps.iter().filter(|d| d.kind == DepKind::Dev).collect()
    }

    /// The first-party crates this one must be built AFTER.
    pub fn first_party_deps(&self) -> Vec<&Dep> {
        self.deps.iter().filter(|d| d.kind != DepKind::Build && d.is_first_party()).collect()
    }
}

#[cfg(test)]
mod crate_record_tests {
    use super::*;
    use std::path::Path;

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    /// Every crate in the workspace, projected. This is the whole population, not a sample.
    fn all() -> Vec<CrateRecord> {
        let mut v: Vec<CrateRecord> = std::fs::read_dir(repo().join("crates"))
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let dir = e.file_name().to_string_lossy().to_string();
                let p = e.path().join("Cargo.toml");
                let src = std::fs::read_to_string(&p).ok()?;
                let m = Manifest::parse(&src).unwrap_or_else(|err| panic!("{}: {err}", p.display()));
                Some(CrateRecord::extract(&m, &dir))
            })
            .collect();
        v.sort_by(|a, b| a.dir.cmp(&b.dir));
        v
    }

    #[test]
    fn every_crate_projects_and_the_materialized_split_is_exactly_the_seven() {
        let all = all();
        assert!(all.len() >= 80, "expected >=80 crates, found {}", all.len());
        let mut plain: Vec<&str> = all.iter().filter(|c| !c.materialized).map(|c| c.dir.as_str()).collect();
        plain.sort();
        // These 7 keep real source files. TWO of them for a STRUCTURAL reason and the rest because
        // they have never been harvested:
        //
        //   `graph-materialize` cannot materialize itself — it IS the materializer.
        //   `bsc-sqlite-read` cannot either, one step further out: `build.rs` `include!`s its
        //     `src/pages.rs` TEXTUALLY to bootstrap, because reading the store is what the script does
        //     and a record has no file to include. Making it a record would mean the materializer
        //     needing the store to learn how to read the store.
        //
        // Everything else compiles from records.
        assert_eq!(
            plain,
            vec!["bsc-config", "bsc-ear", "bsc-lan", "bsc-say", "bsc-sqlite-read", "data", "graph-materialize"],
            "the set of crates that still compile from files changed — that is a migration event, \
             not a detail, and this list is how it gets noticed"
        );
        for c in &all {
            assert!(!c.name.is_empty() && !c.edition.is_empty(), "{} projected empty", c.dir);
        }
    }

    /// The build-relevant declarations, pinned as POPULATIONS so a projection that silently stopped
    /// finding one fails rather than reporting a smaller, greener number.
    #[test]
    fn the_declared_targets_and_features_match_the_workspace() {
        let all = all();
        let with = |f: fn(&CrateRecord) -> bool| {
            let mut v: Vec<&str> = all.iter().filter(|c| f(c)).map(|c| c.dir.as_str()).collect();
            v.sort();
            v
        };
        assert_eq!(with(|c| !c.features.is_empty()), vec!["bsc", "bsc-sqlite-util", "data"]);
        assert_eq!(
            with(|c| c.targets.iter().any(|t| matches!(t, TargetKind::Test { .. }))),
            vec!["bsc-disk", "bsc-lan-stream", "bsc-publish"],
            "a [[test]] target needs CARGO_CRATE_NAME set PER TARGET, so this set bounds that work"
        );
        assert_eq!(with(|c| !c.dev_deps().is_empty()).len(), 21, "dev-deps widen only the test build");
        // NAMES, not a count. An earlier tally said 7 because it substring-matched `[[bin]]` and hit
        // `bsc-cad`'s comment saying it deliberately has NO bin target. A count would have been
        // "corrected" to 7 and hidden a projection that was actually right.
        assert_eq!(
            with(|c| c.targets.iter().any(|t| matches!(t, TargetKind::Bin { .. }))),
            vec!["bsc", "bsc-agent", "bsc-emit", "bsc-hook", "bsc-lan", "bsc-rf"]
        );
    }

    /// Third-party surface, which is what still needs cargo. Small enough to anchor one build.
    #[test]
    fn the_third_party_surface_is_small_and_bounded() {
        let all = all();
        let names: std::collections::HashSet<&str> = all.iter().map(|c| c.name.as_str()).collect();
        let mut third: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for c in &all {
            for d in c.normal_deps() {
                if !d.is_first_party() && !names.contains(d.name.as_str()) {
                    third.insert(d.name.as_str());
                }
            }
        }
        assert!(
            (30..=45).contains(&third.len()),
            "the third-party surface is {} crates; it was 37 when the anchor design was sized, and a \
             large move means the anchor build needs re-sizing rather than a quiet edit here",
            third.len()
        );
    }

    /// The `features = ["conn"]` case, end to end: parsed off the spec AND its rationale reachable.
    #[test]
    fn a_dependencys_features_and_its_reason_both_survive() {
        let src = std::fs::read_to_string(repo().join("crates/plandb/Cargo.toml")).unwrap();
        let rec = CrateRecord::extract(&Manifest::parse(&src).unwrap(), "plandb");
        let d = rec.normal_deps().into_iter().find(|d| d.name == "bsc-sqlite-util").unwrap();
        assert_eq!(d.features(), vec!["conn".to_string()], "dropping this flag corrupts backups silently");
        assert!(d.is_first_party(), "it is a path dependency, so the driver builds it first");
        assert!(d.why.as_deref().unwrap_or_default().contains("conn"));
    }

    /// A build order must exist, and it must be derived rather than assumed.
    #[test]
    fn the_workspace_has_a_build_order_and_it_respects_every_edge() {
        let all = all();
        let order = topo_order(&all).expect("the first-party graph must be acyclic");
        assert_eq!(order.len(), all.len());
        let pos: std::collections::HashMap<&str, usize> =
            order.iter().enumerate().map(|(i, n)| (n.as_str(), i)).collect();
        let by_name: std::collections::HashMap<&str, &CrateRecord> =
            all.iter().map(|c| (c.name.as_str(), c)).collect();
        for c in &all {
            for d in c.first_party_deps() {
                if by_name.contains_key(d.name.as_str()) {
                    assert!(
                        pos[d.name.as_str()] < pos[c.name.as_str()],
                        "{} must be built before {}", d.name, c.name
                    );
                }
            }
        }
    }

    /// A cycle is an ERROR, not an arbitrary order. Proven against a synthetic pair, because the real
    /// workspace is acyclic and a guard that has only ever seen the happy path is not evidence.
    #[test]
    fn a_dependency_cycle_is_refused_by_name() {
        let mk = |name: &str, dep: &str| CrateRecord {
            dir: name.into(), name: name.into(), edition: "2021".into(), materialized: true,
            targets: vec![], features: vec![], doc: None,
            deps: vec![Dep {
                name: dep.into(), spec: format!("{{ path = \"../{dep}\" }}"),
                kind: DepKind::Normal, why: None,
            }],
        };
        let err = topo_order(&[mk("a", "b"), mk("b", "a")]).expect_err("a cycle must not order");
        assert!(err.contains("cycle"), "got: {err}");
        assert!(err.contains('a') && err.contains('b'), "the error must NAME the stuck crates: {err}");
    }
}

#[cfg(test)]
mod record_form_tests {
    use super::*;
    use std::path::Path;

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    fn all_manifests() -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = std::fs::read_dir(repo().join("crates"))
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let p = e.path().join("Cargo.toml");
                let rel = format!("crates/{}/Cargo.toml", e.file_name().to_string_lossy());
                std::fs::read_to_string(&p).ok().map(|s| (rel, s))
            })
            .collect();
        v.push(("Cargo.toml".into(), std::fs::read_to_string(repo().join("Cargo.toml")).unwrap()));
        v.sort();
        v
    }

    /// The claim the whole migration rests on: a manifest survives a trip THROUGH THE RECORD FORM and
    /// still regenerates its file byte-for-byte. A round-trip in memory proves the parser; this proves
    /// the stored shape.
    #[test]
    fn a_manifest_survives_the_record_form_byte_for_byte() {
        let all = all_manifests();
        assert!(all.len() >= 80, "expected >=80 manifests, found {}", all.len());
        for (src_path, text) in &all {
            let m = Manifest::parse(text).unwrap_or_else(|e| panic!("{src_path}: {e}"));
            let json = m.to_json(src_path);
            // Through a real serialize/deserialize, not just the value — a record is stored as TEXT,
            // and escaping is exactly where a hand-rolled encoder goes wrong.
            let encoded = serde_json::to_string(&json).unwrap();
            let decoded: serde_json::Value = serde_json::from_str(&encoded).unwrap();
            let back = Manifest::from_json(&decoded).unwrap_or_else(|e| panic!("{src_path}: {e}"));
            assert_eq!(&back, &m, "{src_path}: the record form lost structure");
            assert_eq!(&back.render(), text, "{src_path}: the record form did not regenerate the file");
        }
    }

    /// The record carries enough to answer questions, not just to rebuild the file.
    #[test]
    fn the_projection_survives_the_record_form() {
        let text = std::fs::read_to_string(repo().join("crates/plandb/Cargo.toml")).unwrap();
        let m = Manifest::parse(&text).unwrap();
        let back = Manifest::from_json(&m.to_json("crates/plandb/Cargo.toml")).unwrap();
        let rec = CrateRecord::extract(&back, "plandb");
        assert_eq!(rec.name, "plandb");
        assert!(rec.materialized);
        let d = rec.normal_deps().into_iter().find(|d| d.name == "bsc-sqlite-util").unwrap();
        assert_eq!(d.features(), vec!["conn".to_string()]);
        assert!(d.why.as_deref().unwrap_or_default().contains("conn"), "the rationale must survive storage");
    }

    /// A tolerant reader is the failure mode here: defaulting `endsNewline` renders a file one byte
    /// different from its source and passes everything that is not byte-exact.
    #[test]
    fn a_record_missing_a_field_is_refused_rather_than_defaulted() {
        let text = std::fs::read_to_string(repo().join("crates/bsc-hook/Cargo.toml")).unwrap();
        let m = Manifest::parse(&text).unwrap();
        let mut json = m.to_json("crates/bsc-hook/Cargo.toml");
        json.as_object_mut().unwrap().remove("endsNewline");
        let err = Manifest::from_json(&json).expect_err("a missing endsNewline must not default");
        assert!(err.contains("endsNewline"), "got: {err}");

        let mut json2 = m.to_json("x");
        json2.as_object_mut().unwrap().remove("tail");
        assert!(Manifest::from_json(&json2).is_err(), "a missing tail must not default either");
    }
}

#[cfg(test)]
mod store_tests {
    use super::*;

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    /// THE POINT OF THE WHOLE MIGRATION: every stored record regenerates its `Cargo.toml`
    /// byte-for-byte. If this holds, the file is a build product and the record is the source.
    #[test]
    fn every_stored_record_regenerates_its_manifest_byte_for_byte() {
        let stored = load_records(repo()).expect("the manifest records must load");
        assert!(
            stored.len() >= 81,
            "expected >=81 stored manifest records (80 crates + the workspace), found {} — run the sync; a short store here \
             means crates whose manifest has NO record and would be silently un-regenerable",
            stored.len()
        );
        for (src, m) in &stored {
            let dir = src;
            let on_disk = std::fs::read_to_string(repo().join(src))
                .unwrap_or_else(|e| panic!("{src}: record exists but the manifest does not: {e}"));
            assert_eq!(
                &m.render(),
                &on_disk,
                "{dir}: the stored record no longer regenerates its manifest — the two have drifted, \
                 and the FILE is what cargo compiles, so the record is the stale one"
            );
        }
    }

    /// A sync must be idempotent: running it on a synced tree writes nothing. Without this, the sync
    /// churns every file on every run and a real change is invisible in the diff.
    #[test]
    fn a_sync_of_a_synced_tree_writes_nothing() {
        let r = sync_records(repo(), SyncOptions { dry_run: true, prune: false })
            .expect("dry run must succeed");
        assert!(
            r.written.is_empty(),
            "a dry sync wanted to rewrite {:?} — the store is out of date with the manifests",
            r.written
        );
        assert!(r.removed.is_empty(), "a dry sync wanted to remove {:?}", r.removed);
        assert!(r.unchanged.len() >= 81, "only {} unchanged (80 crates + the workspace)", r.unchanged.len());
    }

    /// Manifest records must NOT live where a `bsc algorithms` write would sweep them.
    ///
    /// The hazard survived the store becoming a database, it only changed shape. It used to be
    /// `repo_store::write_at` deleting any file under `graph/records/` whose id was absent from the
    /// document; it is now `write_db`, which RETIRES any id in the store that the document no longer
    /// carries. A manifest record is never in that document, so if one were ever written into the
    /// committed store the next `bsc algorithms` write by any session would tombstone it — and the crate
    /// would stop building with no file to notice missing.
    ///
    /// So the invariant is asserted where it now lives: no id in the committed store looks like a
    /// manifest, and the manifests keep their own directory.
    #[test]
    fn no_manifest_record_sits_where_a_graph_write_would_sweep_it() {
        let store = repo().join("graph").join(crate::store_name(repo()));
        assert!(store.is_file(), "no committed store at {} — this guard needs one", store.display());
        let doc = crate::load_merged_value(&store)
            .expect("the committed store reads")
            .expect("the committed store is present");
        let strays: Vec<String> = doc
            .get("implementations")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|r| r.get("id").and_then(|v| v.as_str()))
                    .filter(|id| id.contains("Cargo.toml") || id.ends_with("--manifest"))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        assert!(
            strays.is_empty(),
            "manifest records found in the committed store, which a `bsc algorithms` write sweeps: {strays:?}"
        );
        assert_ne!(manifests_dir(repo()), store, "the manifests are not the record store");
    }

    /// A stored record must round-trip through the store the same way it does in memory.
    #[test]
    fn a_stored_record_reparses_to_the_same_manifest() {
        let stored = load_records(repo()).unwrap();
        let (src, m) = stored
            .iter()
            .find(|(s, _)| s == "crates/bsc-hook/Cargo.toml")
            .expect("bsc-hook has a record");
        let parsed = Manifest::parse(&std::fs::read_to_string(repo().join(src)).unwrap()).unwrap();
        assert_eq!(m, &parsed);
        let rec = CrateRecord::extract(m, "bsc-hook");
        assert!(rec.materialized);
        assert_eq!(rec.normal_deps().len(), 2, "bsc-hook is DELIBERATELY two dependencies");
    }
}

#[cfg(test)]
mod encoding_tests {
    use super::*;

    /// The on-disk format must not depend on which cargo invocation wrote it.
    ///
    /// `serde_json`'s `preserve_order` is enabled by four crates here and unified in by any
    /// `--workspace` build, flipping `Value` from a sorted `BTreeMap` to an insertion-ordered
    /// `IndexMap`. This assertion holds under BOTH configurations once keys are sorted explicitly,
    /// and fails under the workspace one if they are not — which is exactly where the bug lived, and
    /// exactly where a `-p` test cannot see it.
    #[test]
    fn the_encoded_form_has_sorted_keys_whatever_features_are_unified_in() {
        let v = serde_json::json!({
            "src": "x", "kind": "manifest", "endsNewline": true,
            "sections": [{ "name": "[p]", "lead": [], "entries": [{ "value": "1", "key": "k", "lead": [] }] }],
            "tail": [],
        });
        let out = encode(&v).unwrap();
        let top: Vec<&str> = out
            .lines()
            .filter(|l| l.starts_with("  \""))
            .filter_map(|l| l.trim().split('"').nth(1))
            .collect();
        let mut sorted = top.clone();
        sorted.sort();
        assert_eq!(top, sorted, "top-level keys must be sorted; got {top:?}");

        // …and nested objects too, or a nested map would still flip with the feature.
        let nested: Vec<&str> = out
            .lines()
            .filter(|l| l.starts_with("          \""))
            .filter_map(|l| l.trim().split('"').nth(1))
            .collect();
        let mut nsorted = nested.clone();
        nsorted.sort();
        assert_eq!(nested, nsorted, "nested keys must be sorted; got {nested:?}");
        assert!(out.ends_with("}\n"), "one trailing newline");
    }
}

#[cfg(test)]
mod authoring_tests {
    use super::*;

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    /// A scratch checkout holding only the records — enough for the authoring path, and never the
    /// real repo, because these tests WRITE.
    fn scratch(tag: &str) -> PathBuf {
        let d = repo().join("target").join("gm-authoring").join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("crates")).unwrap();
        std::fs::create_dir_all(d.join("graph").join("manifests")).unwrap();
        for e in std::fs::read_dir(manifests_dir(repo())).unwrap().flatten() {
            std::fs::copy(e.path(), d.join("graph").join("manifests").join(e.file_name())).unwrap();
        }
        d
    }

    /// THE AUTHORING DIRECTION: a crate comes into existence as a RECORD, not as a file.
    #[test]
    fn a_new_crate_is_created_as_a_record_and_registered_in_one_step() {
        let d = scratch("new");
        let before = workspace_members(&d).unwrap().len();
        let rec = new_crate_record(&d, "demo-crate").expect("authoring must succeed");
        assert!(rec.is_file(), "the record is what exists first");
        assert!(
            !d.join("crates/demo-crate/Cargo.toml").exists(),
            "authoring must NOT write a manifest — the emit does that, or the file is authoritative again"
        );
        let after = workspace_members(&d).unwrap();
        assert_eq!(after.len(), before + 1);
        assert!(after.contains(&"crates/demo-crate".to_string()), "registration is part of the same step");

        // The record must render a manifest that parses back to itself.
        let stored = load_records(&d).unwrap();
        let (_, m) = stored.iter().find(|(s, _)| s == "crates/demo-crate/Cargo.toml").unwrap();
        let rendered = m.render();
        assert_eq!(Manifest::parse(&rendered).unwrap(), *m);
        let cr = CrateRecord::extract(m, "demo-crate");
        assert!(cr.materialized, "a new crate compiles from the graph by default");
        assert_eq!(cr.name, "demo-crate");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn authoring_refuses_a_duplicate_and_a_bad_name() {
        let d = scratch("dupe");
        new_crate_record(&d, "demo-crate").unwrap();
        let err = new_crate_record(&d, "demo-crate").expect_err("a second create must refuse");
        assert!(err.contains("already has a manifest record"), "got: {err}");
        for bad in ["", "Demo", "demo crate", "demo_crate"] {
            assert!(new_crate_record(&d, bad).is_err(), "`{bad}` must be refused");
        }
        let _ = std::fs::remove_dir_all(&d);
    }

    /// THE DATA-LOSS GUARD. A file-derived import cannot tell a deleted crate from an un-emitted one,
    /// and since the flip both look like a missing file. Measured: pruning in a fresh-clone-shaped
    /// tree reported 78 removals of 82 records that are now the only copy.
    #[test]
    fn an_import_refuses_to_prune_records_whose_manifest_is_merely_un_emitted() {
        let d = scratch("prune");
        // A tree with records but no emitted manifests — exactly a fresh checkout.
        let err = sync_records(&d, SyncOptions { dry_run: true, prune: false })
            .expect_err("an un-emitted tree must be refused, not pruned");
        assert!(err.contains("REFUSING"), "got: {err}");
        assert!(err.contains("emit"), "the refusal must say how to proceed: {err}");
        // …and the records are still there, because a dry run that refuses writes nothing either way.
        assert!(load_records(&d).unwrap().len() >= 82);
        // With --prune the caller has said they mean it.
        let r = sync_records(&d, SyncOptions { dry_run: true, prune: true }).expect("--prune is allowed");
        assert!(r.removed.len() >= 78, "the hazard is real: {} would go", r.removed.len());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// A LIVE INVARIANT on the real repo: the workspace and the record set must agree. A crate record
    /// with no `members` entry is invisible to cargo; a `members` entry with no record makes every
    /// cargo command fail on a manifest no emit will produce.
    #[test]
    fn every_crate_record_is_registered_and_every_registration_has_a_record() {
        let members = workspace_members(repo()).unwrap();
        let records: Vec<String> = load_records(repo()).unwrap().into_iter().map(|(s, _)| s).collect();
        assert!(members.len() >= 80, "only {} members", members.len());

        for m in &members {
            // `src-tauri` is a member that does not live under `crates/`; it has a record too.
            let want = format!("{m}/Cargo.toml");
            assert!(
                records.contains(&want),
                "the workspace lists `{m}` but there is no record at {want} — every cargo command in a \
                 fresh checkout would fail on a manifest no emit can produce"
            );
        }
        for r in &records {
            let Some(dir) = r.strip_suffix("/Cargo.toml") else { continue };
            if dir == "src-tauri" || r == "Cargo.toml" {
                continue;
            }
            assert!(
                members.contains(&dir.to_string()),
                "there is a record for `{dir}` but the workspace does not list it — cargo would never \
                 see the crate"
            );
        }
    }
}
