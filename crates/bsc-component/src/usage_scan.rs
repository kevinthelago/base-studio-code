//! `bsc ui usage-scan` (#3888 slices 2-4) — determine each component's usage from the sources that
//! actually exist, over a corpus that is DECLARED rather than assumed.
//!
//! ## What was broken
//!
//! `used` is a reuse count with no producer. Measured 2026-08-24: **0 of 552 components across all four
//! kits carry `used > 0`**, and 122 of them do not carry the field at all. So `bsc ui doctor`'s dead-root
//! rule (`in-degree 0 AND used == 0`) collapses to "nothing composes it", which flags every entry point
//! by construction — 81 dangling-branch + 75 orphan findings on `base-studio-code` alone, none of them
//! verifiable. That is designer requests #95 and #100.
//!
//! ## Three sources, because usage has three shapes
//!
//! | source | signal |
//! |---|---|
//! | [`Source::Composes`] | another record in the same kit lists this one in `composes` |
//! | [`Source::Mount`] | `<GraphComponent id="X">` names it — how the migrated pages are reached |
//! | [`Source::Provides`] | its `provides` specifier is imported somewhere in the corpus |
//! | [`Source::Path`] | its `src` path is imported by the alias that resolves to it (`@/app/App`) |
//!
//! ## Why the fourth source exists, and what it cost to find
//!
//! Built with the first three, `--apply` on the real store authorized deleting **`App`** — the
//! application root — along with `GraphComponent` (the mount host itself), `ThemeProvider` and nine
//! others. Every one of them carries a `src` and NO `provides`: nothing composes them, no
//! `GraphComponent id=` names them, and they declare no specifier, so all three sources read zero and
//! `usageAssessed` then made them prunable. They are reached the ordinary way — `main.tsx` imports
//! `@/app/App`, which `tsconfig`'s `@/*` maps onto `src/*`.
//!
//! A detector is only as safe as its LEAST-covered reachability path, and the classes it cannot see are
//! invisible in its output — they look exactly like genuinely dead code. This one was caught by reading
//! the dry-run list instead of the summary count.
//!
//! ## The corpus includes the STORE, and that is the correction
//!
//! #3888 says "the app's own kit → scan this repo's `src/`". That was true when it was written and is
//! not now (#3604): a `GraphComponent id=` sweep of `src/` finds ONE hit, and it is the literal
//! `id="x"`. All ten real mount sites live inside record `srcText`. A corpus that is only the repo tree
//! reports every one of them unused — the same bug one level down. So the kit's own records are always
//! part of the corpus, and the on-disk roots are named explicitly by the caller.
//!
//! ## What it does NOT fix, stated because a silent shortfall reads as success
//!
//! Measured against the 156 dead roots: host-mount clears 8, `provides` clears 56, and **92 survive
//! both**. This resolves about 40% of the category. The remaining 92 are the honest remainder, and the
//! point of `usageAssessed` (slice 1) is that they stay UNPRUNABLE rather than quietly becoming garbage.

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

/// Which source reported a component used. Reported per node so a count is never a bare number the
/// reader has to trust — "used = 3" and "used = 3 (composes, mount)" are different claims.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Source {
    Composes,
    Mount,
    Provides,
    Path,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Composes => "composes",
            Source::Mount => "mount",
            Source::Provides => "provides",
            Source::Path => "path",
        }
    }
}

/// One component's determined usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageRow {
    pub id: String,
    pub name: String,
    pub kit: String,
    /// Total references found across every source.
    pub used: i64,
    /// Which sources contributed — empty when `used == 0`, which is the ASSESSED-and-unused case.
    pub sources: Vec<Source>,
}

/// The whole scan: every EXAMINED component, plus the corpus it was judged against.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ScanReport {
    /// The corpus, named — labels of everything walked, so the scope is inspectable rather than implied.
    pub roots: Vec<String>,
    pub rows: Vec<UsageRow>,
}

impl ScanReport {
    /// How many examined components came back with no usage from any source. These are the ones that
    /// become prunable once `--apply` writes `usageAssessed`, so the number is worth saying out loud.
    pub fn unused(&self) -> usize {
        self.rows.iter().filter(|r| r.used == 0).count()
    }
}

/// Every `<GraphComponent … id="X">` id named in `source`.
///
/// A hand scanner, like every other one in this crate (no regex dep). Verified on the real store: all
/// mount sites use a LITERAL string id, so a static read is reliable here — there is no variable-id
/// indirection to defeat it.
pub fn mount_ids(source: &str) -> BTreeSet<String> {
    const TAG: &str = "GraphComponent";
    let mut out = BTreeSet::new();
    let bytes: Vec<char> = source.chars().collect();
    let mut from = 0usize;
    let hay: String = source.to_string();
    while let Some(rel) = hay[from..].find(TAG) {
        let start = from + rel + TAG.len();
        from = start;
        // Scan this element's attributes up to `>`, and take the first `id="…"`.
        let mut i = start;
        while i < bytes.len() && bytes[i] != '>' {
            if bytes[i] == 'i' && bytes.get(i + 1) == Some(&'d') {
                let mut j = i + 2;
                while j < bytes.len() && bytes[j].is_whitespace() {
                    j += 1;
                }
                if bytes.get(j) == Some(&'=') {
                    j += 1;
                    while j < bytes.len() && bytes[j].is_whitespace() {
                        j += 1;
                    }
                    if let Some(&q @ ('"' | '\'')) = bytes.get(j) {
                        let mut k = j + 1;
                        let mut val = String::new();
                        while k < bytes.len() && bytes[k] != q {
                            val.push(bytes[k]);
                            k += 1;
                        }
                        if !val.is_empty() {
                            out.insert(val);
                        }
                        break;
                    }
                }
            }
            i += 1;
        }
    }
    out
}

/// Every `import.meta.glob("PATTERN")` pattern in `source`.
///
/// The shared [`crate::graph_health::import_specifiers`] cannot see these: the word before the string is
/// `glob`, not `import`. Missing them is not academic — `algorithmsgraphhost`, `automationsgraphhost`
/// and `datagraphhost` all carry a `provides` and are reached ONLY through `lazyWorkspaces`' glob, so a
/// scanner without this reports them unused BECAUSE it could not see the import, which is the exact
/// failure #3888 is about.
pub fn glob_patterns(source: &str) -> BTreeSet<String> {
    const NEEDLE: &str = "import.meta.glob";
    let mut out = BTreeSet::new();
    let mut from = 0usize;
    while let Some(rel) = source[from..].find(NEEDLE) {
        let after = from + rel + NEEDLE.len();
        from = after;
        let rest: Vec<char> = source[after..].chars().take(4096).collect();
        let mut i = 0usize;
        // Skip to the opening quote of the first argument.
        while i < rest.len() && rest[i] != '"' && rest[i] != '\'' && rest[i] != '`' && rest[i] != ')' {
            i += 1;
        }
        let Some(&q) = rest.get(i) else { continue };
        if q == ')' {
            continue;
        }
        let mut val = String::new();
        i += 1;
        while i < rest.len() && rest[i] != q {
            val.push(rest[i]);
            i += 1;
        }
        if !val.is_empty() {
            out.insert(val);
        }
    }
    out
}

/// Does `pattern` (an `import.meta.glob` pattern) reach `spec`?
///
/// Deliberately loose: match on the literal prefix before the first `*`. A glob is a WIDENING signal —
/// its whole purpose is to import a set nobody enumerated — so over-inclusion here reports a module used
/// when something in its directory is globbed, and the alternative (a precise matcher) reports it UNUSED
/// and gets it deleted. Between those two errors this one is recoverable.
pub fn glob_reaches(pattern: &str, spec: &str) -> bool {
    let prefix = pattern.split('*').next().unwrap_or("");
    !prefix.is_empty() && spec.starts_with(prefix)
}

/// How a literal occurrence of a component NAME appeared in a scanned source — [`name_mentions`]'s
/// per-hit classification, for #113: distinguishing a genuinely-dead dangling-branch root from one
/// that's really referenced but just missing a `composes` edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MentionKind {
    /// `<Name` or `</Name` — a JSX tag.
    JsxTag,
    /// The name appears inside an `import … from …` / `export … from …` clause (a named or default
    /// import binding), e.g. `import { Name } from "..."` or `import Name from "..."`.
    ImportClause,
    /// Anywhere else an identifier `Name` is used — a plain reference, type annotation, `Name.thing`.
    Bare,
}

/// Every literal whole-word occurrence of the identifier `name` in `source`, classified by how it
/// appears. A hand scanner (no regex dep), like the others in this module: comments and string
/// contents are skipped so a mention inside a comment or an unrelated string literal is never
/// counted, and matches are WHOLE-WORD (`Name` never matches inside `NameField`).
///
/// This is the complement to [`scan`]'s `Provides`/`Path` sources, which key off a declared
/// specifier or `src` alias. Neither one sees a component referenced by NAME in another's JSX or
/// import clause without ALSO being added to `composes` — the exact gap #113 filed: `bsc ui used-by`
/// reads only the declared composes graph, so a component actually used but missing that edge reads
/// as an orphan indistinguishable from one that is genuinely dead. This scans the raw text instead,
/// so the caller can tell the two apart before deleting anything.
///
/// Deliberately loose, like [`mount_ids`]/[`glob_patterns`]: over-inclusion (e.g. a same-named local
/// variable) is harmless because the caller uses this to decide whether to LOOK FURTHER, never to
/// authorize a delete on its own — under-inclusion is the failure mode that matters here.
pub fn name_mentions(source: &str, name: &str) -> Vec<MentionKind> {
    if name.is_empty() || !name.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$') {
        return Vec::new();
    }
    let chars: Vec<char> = source.chars().collect();
    let n = chars.len();
    let is_id = |c: char| c.is_alphanumeric() || c == '_' || c == '$';
    let mut out = Vec::new();
    let mut i = 0usize;
    // Whether we are between an `import`/`export` keyword and the `from`/`;` that ends its clause —
    // mirrors the clause tracking in `graph_health::scan_imports`.
    let mut in_clause = false;
    while i < n {
        let c = chars[i];
        if c == '/' && i + 1 < n && chars[i + 1] == '/' {
            i += 2;
            while i < n && chars[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && i + 1 < n && chars[i + 1] == '*' {
            i += 2;
            while i < n && !(chars[i] == '*' && i + 1 < n && chars[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if c == '"' || c == '\'' || c == '`' {
            let quote = c;
            i += 1;
            while i < n && chars[i] != quote {
                if chars[i] == '\\' {
                    i += 1;
                }
                i += 1;
            }
            i += 1;
        } else if c == ';' {
            in_clause = false;
            i += 1;
        } else if is_id(c) {
            let start = i;
            let mut w = String::new();
            while i < n && is_id(chars[i]) {
                w.push(chars[i]);
                i += 1;
            }
            if w == "import" || w == "export" {
                in_clause = true;
            } else if w == "from" {
                in_clause = false;
            } else if w == name {
                let prev = if start > 0 { Some(chars[start - 1]) } else { None };
                let prev2 = if start > 1 { Some(chars[start - 2]) } else { None };
                if prev == Some('<') || (prev == Some('/') && prev2 == Some('<')) {
                    out.push(MentionKind::JsxTag);
                } else if in_clause {
                    out.push(MentionKind::ImportClause);
                } else {
                    out.push(MentionKind::Bare);
                }
            }
        } else {
            i += 1;
        }
    }
    out
}

/// A `src` path as the import BASE it is reachable by — `src/app/App.tsx` → `app/App`, which
/// `tsconfig`'s `@/*` → `src/*` makes `@/app/App`. Empty when the path is not under `src/`.
pub fn src_base(src: &str) -> String {
    let p = src.trim().trim_start_matches("./");
    let Some(rest) = p.strip_prefix("src/") else { return String::new() };
    match rest.rfind('.') {
        Some(dot) if !rest[dot + 1..].contains('/') => rest[..dot].to_string(),
        _ => rest.to_string(),
    }
}

/// The import BASE a specifier resolves to, from an importer at `from_rel` (a `src/`-relative path, or
/// empty for a record, which has no path).
///
/// `@/x/Y` → `x/Y`. A RELATIVE specifier is resolved against the importer's directory, which is why the
/// corpus carries file paths: `./App` from `src/app/main.tsx` is `app/App`, and without that the app
/// root reads as unused. Records import by their `@/` alias (the repo forbids deep relatives), so a
/// record importer with no path simply contributes nothing here rather than guessing.
pub fn import_base(spec: &str, from_rel: &str) -> String {
    if let Some(rest) = spec.strip_prefix("@/") {
        return strip_ext(rest);
    }
    if !(spec.starts_with("./") || spec.starts_with("../")) || from_rel.is_empty() {
        return String::new();
    }
    let Some(dir) = from_rel.strip_prefix("src/").and_then(|r| r.rfind('/').map(|i| &r[..i])) else {
        return String::new();
    };
    let mut segs: Vec<&str> = if dir.is_empty() { Vec::new() } else { dir.split('/').collect() };
    for part in spec.split('/') {
        match part {
            "." | "" => {}
            ".." => {
                if segs.pop().is_none() {
                    return String::new(); // climbed above `src/` — outside the corpus we model
                }
            }
            other => segs.push(other),
        }
    }
    strip_ext(&segs.join("/"))
}

fn strip_ext(p: &str) -> String {
    match p.rfind('.') {
        Some(dot) if !p[dot + 1..].contains('/') => p[..dot].to_string(),
        _ => p.to_string(),
    }
}

/// Determine usage for every component, judged against `corpus` — `(label, text)` pairs the caller
/// walked. The caller owns the file system; this is pure, so the whole rule is testable.
pub fn scan(components: &[Value], corpus: &[(String, String)]) -> ScanReport {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    let live: Vec<&Value> = components
        .iter()
        .filter(|c| c.get("suppressed").and_then(Value::as_bool) != Some(true))
        .filter(|c| !s(c, "id").is_empty())
        .collect();

    // ── the corpus, read once ────────────────────────────────────────────────────────────────────
    let mut mounts: BTreeMap<String, i64> = BTreeMap::new();
    let mut imports: BTreeMap<String, i64> = BTreeMap::new();
    let mut globs: BTreeSet<String> = BTreeSet::new();
    let mut bases: BTreeMap<String, i64> = BTreeMap::new();
    for (label, text) in corpus {
        for id in mount_ids(text) {
            *mounts.entry(id).or_default() += 1;
        }
        // A file entry is labelled `file:<path>`; a record has no path, so relative imports inside a
        // record contribute no base (records import by their `@/` alias by convention).
        let from_rel = label.strip_prefix("file:").map(to_src_rel).unwrap_or_default();
        for spec in crate::graph_health::import_specifiers(text) {
            let base = import_base(&spec, &from_rel);
            if !base.is_empty() {
                *bases.entry(base).or_default() += 1;
            }
            *imports.entry(spec).or_default() += 1;
        }
        globs.extend(glob_patterns(text));
    }

    // ── composes-inverse, within a kit (composes is name-keyed, and kits never cross) ────────────
    let mut composed: BTreeMap<(String, String), i64> = BTreeMap::new();
    for c in &live {
        let kit = s(c, "kitId");
        if let Some(arr) = c.get("composes").and_then(Value::as_array) {
            for child in arr.iter().filter_map(Value::as_str) {
                *composed.entry((kit.clone(), child.to_string())).or_default() += 1;
            }
        }
    }

    let mut rows: Vec<UsageRow> = Vec::with_capacity(live.len());
    for c in &live {
        let id = s(c, "id");
        let name = s(c, "name");
        let kit = s(c, "kitId");
        let mut used = 0i64;
        let mut sources = Vec::new();

        let by_composes = composed.get(&(kit.clone(), name.clone())).copied().unwrap_or(0);
        if by_composes > 0 {
            used += by_composes;
            sources.push(Source::Composes);
        }
        let by_mount = mounts.get(&id).copied().unwrap_or(0);
        if by_mount > 0 {
            used += by_mount;
            sources.push(Source::Mount);
        }
        let spec = s(c, "provides").trim().to_string();
        if !spec.is_empty() {
            let literal = imports.get(&spec).copied().unwrap_or(0);
            let globbed = globs.iter().any(|g| glob_reaches(g, &spec));
            // A glob counts as ONE reference: it proves the module is reachable, never how often.
            let by_provides = literal + i64::from(globbed);
            if by_provides > 0 {
                used += by_provides;
                sources.push(Source::Provides);
            }
        }
        let base = src_base(&s(c, "src"));
        if !base.is_empty() {
            let by_path = bases.get(&base).copied().unwrap_or(0);
            if by_path > 0 {
                used += by_path;
                sources.push(Source::Path);
            }
        }
        rows.push(UsageRow { id, name, kit, used, sources });
    }
    rows.sort_by(|a, b| b.used.cmp(&a.used).then_with(|| a.id.cmp(&b.id)));
    ScanReport { roots: corpus.iter().map(|(l, _)| l.clone()).collect(), rows }
}

/// An absolute-or-relative file path reduced to its `src/`-relative form, so [`import_base`] can resolve
/// a relative specifier against it. A path with no `src/` segment yields empty (not part of this corpus).
fn to_src_rel(path: &str) -> String {
    match path.rfind("/src/") {
        Some(i) => path[i + 1..].replace('\\', "/"),
        None if path.starts_with("src/") => path.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn c(id: &str, name: &str, extra: serde_json::Value) -> Value {
        let mut v = json!({ "id": id, "name": name, "kitId": "k", "role": "composite", "composes": [] });
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            for (k, val) in e {
                o.insert(k.clone(), val.clone());
            }
        }
        v
    }
    fn corpus(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items.iter().map(|(l, t)| (l.to_string(), t.to_string())).collect()
    }
    fn row<'a>(r: &'a ScanReport, id: &str) -> &'a UsageRow {
        r.rows.iter().find(|x| x.id == id).unwrap_or_else(|| panic!("no row for {id}"))
    }

    /// The three shapes usage takes, each proven to fire ON ITS OWN — a source that only ever agrees
    /// with another source is untested.
    #[test]
    fn each_source_reports_usage_on_its_own() {
        let comps = [
            c("child", "Child", json!({})),
            c("parent", "Parent", json!({ "composes": ["Child"] })),
            c("mounted", "Mounted", json!({})),
            c("claimer", "Claimer", json!({ "provides": "@/features/x/Card" })),
            c("pathed", "Pathed", json!({ "src": "src/app/App.tsx" })),
            c("nobody", "Nobody", json!({ "src": "src/app/Unused.tsx", "provides": "@/gone/Nothing" })),
        ];
        let corp = corpus(&[
            ("record:host", "<GraphComponent id=\"mounted\" kit=\"k\" />"),
            ("file:/repo/src/app/main.tsx", "import { Card } from \"@/features/x/Card\";\nimport App from \"@/app/App\";"),
        ]);
        let r = scan(&comps, &corp);

        assert_eq!(row(&r, "child").sources, vec![Source::Composes], "composes-inverse");
        assert_eq!(row(&r, "mounted").sources, vec![Source::Mount], "a host mount");
        assert_eq!(row(&r, "claimer").sources, vec![Source::Provides], "an imported specifier");
        assert_eq!(row(&r, "pathed").sources, vec![Source::Path], "its `src` reached by the `@/` alias");

        // The one nothing references stays at zero — the alert must keep working, or this whole verb is
        // a way to mark the library used and stop looking.
        assert_eq!(row(&r, "nobody").used, 0, "nothing composes, mounts, imports or paths to it");
        assert!(row(&r, "nobody").sources.is_empty());
        // TWO with no usage, not one: `parent` composes `Child` but nothing references `parent` itself.
        // A composer is an ordinary node and can be an unused root — which is exactly the entry-point
        // shape this whole issue is about, and the reason the count is reported rather than assumed.
        assert_eq!(r.unused(), 2, "and the report counts them: {:?}", r.rows);
        assert_eq!(row(&r, "parent").used, 0);

        // The corpus is INSPECTABLE — the report names what it walked, not just how many.
        assert_eq!(r.roots, ["record:host", "file:/repo/src/app/main.tsx"]);
    }

    /// A regex over `from "…"` under-counts, and the failure mode is the worst one: a module reports
    /// UNUSED because the scanner could not see its import. `algorithmsgraphhost`,
    /// `automationsgraphhost` and `datagraphhost` are reached only through `lazyWorkspaces`' glob.
    #[test]
    fn a_dynamic_import_and_a_glob_are_imports() {
        let comps = [
            c("lazy", "Lazy", json!({ "provides": "@/features/lazy/Lazy" })),
            c("globbed", "Globbed", json!({ "provides": "@/features/globbed/index" })),
            c("neither", "Neither", json!({ "provides": "@/features/elsewhere/Nope" })),
        ];
        let corp = corpus(&[(
            "record:workspaces",
            "const L = () => import(\"@/features/lazy/Lazy\");\n\
             const all = import.meta.glob(\"@/features/globbed/*\");",
        )]);
        let r = scan(&comps, &corp);
        assert_eq!(row(&r, "lazy").sources, vec![Source::Provides], "a dynamic import() is an import");
        assert_eq!(row(&r, "globbed").sources, vec![Source::Provides], "import.meta.glob reaches it");
        assert_eq!(row(&r, "neither").used, 0, "and the glob does not reach everything: {:?}", r.rows);
    }

    /// The corpus is the kit's own RECORDS plus declared trees — post-#3604 the app's modules ARE
    /// records, so a repo-tree-only corpus reports every migrated page unused.
    #[test]
    fn the_store_is_part_of_the_corpus() {
        let comps = [
            c("page", "Page", json!({})),
            c("host", "Host", json!({ "srcText": "<GraphComponent id=\"page\" />" })),
        ];
        // ONLY the record supplies the mount — there is no file in this corpus at all.
        let r = scan(&comps, &corpus(&[("record:host", "<GraphComponent id=\"page\" />")]));
        assert_eq!(row(&r, "page").sources, vec![Source::Mount], "a record can be the only mount site");
    }

    /// A relative import resolves against the importing FILE, which is why the corpus carries paths.
    /// `main.tsx` reaching `./App` is how the application root is referenced, and reading it as unused
    /// is what nearly authorized deleting `App`.
    #[test]
    fn a_relative_import_resolves_against_the_importing_file() {
        let comps = [
            c("app", "App", json!({ "src": "src/app/App.tsx" })),
            c("deep", "Deep", json!({ "src": "src/shared/ui/Box.tsx" })),
        ];
        let r = scan(&comps, &corpus(&[
            ("file:/home/x/repo/src/app/main.tsx", "import App from \"./App\";"),
            ("file:/home/x/repo/src/app/console/Pane.tsx", "import { Box } from \"../../shared/ui/Box\";"),
        ]));
        assert_eq!(row(&r, "app").sources, vec![Source::Path], "./App from src/app/main.tsx");
        assert_eq!(row(&r, "deep").sources, vec![Source::Path], "../../shared/ui/Box from src/app/console");
    }

    #[test]
    fn the_path_and_import_base_helpers_agree_on_the_alias_mapping() {
        assert_eq!(src_base("src/app/App.tsx"), "app/App");
        assert_eq!(src_base("src/features/x/index.ts"), "features/x/index");
        assert_eq!(src_base("vendor/thing.tsx"), "", "outside `src/` there is no alias to reach it by");
        assert_eq!(import_base("@/app/App", ""), "app/App");
        assert_eq!(import_base("./App", "src/app/main.tsx"), "app/App");
        assert_eq!(import_base("../ui/Box", "src/app/console/Pane.tsx"), "app/ui/Box");
        assert_eq!(import_base("react", "src/app/main.tsx"), "", "a bare package is not a first-party base");
        assert_eq!(import_base("./x", ""), "", "a record has no path, so its relatives resolve to nothing");
        assert_eq!(import_base("../../../escape", "src/a/b.tsx"), "", "climbing above `src/` is out of corpus");
    }

    /// A tombstone is not a component — it must not appear in the report, and must not be counted as an
    /// importer (its content is gone, so it can only ever dilute).
    #[test]
    fn a_tombstone_is_neither_examined_nor_an_importer() {
        let comps = [
            c("live", "Live", json!({ "provides": "@/x/Live" })),
            json!({ "id": "tomb", "suppressed": true, "supersededBy": "live" }),
        ];
        let r = scan(&comps, &corpus(&[("record:other", "import { L } from \"@/x/Live\";")]));
        assert!(!r.rows.iter().any(|x| x.id == "tomb"), "a tombstone is not examined: {:?}", r.rows);
        assert_eq!(row(&r, "live").used, 1);
    }

    /// `composes` is name-keyed WITHIN a kit — a same-named component in another kit is not a composer.
    #[test]
    fn composes_never_crosses_a_kit() {
        let comps = [
            c("mine", "Card", json!({})),
            json!({ "id": "theirs", "name": "Wrapper", "kitId": "other", "role": "composite", "composes": ["Card"] }),
        ];
        let r = scan(&comps, &corpus(&[]));
        assert_eq!(row(&r, "mine").used, 0, "a composer in another kit is not a composer: {:?}", r.rows);
    }

    /// #113: a JSX tag, a named import, and a default import are each classified — the three shapes a
    /// missing-`composes`-edge reference actually takes.
    #[test]
    fn name_mentions_classifies_jsx_and_import_and_bare() {
        assert_eq!(name_mentions("<Widget prop={1} />", "Widget"), vec![MentionKind::JsxTag]);
        assert_eq!(name_mentions("<Widget>text</Widget>", "Widget"), vec![MentionKind::JsxTag, MentionKind::JsxTag]);
        assert_eq!(
            name_mentions("import { Widget } from \"@/x/Widget\";", "Widget"),
            vec![MentionKind::ImportClause],
            "a named import binding",
        );
        assert_eq!(
            name_mentions("import Widget from \"@/x/Widget\";", "Widget"),
            vec![MentionKind::ImportClause],
            "a default import binding",
        );
        assert_eq!(name_mentions("const x: Widget = make();", "Widget"), vec![MentionKind::Bare], "a bare type reference");
        assert_eq!(name_mentions("Widget.Variant.Compact", "Widget"), vec![MentionKind::Bare], "dot access");
    }

    /// Whole-word only — `Name` must never match inside `NameField`, in either direction.
    #[test]
    fn name_mentions_is_whole_word_only() {
        assert!(name_mentions("<WidgetField />", "Widget").is_empty());
        assert!(name_mentions("<BigWidget />", "Widget").is_empty());
        assert!(name_mentions("const WidgetFactory = 1;", "Widget").is_empty());
    }

    /// A mention inside a comment or an unrelated string literal is noise, not a reference — skipped
    /// exactly like `mount_ids`/`glob_patterns` skip them.
    #[test]
    fn name_mentions_skips_comments_and_strings() {
        assert!(name_mentions("// uses Widget somewhere\nconst x = 1;", "Widget").is_empty());
        assert!(name_mentions("/* Widget */ const x = 1;", "Widget").is_empty());
        assert!(name_mentions("const label = \"Widget\";", "Widget").is_empty());
    }

    /// The clause tracker resets at `;` so a mention in the NEXT statement is never misread as still
    /// being inside the previous import clause.
    #[test]
    fn name_mentions_clause_tracking_resets_at_semicolon() {
        assert_eq!(
            name_mentions("import { X } from \"@/x\";\nconst Widget = 1;", "Widget"),
            vec![MentionKind::Bare],
            "a later statement is never read as still inside the import clause",
        );
    }
}
