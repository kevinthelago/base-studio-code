//! REFRESH A DRIFTED SEED FROM ITS FILE — `bsc ui refresh-seed`, ported from
//! `scripts/refresh-drifted-seeds.mjs`. The step that turns a drifted retirement candidate into a
//! retirable one.
//!
//! WHY IT IS SAFE ONLY FOR SOME. A seed's source is a projection of the file taken at migration time, and
//! the two drift. Refreshing FROM the file is correct exactly when the record has no independent history
//! worth keeping — and the three-way (seed vs STORE vs file) is what says so:
//!
//!   store == seed   the record has NEVER been edited since packaging, so the drift is entirely the file
//!                   moving on. Refreshing loses nothing.  ← the only case this touches
//!   store != seed   a designer edited the record. Refreshing would DISCARD that edit, and deciding
//!                   whether it was a deliberate improvement is a judgement, not a tool's call.
//!
//! It refuses the second rather than asking.
//!
//! THE PREAMBLE SURVIVES. Every migrated record opens with an "AS GRAPH SOURCE" comment block the file
//! never had, recording why the record exists and what `provides` does. Overwriting the source with the
//! raw file deletes it — that happened, and four records SHRANK while their change only added attributes.

use bsc_record::record_source::{code_only, exported_names, norm, split_preamble};

/// What a refresh would do to one seed.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The seed already carries the file's code; nothing to do.
    AlreadyOk,
    /// A designer edited the record since packaging — or its live copy could not be read at all. An
    /// ABSENT store must never read as "nobody edited it", so both collapse to the same refusal.
    Edited,
    /// The file's version would DROP an export something actually imports. A record can carry a
    /// deliberate standalone adaptation the file never had: `graphcanvas` inlines `GraphViewport`, which
    /// the file only `import type`s, and `ui-tree` imports that type FROM the record. Refreshing compiles
    /// the record fine and breaks its consumer — and the store gate cannot see it, because the record is
    /// pristine.
    WouldDropExport { lost: Vec<String>, consumers: Vec<String> },
    /// A RECORD could not resolve everything this source imports. Absolutizing is not enough on its own:
    /// a FILE may import a plain sibling, and a sibling is a perfectly good import for a file and an
    /// unresolvable one for a record — the loader has only the registry and the record store.
    Unresolvable(Vec<String>),
    /// Refresh it. `next` is the full replacement source, preamble included.
    Refresh { next: String, preamble_lines: usize },
}

/// The store gate: has a designer edited this record since it was packaged?
pub fn was_edited(seed_source: &str, live_source: Option<&str>) -> bool {
    let Some(live) = live_source else { return true };
    code_only(&norm(live)) != code_only(&norm(seed_source))
}

/// The export gate: which exports would the file's version drop that something actually imports?
/// `consumers_of` answers "who imports this name from this specifier".
pub fn dropped_exports(
    seed_source: &str,
    file_src: &str,
    consumers_of: &dyn Fn(&str) -> Vec<String>,
) -> Option<(Vec<String>, Vec<String>)> {
    let (seed_ex, file_ex) = (exported_names(&norm(seed_source))?, exported_names(file_src)?);
    let mut lost: Vec<String> = Vec::new();
    let mut who: Vec<String> = Vec::new();
    for n in seed_ex.difference(&file_ex) {
        let c = consumers_of(n);
        if !c.is_empty() {
            lost.push(n.clone());
            who.extend(c);
        }
    }
    if lost.is_empty() {
        return None;
    }
    who.sort();
    who.dedup();
    Some((lost, who))
}

/// The `@/…` specifiers a source imports, deduped in first-seen order. Asset imports are excluded —
/// they are handled by the bundler, not the record loader.
pub fn imported_specifiers(src: &str) -> Vec<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"(?:from|import|require)\s*\(?\s*['"](@/[^'"]+)['"]"#).expect("imports")
    });
    let mut out: Vec<String> = Vec::new();
    for c in re.captures_iter(src) {
        let s = c[1].to_string();
        if [".css", ".svg", ".png", ".json"].iter().any(|e| s.ends_with(e)) {
            continue;
        }
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}

/// Decide one seed. `resolvable` answers whether a RECORD can resolve a specifier.
#[allow(clippy::too_many_arguments)]
pub fn decide(
    seed_source: &str,
    file_src: &str,
    live_source: Option<&str>,
    consumers_of: &dyn Fn(&str) -> Vec<String>,
    resolvable: &dyn Fn(&str) -> bool,
) -> Verdict {
    let normalized = norm(seed_source);
    let (preamble, body) = split_preamble(&normalized, file_src);
    if code_only(&body) == code_only(file_src) {
        return Verdict::AlreadyOk;
    }
    if was_edited(seed_source, live_source) {
        return Verdict::Edited;
    }
    if let Some((lost, consumers)) = dropped_exports(seed_source, file_src, consumers_of) {
        return Verdict::WouldDropExport { lost, consumers };
    }
    let unresolved: Vec<String> =
        imported_specifiers(file_src).into_iter().filter(|s| !resolvable(s)).collect();
    if !unresolved.is_empty() {
        return Verdict::Unresolvable(unresolved);
    }
    let next = if preamble.is_empty() {
        format!("{file_src}\n")
    } else {
        format!("{preamble}\n{file_src}\n")
    };
    let preamble_lines = if preamble.is_empty() { 0 } else { preamble.split('\n').count() };
    Verdict::Refresh { next, preamble_lines }
}

/// Serialize the packaged `algorithms.json` the way the file on disk is actually written: 2-space
/// indent, non-ASCII kept LITERAL, and a trailing newline.
///
/// Pinned by `the_shipped_algorithms_seed_round_trips_byte_for_byte`, which is the only assertion here
/// that cannot drift. Two other scripts carry a docstring claiming 1-space + `ensure_ascii` + no trailing
/// newline; measured against the shipped file that reconstruction differs by 72,941 bytes, so running one
/// reformats the whole 6.6 MB and buries the real change in a 22,500-line diff
/// (`the-seed-serializers-do-not-match-the-seed`).
pub fn serialize_algorithms(v: &serde_json::Value) -> Result<String, String> {
    serde_json::to_string_pretty(v).map(|s| format!("{s}\n")).map_err(|e| e.to_string())
}

/// One packaged seed that carries a `@/…` specifier and real source.
pub struct Seed {
    /// `"component"` or `"impl"` — a difference of STORAGE, not of kind. A component is one JSON file;
    /// an impl is one entry inside the single `algorithms.json`, which is why impl writes are batched.
    pub kind: &'static str,
    /// The component seed's own file. `None` for an impl.
    pub path: Option<std::path::PathBuf>,
    pub id: String,
    pub spec: String,
    pub source: String,
}

/// Every packaged COMPONENT seed under `src-tauri/data/components`, plus every algorithms IMPL.
///
/// ALGORITHM IMPLS ARE SEEDS TOO, and leaving them out was the gap this closed: a module packaged as an
/// impl carries its source in `code` rather than `srcText` and lives inside one document rather than a
/// file of its own. The gates apply unchanged, so their absence bought only that an impl whose FILE moved
/// on could never be refreshed.
pub fn collect(repo: &std::path::Path) -> (Vec<Seed>, Option<serde_json::Value>) {
    let mut out: Vec<Seed> = Vec::new();
    fn walk(dir: &std::path::Path, out: &mut Vec<Seed>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        let mut paths: Vec<std::path::PathBuf> = entries.flatten().map(|e| e.path()).collect();
        paths.sort();
        for p in paths {
            if p.is_dir() {
                walk(&p, out);
                continue;
            }
            if p.extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            // The packaged kit blobs are not per-record seeds; parsing them here is pure cost.
            if std::fs::metadata(&p).map(|m| m.len() > 4_000_000).unwrap_or(true) {
                continue;
            }
            let Ok(body) = std::fs::read_to_string(&p) else { continue };
            let Ok(r) = serde_json::from_str::<serde_json::Value>(&body) else { continue };
            let spec = r.get("provides").and_then(serde_json::Value::as_str).unwrap_or("").trim();
            let src = r.get("srcText").and_then(serde_json::Value::as_str).unwrap_or("");
            let id = r.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
            if spec.starts_with("@/") && !src.trim().is_empty() && !id.is_empty() {
                out.push(Seed {
                    kind: "component",
                    path: Some(p.clone()),
                    id: id.to_string(),
                    spec: spec.to_string(),
                    source: src.to_string(),
                });
            }
        }
    }
    walk(&repo.join("src-tauri/data/components"), &mut out);

    // A checkout without the algorithm seed is still valid.
    let algos: Option<serde_json::Value> =
        std::fs::read_to_string(repo.join("src-tauri/data/knowledge/algorithms.json"))
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok());
    if let Some(a) = algos.as_ref() {
        for im in a.get("implementations").and_then(serde_json::Value::as_array).into_iter().flatten() {
            let spec = im.get("provides").and_then(serde_json::Value::as_str).unwrap_or("").trim();
            let code = im.get("code").and_then(serde_json::Value::as_str).unwrap_or("");
            let id = im.get("id").and_then(serde_json::Value::as_str).unwrap_or("");
            if spec.starts_with("@/") && !code.trim().is_empty() && !id.is_empty() {
                out.push(Seed {
                    kind: "impl",
                    path: None,
                    id: id.to_string(),
                    spec: spec.to_string(),
                    source: code.to_string(),
                });
            }
        }
    }
    (out, algos)
}

/// The `src/`-relative file a `@/…` specifier names, or `None` when it is already retired.
pub fn file_for(spec: &str, src_files: &std::collections::BTreeSet<String>) -> Option<String> {
    let base = spec.strip_prefix("@/")?;
    ["", ".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.tsx"]
        .iter()
        .map(|e| format!("{base}{e}"))
        .find(|c| src_files.contains(c))
}

/// Every `@/…` specifier → the named imports taken from it, and by whom.
///
/// Built over BOTH the packaged records and `src/`, because a record importing a record is exactly the
/// consumer a file-only sweep cannot see.
pub fn import_index(
    sources: &[(String, String)],
) -> std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'](@/[^"']+)["']"#)
            .expect("import index")
    });
    let mut index: std::collections::HashMap<String, std::collections::HashMap<String, Vec<String>>> =
        std::collections::HashMap::new();
    for (who, src) in sources {
        for c in re.captures_iter(src) {
            let entry = index.entry(c[2].to_string()).or_default();
            for part in c[1].split(',') {
                let n = part.trim().trim_start_matches("type ").trim();
                let n = n.split_whitespace().next().unwrap_or("");
                if n.is_empty() {
                    continue;
                }
                let who_list = entry.entry(n.to_string()).or_default();
                if !who_list.contains(who) {
                    who_list.push(who.clone());
                }
            }
        }
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "export const a = 1;\nexport const b = 2;\n";
    const PREAMBLE: &str = "// AS GRAPH SOURCE\n// why this record exists\n";

    fn no_consumers(_: &str) -> Vec<String> {
        Vec::new()
    }
    fn all_resolvable(_: &str) -> bool {
        true
    }

    /// NON-VACUITY: a pristine record whose file moved on IS refreshed. Without this every refusal below
    /// could be satisfied by a tool that refuses everything.
    #[test]
    fn a_pristine_record_whose_file_moved_on_is_refreshed() {
        let seed = "export const a = 1;\n";
        let v = decide(seed, FILE, Some(seed), &no_consumers, &all_resolvable);
        let Verdict::Refresh { next, preamble_lines } = v else { panic!("must refresh: {v:?}") };
        assert_eq!(next, format!("{FILE}\n"));
        assert_eq!(preamble_lines, 0);
    }

    #[test]
    fn a_seed_that_already_matches_its_file_is_already_ok() {
        assert_eq!(decide(FILE, FILE, Some(FILE), &no_consumers, &all_resolvable), Verdict::AlreadyOk);
    }

    /// THE STORE GATE, both directions. A record a designer edited is refused, because refreshing would
    /// discard that edit and deciding whether it was an improvement is a judgement.
    #[test]
    fn a_record_the_designer_edited_is_refused() {
        let seed = "export const a = 1;\n";
        let live = "export const a = 99; // a designer's fix\n";
        assert_eq!(decide(seed, FILE, Some(live), &no_consumers, &all_resolvable), Verdict::Edited);
    }

    /// ...and an ABSENT live copy is refused too. An absent store must never read as "nobody edited it" —
    /// that is the difference between refusing four records and silently overwriting them.
    #[test]
    fn an_absent_live_copy_is_refused_not_assumed_pristine() {
        assert_eq!(
            decide("export const a = 1;\n", FILE, None, &no_consumers, &all_resolvable),
            Verdict::Edited
        );
        assert!(was_edited("x", None), "no live copy is ALWAYS 'edited'");
    }

    /// THE EXPORT GATE. The record is pristine, so the store gate passes it straight through — this is
    /// the only thing standing between a refresh and a consumer that stops compiling.
    #[test]
    fn a_refresh_that_would_drop_an_imported_export_is_refused() {
        let seed = "export const a = 1;\nexport interface GraphViewport { x: number }\n";
        let consumers = |n: &str| {
            if n == "GraphViewport" { vec!["record:ui-tree".to_string()] } else { Vec::new() }
        };
        let v = decide(seed, FILE, Some(seed), &consumers, &all_resolvable);
        let Verdict::WouldDropExport { lost, consumers } = v else { panic!("{v:?}") };
        assert_eq!(lost, vec!["GraphViewport".to_string()]);
        assert_eq!(consumers, vec!["record:ui-tree".to_string()]);
    }

    /// ...but an export NOBODY imports is not a reason to refuse — otherwise every tidy-up would be
    /// blocked by a symbol no consumer ever asked for.
    #[test]
    fn an_export_nothing_imports_does_not_block_the_refresh() {
        let seed = "export const a = 1;\nexport const unusedThing = 2;\n";
        assert!(matches!(
            decide(seed, FILE, Some(seed), &no_consumers, &all_resolvable),
            Verdict::Refresh { .. }
        ));
    }

    /// THE RESOLVABLE GATE. A FILE may import a plain sibling; a record cannot resolve one, because the
    /// loader has only the registry and the record store. Refreshing three such seeds left five records
    /// importing specifiers nothing could serve.
    #[test]
    fn a_source_a_record_cannot_resolve_is_refused() {
        let file = "import { X } from \"@/shared/ui/charts/Charts\";\nexport const a = 1;\n";
        let resolvable = |s: &str| s != "@/shared/ui/charts/Charts";
        let v = decide("export const a = 0;\n", file, Some("export const a = 0;\n"), &no_consumers, &resolvable);
        assert_eq!(v, Verdict::Unresolvable(vec!["@/shared/ui/charts/Charts".to_string()]));
    }

    /// THE PREAMBLE SURVIVES VERBATIM, and the record does not SHRINK. Four records shrank this way while
    /// their change only added attributes.
    #[test]
    fn the_preamble_is_kept_verbatim_and_the_record_does_not_shrink() {
        let seed = format!("{PREAMBLE}export const a = 1;\n");
        let v = decide(&seed, FILE, Some(&seed), &no_consumers, &all_resolvable);
        let Verdict::Refresh { next, preamble_lines } = v else { panic!("{v:?}") };
        assert!(next.starts_with(PREAMBLE.trim_end()), "the preamble must lead, verbatim: {next:?}");
        assert!(next.contains("AS GRAPH SOURCE"));
        assert!(next.contains("export const b = 2;"), "and the file's new content must follow");
        assert!(next.len() > seed.len(), "the record must not SHRINK: {} -> {}", seed.len(), next.len());
        assert_eq!(preamble_lines, 2);
    }

    #[test]
    fn file_for_finds_a_barrel_and_reports_a_retired_specifier_as_none() {
        let files: std::collections::BTreeSet<String> =
            ["a/b.ts", "a/c/index.tsx"].iter().map(|s| s.to_string()).collect();
        assert_eq!(file_for("@/a/b", &files).as_deref(), Some("a/b.ts"));
        assert_eq!(file_for("@/a/c", &files).as_deref(), Some("a/c/index.tsx"));
        // Already retired — no file, so there is nothing to refresh FROM.
        assert_eq!(file_for("@/a/gone", &files), None);
    }

    /// The index must see a RECORD importing a record, which is the consumer a file-only sweep misses.
    #[test]
    fn the_import_index_covers_records_as_well_as_files() {
        let srcs = vec![
            ("record:ui-tree".to_string(),
             "import type { GraphViewport } from \"@/x/graph\";\n".to_string()),
            ("app/App.tsx".to_string(), "import { A, B as C } from \"@/x/graph\";\n".to_string()),
        ];
        let idx = import_index(&srcs);
        let g = idx.get("@/x/graph").expect("indexed");
        assert_eq!(g.get("GraphViewport").map(Vec::as_slice), Some(&["record:ui-tree".to_string()][..]));
        // `B as C` is imported under the name B — the alias is the consumer's business.
        assert!(g.contains_key("A") && g.contains_key("B"), "{g:?}");
    }

    #[test]
    fn imported_specifiers_dedupes_and_skips_assets() {
        let src = "import a from \"@/x/a\";\nimport b from \"@/x/a\";\nimport \"@/styles/tokens.css\";\n\
                   const c = require(\"@/x/c\");\nimport d from \"@/x/d.svg\";\n";
        assert_eq!(imported_specifiers(src), vec!["@/x/a".to_string(), "@/x/c".to_string()]);
    }

    /// THE ONLY ASSERTION ABOUT THE SEED FORMAT THAT CANNOT DRIFT: parse the SHIPPED file and re-serialize
    /// it, and the bytes must come back identical. Two other scripts document this format as 1-space +
    /// escaped non-ASCII + no trailing newline; measured, that reconstruction differs from the real file
    /// by 72,941 bytes, so running one reformats all 6.6 MB and buries the real change.
    #[test]
    fn the_shipped_algorithms_seed_round_trips_byte_for_byte() {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/data/knowledge/algorithms.json");
        let raw = std::fs::read_to_string(&p).expect("the packaged algorithms seed");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
        let out = serialize_algorithms(&v).expect("serialize");
        assert_eq!(out.len(), raw.len(), "re-serializing the shipped seed changed its LENGTH");
        assert!(out == raw, "re-serializing the shipped seed changed its BYTES");
    }
}
