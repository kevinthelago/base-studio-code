//! The committed, in-repo graph store the BUILD reads — and the promote that feeds it.
//!
//! # Why a second store exists at all
//!
//! Under the files-to-zero decision (maintainer, 2026-08-19) a crate's source lives in the graph and is
//! materialized at build time. That makes the graph a BUILD INPUT, and a build input cannot live in
//! `~/.base-studio-code`: a fresh clone, a CI checkout and every nested zero-install worktree agent
//! would have nothing to compile. So the build reads a committed file in the repo.
//!
//! # Why it is NOT the packaged seed
//!
//! `src-tauri/data/knowledge/algorithms.json` is embedded into the binaries (`include_dir!`) and ships
//! to users. Putting every migrated crate's source there would ship the whole backend as a resource and
//! grow the bundle from ~2.7 MB toward ~9 MB. Weighed and rejected 2026-08-19.
//!
//! # Why it is read DIRECTLY, never through [`crate::load`]
//!
//! This is the load-bearing detail. [`crate::load`] runs [`crate::reconcile_seed`], which appends every
//! packaged-seed implementation the store lacks — 676 of them. Reading the repo store through `load`
//! would therefore fill the build's source of truth with the whole packaged algorithm library on the
//! first read. [`read_at`] parses the file and returns it, and that is all it does.
//!
//! # The two stores, and the seam between them
//!
//! ```text
//!   author:  bsc graph impl set   ->  ~/.base-studio-code/knowledge/algorithms.json   (runtime)
//!                                              |
//!                                     bsc graph promote                (explicit, gated)
//!                                              v
//!   build:   build.rs / cargo     ->  <repo>/graph/algorithms.json                    (committed)
//! ```
//!
//! Authoring stays in the runtime store, because that is what a live session and the app already read
//! and write. Promotion is EXPLICIT and never implicit: an automatic promote would mean any session's
//! edit silently changes what the workspace compiles.
//!
//! The cost of that seam is a drift surface — an author can edit and forget to promote — and it is the
//! same shape this repo has been bitten by from several directions already. So `promote --check` exists
//! for the gate, and reports the drift by id rather than healing it silently.

use serde_json::Value;
use std::path::{Path, PathBuf};

/// Repo-relative location of the build-readable store. Deliberately OUTSIDE `src-tauri/data`, which is
/// embedded into the binaries and shipped.
pub const REPO_STORE_REL: &str = "graph/algorithms.json";

/// The repo store's path under `root`.
pub fn path_under(root: &Path) -> PathBuf {
    root.join("graph").join("algorithms.json")
}

/// Read the repo store at `path` WITHOUT the seed reconcile.
///
/// Returns `Ok(None)` when the file is absent — a repo that has migrated nothing yet is not an error,
/// and a build script must be able to tell "nothing to materialize" from "the store is corrupt".
pub fn read_at(path: &Path) -> Result<Option<Value>, String> {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
        Ok(s) => serde_json::from_str::<Value>(&s)
            .map(Some)
            .map_err(|e| format!("{} is not valid JSON: {e}", path.display())),
    }
}

/// The implementations a repo store carries, in file order.
pub fn impls_of(store: &Value) -> Vec<Value> {
    store.get("implementations").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// The ids a repo store TRACKS — the set `promote` refreshes and `promote --check` compares.
pub fn tracked_ids(store: &Value) -> Vec<String> {
    impls_of(store)
        .iter()
        .filter_map(|i| i.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// An empty store document — what `promote` creates on first use.
pub fn empty() -> Value {
    serde_json::json!({
        "version": 1,
        "note": "The COMMITTED, build-readable graph store. Authoring happens in the runtime store \
                 (~/.base-studio-code/knowledge/algorithms.json); `bsc graph promote` moves records here, \
                 and `bsc graph promote --check` is the gate. Read directly, never through bsc_graph::load(), \
                 because load() reconciles the packaged seed and would append it wholesale.",
        "implementations": []
    })
}

/// One id's promotion verdict — what `promote` did, or what `--check` found.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// The repo store already matches the runtime store.
    UpToDate,
    /// The record differs (or is absent from the repo store) and would be written.
    Differs,
    /// The runtime store has no such id — nothing to promote from.
    MissingUpstream,
}

/// Compare one id between the runtime graph and the repo store.
///
/// The comparison is over the record's own JSON, minus the fields that are BOOKKEEPING rather than
/// content: `history`, `rev`, `updatedAt` and `updatedBy` move on every write and would make the check
/// report drift for a record whose code is identical.
pub fn verdict_for(runtime: &[Value], repo: &[Value], id: &str) -> Verdict {
    let by_id = |v: &[Value]| -> Option<Value> {
        v.iter().find(|i| i.get("id").and_then(Value::as_str) == Some(id)).cloned()
    };
    let Some(up) = by_id(runtime) else { return Verdict::MissingUpstream };
    match by_id(repo) {
        Some(have) if content_of(&have) == content_of(&up) => Verdict::UpToDate,
        _ => Verdict::Differs,
    }
}

/// A record stripped of write bookkeeping, so a promote compares CONTENT and not revision noise.
pub fn content_of(rec: &Value) -> Value {
    let mut c = rec.clone();
    if let Some(o) = c.as_object_mut() {
        for k in ["history", "rev", "updatedAt", "updatedBy"] {
            o.remove(k);
        }
    }
    c
}

/// Apply a promotion: return the repo store with each named id replaced by the runtime version.
///
/// Ids absent upstream are reported rather than dropped — silently removing a record because the
/// authoring machine happens not to have it is exactly the kind of quiet loss this store exists to
/// prevent.
pub fn promote_into(repo: &Value, runtime: &[Value], ids: &[String]) -> (Value, Vec<String>) {
    let mut out = repo.clone();
    let mut missing = Vec::new();
    let mut list = impls_of(repo);
    for id in ids {
        let Some(up) = runtime
            .iter()
            .find(|i| i.get("id").and_then(Value::as_str) == Some(id.as_str()))
        else {
            missing.push(id.clone());
            continue;
        };
        let fresh = content_of(up);
        match list.iter().position(|i| i.get("id").and_then(Value::as_str) == Some(id.as_str())) {
            Some(at) => list[at] = fresh,
            None => list.push(fresh),
        }
    }
    if let Some(o) = out.as_object_mut() {
        o.insert("implementations".into(), Value::Array(list));
    }
    (out, missing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(id: &str, code: &str) -> Value {
        json!({ "id": id, "role": "algorithm", "tech": "rust", "code": code })
    }

    #[test]
    fn an_absent_store_is_not_an_error_but_a_corrupt_one_is() {
        let dir = std::env::temp_dir().join(format!("bsc-repo-store-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let missing = dir.join("nope.json");
        assert_eq!(read_at(&missing).unwrap(), None, "absent = nothing migrated yet");

        let bad = dir.join("bad.json");
        std::fs::write(&bad, "{ not json").unwrap();
        assert!(read_at(&bad).unwrap_err().contains("not valid JSON"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn content_comparison_ignores_write_bookkeeping() {
        let a = json!({ "id": "x.rs", "code": "fn x() {}", "rev": 3, "updatedAt": "now", "history": [1] });
        let b = json!({ "id": "x.rs", "code": "fn x() {}", "rev": 9, "updatedBy": "someone" });
        assert_eq!(content_of(&a), content_of(&b), "a re-write must not read as drift");
    }

    #[test]
    fn verdict_reports_up_to_date_differs_and_missing_upstream() {
        let runtime = vec![rec("a.rs", "fn a() {}"), rec("b.rs", "fn b() {}")];
        let repo = vec![rec("a.rs", "fn a() {}"), rec("b.rs", "fn OLD() {}")];
        assert_eq!(verdict_for(&runtime, &repo, "a.rs"), Verdict::UpToDate);
        assert_eq!(verdict_for(&runtime, &repo, "b.rs"), Verdict::Differs);
        assert_eq!(verdict_for(&runtime, &repo, "gone.rs"), Verdict::MissingUpstream);
    }

    #[test]
    fn a_record_absent_from_the_repo_store_reads_as_differs_not_up_to_date() {
        let runtime = vec![rec("new.rs", "fn n() {}")];
        assert_eq!(verdict_for(&runtime, &[], "new.rs"), Verdict::Differs);
    }

    #[test]
    fn promote_adds_a_new_id_and_replaces_an_existing_one() {
        let repo = json!({ "version": 1, "implementations": [rec("a.rs", "fn OLD() {}")] });
        let runtime = vec![rec("a.rs", "fn a() {}"), rec("b.rs", "fn b() {}")];
        let (out, missing) =
            promote_into(&repo, &runtime, &["a.rs".to_string(), "b.rs".to_string()]);
        assert!(missing.is_empty());
        let got = impls_of(&out);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0]["code"], json!("fn a() {}"), "existing id replaced in place");
        assert_eq!(got[1]["id"], json!("b.rs"), "new id appended");
    }

    /// Quiet loss is the failure this store exists to prevent, so an id the authoring machine lacks is
    /// REPORTED rather than removed from the committed store.
    #[test]
    fn promote_reports_an_id_missing_upstream_instead_of_dropping_it() {
        let repo = json!({ "version": 1, "implementations": [rec("keep.rs", "fn k() {}")] });
        let (out, missing) = promote_into(&repo, &[], &["keep.rs".to_string()]);
        assert_eq!(missing, vec!["keep.rs".to_string()]);
        assert_eq!(impls_of(&out).len(), 1, "the record is still there");
    }

    #[test]
    fn promote_strips_bookkeeping_so_the_committed_file_does_not_churn_on_every_write() {
        let runtime = vec![json!({
            "id": "a.rs", "code": "fn a() {}", "rev": 7,
            "history": [{ "rev": 7 }], "updatedAt": "2026-08-19T00:00:00Z", "updatedBy": "claude"
        })];
        let (out, _) = promote_into(&empty(), &runtime, &["a.rs".to_string()]);
        let got = &impls_of(&out)[0];
        assert!(got.get("history").is_none(), "history must not be committed: {got}");
        assert!(got.get("rev").is_none());
        assert!(got.get("updatedAt").is_none());
        assert_eq!(got["code"], json!("fn a() {}"));
    }

    #[test]
    fn tracked_ids_is_what_a_bare_promote_refreshes() {
        let repo = json!({ "version": 1, "implementations": [rec("a.rs", ""), rec("b.rs", "")] });
        assert_eq!(tracked_ids(&repo), vec!["a.rs".to_string(), "b.rs".to_string()]);
        assert!(tracked_ids(&empty()).is_empty());
    }


    /// The committed store must parse and be readable WITHOUT a home dir, an env var, or the runtime
    /// store — that is the whole point of it existing. A fresh clone and a CI checkout have none of
    /// those, and if this guard ever fails the build's source of truth is unreadable there.
    #[test]
    fn the_committed_repo_store_parses_and_needs_nothing_but_the_repo() {
        // Walk up from this file to the repo root (crates/bsc-graph/src -> ../../..).
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .expect("crate is nested two levels under the repo root")
            .to_path_buf();
        let path = path_under(&root);
        let store = read_at(&path).expect("the committed store must parse");
        let Some(store) = store else {
            // Absent is legitimate before anything is migrated; nothing further to assert.
            return;
        };
        assert!(
            store.get("implementations").and_then(Value::as_array).is_some(),
            "the committed store carries an implementations array"
        );
        for rec in impls_of(&store) {
            assert!(rec.get("id").and_then(Value::as_str).is_some(), "every record has an id: {rec}");
            assert!(
                rec.get("history").is_none() && rec.get("rev").is_none(),
                "write bookkeeping must never be committed — it churns the file on every write: {rec}"
            );
        }
    }

    #[test]
    fn the_repo_store_path_is_outside_the_packaged_seed_that_ships() {
        let p = path_under(Path::new("/repo"));
        let s = p.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("graph/algorithms.json"), "{s}");
        assert!(!s.contains("src-tauri/data"), "must not live in the SHIPPED seed: {s}");
    }
}
