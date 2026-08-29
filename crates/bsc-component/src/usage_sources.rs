//! Real usage sources for the dead-root heuristic (#3888, the designer-visible face: `bsc request` #95).
//!
//! `graph_health::analyze`'s dead-root check fires on `in-degree 0 AND used == 0` — but `used` is a
//! reuse count NOTHING writes (see `graph_health::usage_index_populated`), so every entry point that
//! nothing else `composes` (every page, every `provides` record the app imports by specifier rather than
//! composing) reads as a false orphan/dangling-branch. `in-degree` already answers "does another RECORD
//! compose me"; what's missing is "does the RUNNING APP reach me at all" — a HOST MOUNT
//! (`<GraphComponent id="…">`) or a `provides` specifier actually imported somewhere.
//!
//! Rather than a flat text scan (which misses indirection — a page is host-mounted from a `*GraphHost`
//! record, which is reached from `lazyWorkspaces` — itself an ALGORITHM IMPL, not a component — which is
//! reached from the app's real `main.tsx`), this walks REACHABILITY from the app's actual entry point,
//! the same way the browser's module loader would: real files → records (by sibling id or `provides`) →
//! algorithm impls (`provides`) → their own imports, transitively. Reuses `closure::Index`, built for the
//! same resolution chain to materialize a record's test closure (`materialize-a-records-record-closure`).
//!
//! A node reached by this walk is proven USED — by an actual entry point, not an inference — so it is
//! folded into `used` (see [`enrich_used`]) purely to SUPPRESS the false-positive finding. It deliberately
//! does NOT touch `prune_plan`'s `usage_index_populated` guard (still keyed on the store's real, persisted
//! `used` field): this walk is necessarily incomplete (a repo without `src/app/main.tsx` on disk — a
//! different kit's context, or a packaged build with no source tree — returns an empty reachable set,
//! silently, by construction) and MUST NEVER be the thing that turns `--fix --yes` from "prunes nothing"
//! into "prunes everything this walk didn't happen to reach." Widening what counts as an unreachable
//! finding is safe (fewer false positives); widening what `--fix` is willing to delete is not, and this
//! module does not do the second thing.

use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// The app's real (non-record) entry point, `src/`-relative. Everything else — every page, every
/// `*GraphHost`, `lazyWorkspaces`, `DetachedWindow` — is reached TRANSITIVELY from here (`main.tsx`
/// dynamically `import("./App")`s, `App.tsx` statically imports `DetachedWindow`, and so on), so one
/// root suffices. Only base-studio-code's OWN repo has this file; scanning any other tree (a generated
/// project's kit, a harvested kit) simply finds nothing and [`reachable_ids`] returns empty — see the
/// module doc for why that silent degradation is the safe default rather than a special case.
const ENTRY_FILES: &[&str] = &["app/main.tsx"];

/// What [`reachable_ids`] actually scanned, so the corpus is INSPECTABLE rather than a black box (#3888
/// acceptance: "the scan corpus for a kit is explicit and inspectable, not inferred").
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct UsageReport {
    /// Component/impl ids proven reachable from a real entry point.
    pub reached: BTreeSet<String>,
    /// How many of [`ENTRY_FILES`] were actually found and read (0 ⇒ no `src/` tree here — the walk is a
    /// no-op, not a false claim of emptiness).
    pub entry_files_read: usize,
    /// Every real file read during the walk, entry points included — the human-readable corpus size.
    pub files_scanned: usize,
}

/// Every component/impl id reachable from the app's real entry point(s), walking real files → records →
/// impls → their own imports, transitively (mirrors the runtime loader's own resolution chain via
/// `closure::Index`). `repo_root` is normally the CWD (`--repo`, else `bsc ui doctor`'s default) — when
/// its `src/<entry>` doesn't exist, this returns an empty [`UsageReport`] rather than erroring, since a
/// non-base-studio-code repo (a different kit's context) legitimately has no such entry file.
pub(crate) fn reachable_ids(
    components: &[Value],
    impls: &[Value],
    platform: &BTreeSet<String>,
    repo_root: Option<&Path>,
) -> UsageReport {
    let mut report = UsageReport::default();
    let index = crate::closure::Index::new(components, impls, platform, repo_root);
    let Some(src_root) = index.src_root() else { return report };

    let mut walked_files: BTreeSet<PathBuf> = BTreeSet::new();
    let mut walked_records: BTreeSet<String> = BTreeSet::new();
    // (source text, the `src/`-relative path RELATIVE imports inside it resolve against)
    let mut stack: Vec<(String, String)> = Vec::new();

    for entry in ENTRY_FILES {
        let file = src_root.join(entry);
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        if walked_files.insert(file) {
            report.entry_files_read += 1;
            report.files_scanned += 1;
            stack.push((text, (*entry).to_string()));
        }
    }

    while let Some((src, from_rel)) = stack.pop() {
        // A HOST MOUNT (`<GraphComponent id="…">`) reaches a component by bare ID, not by import — the
        // page-tier gap #3888 is actually about (a page is never `composes`d, so in-degree alone always
        // reads it as an orphan; a real host mount is the only true "the app renders this" signal it
        // has). Every mount site measured (#3888) writes `id` as the literal FIRST attribute.
        for id in host_mounted_ids(&src) {
            if report.reached.insert(id.clone()) {
                if let Some(comp) = index.component_by_id(&id) {
                    let src_text = comp.get("srcText").and_then(Value::as_str).unwrap_or_default();
                    if !src_text.is_empty() && walked_records.insert(id.clone()) {
                        stack.push((src_text.to_string(), format!("{id}.tsx")));
                    }
                }
            }
        }
        for spec in crate::graph_health::live_specifiers(&src) {
            if !crate::graph_health::is_internal_specifier(&spec) {
                continue; // a bare npm specifier — never a record, impl, or app file
            }
            let Some(base) = crate::graph_health::resolve_internal_base(&spec, &from_rel) else {
                continue;
            };
            let key = format!("@/{base}");
            // A record/impl always wins, mirroring the runtime resolver's own precedence (a `provides`
            // record is a deliberate override of a boundary module of the same specifier).
            if let Some((id, _origin, source, ext)) = index.lookup(&key, &base) {
                report.reached.insert(id.clone());
                if walked_records.insert(id) {
                    stack.push((source, format!("{base}.{ext}")));
                }
                continue;
            }
            // Not a record/impl — an ordinary real file. Unlike the test-closure walk (which restricts a
            // RECORD's escape into real files to the DECLARED platform boundary), a real entry file can
            // reach any real file the repo actually has — that is just the app being the app.
            let Some(file) = crate::closure::file_for(src_root, &base) else { continue };
            if !walked_files.insert(file.clone()) {
                continue;
            }
            report.files_scanned += 1;
            let Ok(text) = std::fs::read_to_string(&file) else { continue };
            let anchor = file
                .strip_prefix(src_root)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or(base);
            stack.push((text, anchor));
        }
    }
    report
}

/// Every `id="…"` a `<GraphComponent id="…">` host-mount literal names in `source` — the literal-string
/// attribute the runtime mounts a graph page BY (`GraphComponent.tsx`, `id` is a `string`, never a
/// variable at any real call site). Deliberately narrow: `id` must be the tag's FIRST attribute (every
/// site measured for #3888 writes it that way) — a loose "any `id=` anywhere after the tag name" scan
/// would also catch an unrelated `id` on a DIFFERENT element nested inside a later prop
/// (`fallback={<Other id="x"/>}`), over-crediting `x` as host-mounted when nothing mounts it that way.
fn host_mounted_ids(source: &str) -> Vec<String> {
    const TAG: &str = "<GraphComponent";
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = source[from..].find(TAG) {
        let after_tag = from + rel + TAG.len();
        let rest = &source[after_tag..];
        let trimmed = rest.trim_start();
        if let Some(id_rest) = trimmed.strip_prefix("id") {
            let id_rest = id_rest.trim_start();
            if let Some(eq_rest) = id_rest.strip_prefix('=') {
                let eq_rest = eq_rest.trim_start();
                let mut chars = eq_rest.char_indices();
                if let Some((_, quote @ ('"' | '\''))) = chars.next() {
                    let body = &eq_rest[quote.len_utf8()..];
                    if let Some(end) = body.find(quote) {
                        out.push(body[..end].to_string());
                    }
                }
            }
        }
        from = after_tag;
    }
    out
}

/// `components` with `used` raised to at least 1 for every id [`reachable_ids`] proved used and whose
/// stored `used` was `<= 0` — the enrichment [`reachable_ids`] exists to feed into the dead-root check,
/// which reads `used` off the `Value` (`graph_health::parse_node`). Never LOWERS an existing count, and
/// never touches a record `reached` does not name — this is additive evidence only.
pub(crate) fn enrich_used(components: &[Value], reached: &BTreeSet<String>) -> Vec<Value> {
    components
        .iter()
        .map(|v| {
            let id = v.get("id").and_then(Value::as_str).unwrap_or_default();
            let already_used = v.get("used").and_then(Value::as_i64).unwrap_or(0) > 0;
            if already_used || !reached.contains(id) {
                return v.clone();
            }
            let mut enriched = v.clone();
            enriched["used"] = serde_json::json!(1);
            enriched
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn write(dir: &Path, rel: &str, contents: &str) {
        let path = dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn no_src_tree_returns_an_empty_report_rather_than_erroring() {
        let dir = std::env::temp_dir().join(format!("usage-sources-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let report = reachable_ids(&[], &[], &BTreeSet::new(), Some(&dir));
        assert_eq!(report, UsageReport::default());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The exact real-world shape (#3888): `main.tsx` dynamically `import("./App")`s, `App.tsx` mounts
    /// a page through a `*GraphHost` record (`<GraphComponent id="fleetpage">`), and the host record
    /// itself is reached only through an ALGORITHM IMPL (`lazyWorkspaces`, not a component) that a
    /// third real file imports by its `provides` specifier — three hops, two of them off the record
    /// graph entirely, which a flat "is this specifier imported anywhere" text scan cannot follow.
    #[test]
    fn reaches_a_host_mounted_page_through_a_real_file_and_an_algorithm_impl() {
        let dir = std::env::temp_dir().join(format!("usage-sources-chain-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "src/app/main.tsx", r#"await import("./App");"#);
        write(
            &dir,
            "src/app/App.tsx",
            r#"import { FleetWorkspace } from "@/app/lazyWorkspaces";
export function App() { return <FleetWorkspace />; }"#,
        );
        let components = vec![
            json!({
                "id": "fleetgraphhost", "name": "FleetGraphHost", "kitId": "k",
                "provides": "@/app/features/fleet/FleetGraphHost",
                "srcText": r#"import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
export function FleetGraphHost() { return <GraphComponent id="fleetpage" />; }"#,
            }),
            // The mount names it by bare id, not by `provides` — the page record itself has no
            // specifier anything imports; ONLY the host mount proves it's used.
            json!({ "id": "fleetpage", "name": "FleetPage", "kitId": "k", "role": "page" }),
        ];
        let impls = vec![json!({
            "id": "lazy-workspaces.ts",
            "provides": "@/app/lazyWorkspaces",
            "code": r#"export { FleetGraphHost as FleetWorkspace } from "@/app/features/fleet/FleetGraphHost";"#,
        })];
        let report = reachable_ids(&components, &impls, &BTreeSet::new(), Some(&dir));
        assert!(report.reached.contains("fleetgraphhost"), "reached: {:?}", report.reached);
        assert!(report.reached.contains("lazy-workspaces.ts"));
        assert!(report.reached.contains("fleetpage"), "the host-mounted PAGE itself: {:?}", report.reached);
        assert_eq!(report.entry_files_read, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn host_mounted_ids_requires_id_as_the_first_attribute() {
        let ids = host_mounted_ids(r#"<GraphComponent id="fleetpage" fallback={<Other id="decoy"/>} />"#);
        assert_eq!(ids, vec!["fleetpage".to_string()]);
        // `id` is not the first attribute here — a real mount site never writes it this way (#3888
        // measured all sites), so under-crediting is the safe failure mode.
        assert!(host_mounted_ids(r#"<GraphComponent fallback={<X/>} id="late" />"#).is_empty());
    }

    #[test]
    fn a_record_nothing_reaches_from_the_entry_point_is_not_marked_used() {
        let dir = std::env::temp_dir().join(format!("usage-sources-unreached-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(&dir, "src/app/main.tsx", r#"console.log("boot");"#);
        let components = vec![json!({
            "id": "orphan-card", "name": "OrphanCard", "kitId": "k",
            "provides": "@/shared/ui/OrphanCard",
            "srcText": "export function OrphanCard() { return null; }",
        })];
        let report = reachable_ids(&components, &[], &BTreeSet::new(), Some(&dir));
        assert!(!report.reached.contains("orphan-card"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn enrich_used_raises_only_reached_ids_that_were_not_already_used() {
        let reached: BTreeSet<String> = ["a".to_string(), "b".to_string()].into_iter().collect();
        let components = vec![
            json!({ "id": "a", "used": 0 }),           // reached, unpopulated → raised
            json!({ "id": "b", "used": 5 }),            // reached, already used → unchanged
            json!({ "id": "c", "used": 0 }),            // not reached → unchanged (still 0)
        ];
        let out = enrich_used(&components, &reached);
        assert_eq!(out[0]["used"], json!(1));
        assert_eq!(out[1]["used"], json!(5));
        assert_eq!(out[2]["used"], json!(0));
    }
}
