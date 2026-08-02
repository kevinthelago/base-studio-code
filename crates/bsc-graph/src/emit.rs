//! `bsc graph emit` (#4192) — the algorithms library's store→file direction, the twin of `bsc ui emit`.
//!
//! The graph is the source of truth and a file is the emitted artifact, so maintenance edits the RECORD
//! and re-emits. Components could already do that; algorithms could only go file→store (`harvest`), which
//! made "edit the record, then re-emit" unexpressible for this library.
//!
//! # Why an emitted file is NOT written over the record's `src`
//!
//! This is the one place the algorithms emitter must NOT copy `bsc ui emit`, and it is a data-loss
//! difference rather than a stylistic one. A component record owns its file; an algorithm record is a
//! function LIFTED OUT of one. In this repo's own graph, of 63 algorithms carrying provenance, **34 share
//! their `src` with another impl** — `features/algorithms/viz/examples/sorts.ts` alone backs four, and
//! `crates/cve/src/install.rs` another four. Those files also hold code the harvest never lifted (imports,
//! types, registries).
//!
//! So writing a record's `code` to its `src` would delete its neighbours and everything around them.
//! Instead each record emits to its OWN file under the folder its provenance names — one record, one
//! file, nothing overwritten. What that gives you is a vendorable tree of real implementations; what it
//! deliberately does not give you is a blind write back over harvested source.
//!
//! Three classes are reported rather than emitted, each with its reason, because silence here reads as
//! "there was nothing to do":
//!   * a `primitive` — DESCRIBES a language built-in via `--ref` and is never re-coded (#2972);
//!   * a record with no `src`/`folder` — a canonical algorithm with no file in this repo (`--no-src`),
//!     so there is no tree position to emit it into;
//!   * a record with no `code` at all.

use bsc_cli_util::vendored::{body_of, classify, sha256_hex, stamp_line, SyncVerdict};
use serde_json::Value;

/// The store ref stamped into every emitted file — the algorithms twin of a kit id.
pub const STORE_ID: &str = "bsc/algorithms";
/// The command a reader is told to run to refresh a managed file.
pub const SYNC_CMD: &str = "bsc graph emit sync";

/// One file an emit would write: its store-tree-relative path and its final, stamped content.
#[derive(Debug, PartialEq, Eq)]
pub struct EmitFile {
    pub id: String,
    /// Path relative to the emit dir, POSIX-separated (`features/algorithms/merge-sort.ts`).
    pub path: String,
    pub content: String,
}

/// A record the emit deliberately did not write, and why — surfaced, never silently dropped.
#[derive(Debug, PartialEq, Eq)]
pub struct Skipped {
    pub id: String,
    pub reason: String,
}

/// What an emit would do: the files to write plus every record it declined, with reasons.
#[derive(Debug, Default)]
pub struct EmitPlan {
    pub files: Vec<EmitFile>,
    pub skipped: Vec<Skipped>,
}

fn field<'a>(im: &'a Value, k: &str) -> Option<&'a str> {
    im.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// The emit path for one record: `<folder>/<id>`, or `<id>` at the root when it carries no folder but
/// does carry a `src` (so its directory can still be derived).
///
/// The id already carries the language extension (`merge-sort.ts`, `merge.rs`), which is what makes one
/// record one compilable file — and what keeps it clear of the shared `src` it was lifted from.
fn emit_path(im: &Value) -> Option<String> {
    let id = field(im, "id")?;
    let folder = field(im, "folder").map(str::to_string).or_else(|| {
        // No folder recorded, but `src` implies one (#4107 derives folder FROM src; this covers a
        // record written before that, so provenance is not wasted).
        field(im, "src").and_then(|s| s.rsplit_once('/').map(|(d, _)| d.to_string()))
    })?;
    let folder = folder.trim_matches('/').replace('\\', "/");
    Some(if folder.is_empty() { id.to_string() } else { format!("{folder}/{id}") })
}

/// Render one record's final file content — the provenance stamp over its stored `code`.
///
/// The body is the code VERBATIM: unlike a component closure there are no first-party imports to
/// rewrite, because a stored implementation is a self-contained function.
fn render(code: &str, version: u64) -> String {
    let body = format!("{}\n", code.trim_end());
    let hash = sha256_hex(body.as_bytes());
    format!("{}\n{body}", stamp_line(STORE_ID, &version.to_string(), &hash, SYNC_CMD))
}

/// The store's schema version, stamped so an emitted file records which revision produced it.
pub fn store_version(graph: &Value) -> u64 {
    graph.get("version").and_then(Value::as_u64).unwrap_or(1)
}

/// Plan the emit for one record by id. `Err` when the id is not in the store at all — a caller asking
/// for a specific id deserves a hard error, not an empty plan it might read as success.
pub fn plan_one(graph: &Value, id: &str) -> Result<EmitPlan, String> {
    let impls = crate::implementations_of(graph);
    let im = impls
        .iter()
        .find(|im| field(im, "id") == Some(id))
        .ok_or_else(|| format!("no implementation with id `{id}` — `bsc graph impl list` shows what exists"))?;
    Ok(plan_from(std::slice::from_ref(im), store_version(graph)))
}

/// Plan the emit for the whole library.
pub fn plan_all(graph: &Value) -> EmitPlan {
    plan_from(&crate::implementations_of(graph), store_version(graph))
}

/// The pure planner: records → files + reasoned skips. Testable without a store or a filesystem.
pub fn plan_from(impls: &[Value], version: u64) -> EmitPlan {
    let mut plan = EmitPlan::default();
    for im in impls {
        let id = field(im, "id").unwrap_or("<unnamed>").to_string();
        // A primitive DESCRIBES a built-in (`--ref`) and is never re-coded — emitting one would
        // fabricate source for something the language already provides.
        if field(im, "role") == Some("primitive") {
            plan.skipped.push(Skipped {
                id,
                reason: format!(
                    "a language primitive — DESCRIBED via `--ref {}`, never re-coded (#2972)",
                    field(im, "ref").unwrap_or("<std path>")
                ),
            });
            continue;
        }
        let Some(code) = field(im, "code") else {
            plan.skipped.push(Skipped { id, reason: "no stored `code` to emit".into() });
            continue;
        };
        let Some(path) = emit_path(im) else {
            plan.skipped.push(Skipped {
                id,
                reason: "no `src`/`folder` provenance, so there is no tree position to emit into — \
                         set one with `bsc graph impl set --src <path>`"
                    .into(),
            });
            continue;
        };
        plan.files.push(EmitFile { id, path, content: render(code, version) });
    }
    plan
}

/// Classify an on-disk emitted file against the CURRENT store — the pure core of `emit sync`.
///
/// `path` is the emit-dir-relative path; `content` is what is on disk. Shares
/// [`bsc_cli_util::vendored::classify`] with `bsc ui emit sync`, so both surfaces apply one precedence:
/// unstamped → left alone; hand-edited → skipped loudly; a path the store dropped → unknown.
pub fn classify_file(plan: &EmitPlan, path: &str, content: &str) -> SyncVerdict {
    let fresh = plan.files.iter().find(|f| f.path == path).map(|f| f.content.clone());
    classify(content, fresh)
}

/// The body a stamped file carries — re-exported so a caller can compare an emit against disk without
/// depending on the shared crate directly.
pub fn emitted_body(content: &str) -> &str {
    body_of(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn algo(id: &str, code: &str, folder: Option<&str>, src: Option<&str>) -> Value {
        let mut v = json!({ "id": id, "role": "algorithm", "tech": "typescript", "code": code });
        if let Some(f) = folder {
            v["folder"] = json!(f);
        }
        if let Some(s) = src {
            v["src"] = json!(s);
        }
        v
    }

    #[test]
    fn a_record_emits_one_stamped_file_under_its_folder() {
        let plan = plan_from(&[algo("merge-sort.ts", "export function mergeSort() {}", Some("features/algorithms"), None)], 2);
        assert!(plan.skipped.is_empty(), "{:?}", plan.skipped);
        let f = &plan.files[0];
        assert_eq!(f.path, "features/algorithms/merge-sort.ts");
        assert!(f.content.starts_with("// vendored from bsc/algorithms@2 (sha256:"), "{}", f.content);
        assert!(f.content.contains("`bsc graph emit sync` to update"), "names ITS OWN sync verb");
        assert_eq!(emitted_body(&f.content), "export function mergeSort() {}\n");
    }

    /// The load-bearing difference from `bsc ui emit`: an algorithm is a function LIFTED OUT of a file,
    /// and that file usually holds others. Emitting over `src` would delete them.
    #[test]
    fn records_sharing_one_src_emit_to_separate_files_never_over_the_shared_source() {
        let shared = "features/algorithms/viz/examples/sorts.ts";
        let plan = plan_from(
            &[
                algo("merge-sort.ts", "export function mergeSort() {}", Some("features/algorithms/viz/examples"), Some(shared)),
                algo("quick-sort.ts", "export function quickSort() {}", Some("features/algorithms/viz/examples"), Some(shared)),
            ],
            2,
        );
        let paths: Vec<&str> = plan.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            paths,
            vec![
                "features/algorithms/viz/examples/merge-sort.ts",
                "features/algorithms/viz/examples/quick-sort.ts"
            ],
        );
        // Neither one targets the file they were lifted from — that file backs four impls in reality.
        assert!(!paths.contains(&shared), "must never target the shared source: {paths:?}");
    }

    /// A record with no folder still emits when `src` implies one — provenance written before #4107
    /// derived the folder is not wasted.
    #[test]
    fn a_folderless_record_derives_its_directory_from_src() {
        let plan = plan_from(&[algo("merge.rs", "fn merge() {}", None, Some("crates/cve/src/install.rs"))], 2);
        assert_eq!(plan.files[0].path, "crates/cve/src/merge.rs");
    }

    #[test]
    fn the_three_unemittable_classes_are_reported_with_their_reason() {
        let primitive = json!({ "id": "rust.vec", "role": "primitive", "ref": "std::vec::Vec" });
        let no_code = json!({ "id": "empty.ts", "role": "algorithm", "folder": "x" });
        let no_provenance = json!({ "id": "canonical.rs", "role": "algorithm", "code": "fn f() {}" });
        let plan = plan_from(&[primitive, no_code, no_provenance], 2);

        assert!(plan.files.is_empty(), "none of the three is emittable");
        let reason = |id: &str| {
            plan.skipped.iter().find(|s| s.id == id).map(|s| s.reason.clone()).unwrap_or_default()
        };
        assert!(reason("rust.vec").contains("std::vec::Vec"), "names the std path: {}", reason("rust.vec"));
        assert!(reason("rust.vec").contains("never re-coded"));
        assert!(reason("empty.ts").contains("no stored `code`"));
        assert!(reason("canonical.rs").contains("--src"), "names the fix: {}", reason("canonical.rs"));
    }

    #[test]
    fn sync_rewrites_a_moved_record_and_never_clobbers_a_hand_edit() {
        let plan = plan_from(&[algo("merge-sort.ts", "export function mergeSort() {}", Some("f"), None)], 2);
        let path = "f/merge-sort.ts";
        let emitted = plan.files[0].content.clone();

        // Untouched since emit ⇒ nothing to do.
        assert_eq!(classify_file(&plan, path, &emitted), SyncVerdict::UpToDate);

        // The RECORD moved ⇒ the file follows (the atomic-upgrade half of the model).
        let moved = plan_from(&[algo("merge-sort.ts", "export function mergeSort(xs) { return xs; }", Some("f"), None)], 2);
        match classify_file(&moved, path, &emitted) {
            SyncVerdict::Rewrite(fresh) => assert!(fresh.contains("return xs")),
            other => panic!("expected a rewrite, got {other:?}"),
        }

        // Hand-edited ⇒ skipped, loudly. This is what stops a re-emit eating someone's work.
        let edited = emitted.replace("mergeSort() {}", "mergeSort() { /* mine */ }");
        assert_eq!(classify_file(&plan, path, &edited), SyncVerdict::Diverged);

        // A file the store no longer carries, and one that was never ours.
        assert_eq!(classify_file(&plan, "f/gone.ts", &emitted), SyncVerdict::Unknown);
        assert_eq!(classify_file(&plan, path, "just some source\n"), SyncVerdict::NotVendored);
    }

    #[test]
    fn plan_one_errors_on_an_unknown_id_rather_than_returning_an_empty_plan() {
        let graph = json!({ "version": 2, "implementations": [algo("a.ts", "x", Some("f"), None)] });
        assert_eq!(plan_one(&graph, "a.ts").unwrap().files.len(), 1);
        let err = plan_one(&graph, "nope.ts").unwrap_err();
        assert!(err.contains("nope.ts") && err.contains("impl list"), "{err}");
    }
}
