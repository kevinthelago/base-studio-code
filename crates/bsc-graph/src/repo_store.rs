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
    /// The runtime record is a SUBSET of the committed one: same code, but missing fields the committed
    /// copy carries. Promoting would DELETE those fields, so this is reported and never written.
    ///
    /// This is not hypothetical. On 2026-08-20 the running app rewrote the per-user runtime store from
    /// 969 implementations to 726, stripping `domain`, `folder`, `kind`, `vizCode`, `src` and `tests`
    /// from records the repo store had already captured. `--check` called that "the repo store is out of
    /// date — run promote", and following its own advice would have destroyed the richer committed copy.
    /// A check that cannot tell which side regressed must not assert a direction.
    RuntimeBehind,
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
    let Some(have) = by_id(repo) else { return Verdict::Differs };
    let (a, b) = (content_of(&have), content_of(&up));
    if a == b {
        return Verdict::UpToDate;
    }
    if loses_fields(&b, &a) {
        return Verdict::RuntimeBehind;
    }
    Verdict::Differs
}

/// Would writing `fresh` over `existing` DROP a field `existing` carries?
///
/// Key PRESENCE, not value equality, and that distinction was learned the hard way. The first version
/// asked "is fresh a subset of existing", which reclassified 6 of 9 regressed records correctly and left
/// 3 as drift — because the app's reset had also rewritten their `summary`, so they were not a clean
/// subset. But a record that both lost `vizCode` AND changed a summary is still a record that will lose
/// `vizCode` if promoted. The risk that matters here is LOSS, and it does not stop mattering because
/// something else moved too.
pub fn loses_fields(fresh: &Value, existing: &Value) -> bool {
    let (Some(fresh), Some(existing)) = (fresh.as_object(), existing.as_object()) else {
        return false;
    };
    existing
        .iter()
        // An empty value is nothing to lose.
        .filter(|(_, v)| !v.is_null() && v.as_str() != Some(""))
        .any(|(k, _)| !fresh.contains_key(k))
}

/// A record stripped of write bookkeeping, so a promote compares CONTENT and not revision noise.
///
/// `build` is stripped for a sharper reason than the rest. It is a DERIVED, MACHINE-SPECIFIC cache —
/// a verdict, a toolchain string, a timestamp and an artifact hash produced by whoever ran
/// `bsc graph build`. Promoting it would put one developer's build result into the committed source of
/// truth, and would churn the file on every machine that ever compiled a node. The gate caught this
/// immediately: stamping facets made all four tracked records read as drifted when nothing about their
/// SOURCE had changed. The facet belongs on the runtime node, where "does this compile here?" is a
/// meaningful question; the committed store carries what the compiler reads.
pub fn content_of(rec: &Value) -> Value {
    let mut c = rec.clone();
    if let Some(o) = c.as_object_mut() {
        for k in ["history", "rev", "updatedAt", "updatedBy", "build"] {
            o.remove(k);
        }
    }
    c
}


/// Where the PACKAGED seed lives — the other store-to-file direction.
///
/// Not the same target as [`path_under`], and the difference matters: `graph/algorithms.json` is what
/// the BUILD compiles, while this is what SHIPS and what a fresh install reconciles against. A record
/// can legitimately be in one and not the other.
pub fn seed_path_under(root: &Path) -> PathBuf {
    root.join("src-tauri").join("data").join("knowledge").join("algorithms.json")
}

/// Every field the packaged impl seed actually carries, in the order it reads best.
///
/// Derived from the 667 shipped records rather than hand-maintained — the list this replaces had
/// drifted to omit `kind`, `summary`, `tests` and `vizCode`, so promoting over an existing entry
/// silently dropped whichever of those it had.
pub const SEED_FIELDS: &[&str] = &[
    "id", "tech", "name", "role", "domain", "folder", "src", "provides", "composes", "kind",
    "summary", "ref", "tests", "code", "vizCode",
];

/// Project a runtime record down to what the SEED ships.
///
/// [`content_of`] drops the provenance; this additionally drops the store-side harvest metadata
/// (`moduleAttrs`, `moduleVis`) that none of the 667 packaged records carries and that nothing in the
/// tree reads by name. Keeping the projection to the seed's own observed shape is what makes a
/// promoted record byte-comparable with the ones already there.
pub fn seed_content_of(rec: &Value) -> Value {
    let full = content_of(rec);
    let mut out = serde_json::Map::new();
    for k in SEED_FIELDS {
        if let Some(v) = full.get(*k) {
            if !v.is_null() {
                out.insert((*k).to_string(), v.clone());
            }
        }
    }
    // `composes` is required by the seed's own integrity guard, and an absent one reads as a missing
    // field rather than "composes nothing".
    out.entry("composes".to_string()).or_insert_with(|| Value::Array(vec![]));
    // NORMALISE `tech`. A runtime record can carry the file EXTENSION where the tech belongs —
    // `extract.rs` maps the extension `ts` to the tech `typescript`, and the packaged seed is
    // uniformly `typescript` (640) and `rust` (26) with exactly one stray `ts`. Promoting that stray
    // verbatim drops the record out of its technology tab, which nothing surfaces as an error.
    if let Some(t) = out.get("tech").and_then(Value::as_str) {
        let canon = match t {
            "ts" | "tsx" => Some("typescript"),
            "rs" => Some("rust"),
            _ => None,
        };
        if let Some(c) = canon {
            out.insert("tech".into(), Value::String(c.to_string()));
        }
    }
    Value::Object(out)
}

/// Apply a promotion: return the repo store with each named id replaced by the runtime version.
///
/// Ids absent upstream are reported rather than dropped — silently removing a record because the
/// authoring machine happens not to have it is exactly the kind of quiet loss this store exists to
/// prevent.
pub fn promote_into(repo: &Value, runtime: &[Value], ids: &[String]) -> (Value, Vec<String>, Vec<String>) {
    let mut out = repo.clone();
    let mut missing = Vec::new();
    let mut refused = Vec::new();
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
            Some(at) => {
                // NEVER let a promote DELETE a field the committed copy carries. The same shape as
                // `promote-records --adopt-seed` refusing to drop an export the seed declares: a
                // regressed upstream must not be able to quietly strip the richer downstream copy.
                if loses_fields(&fresh, &content_of(&list[at])) {
                    refused.push(id.clone());
                    continue;
                }
                list[at] = fresh
            }
            None => list.push(fresh),
        }
    }
    if let Some(o) = out.as_object_mut() {
        o.insert("implementations".into(), Value::Array(list));
    }
    (out, missing, refused)
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

    /// A build facet is a DERIVED, machine-specific cache. Promoting it would commit one developer's
    /// verdict and churn the file on every machine that compiled a node — and it made all four tracked
    /// records read as drifted the moment `bsc graph build` stamped them.
    #[test]
    fn a_build_facet_is_never_content_and_is_never_promoted() {
        let bare = json!({ "id": "x.rs", "code": "fn x() {}" });
        let stamped = json!({
            "id": "x.rs", "code": "fn x() {}",
            "build": { "hash": "abc", "verdict": "pass", "toolchain": "rustc 1.95.0", "at": "now" }
        });
        assert_eq!(content_of(&bare), content_of(&stamped), "stamping a facet is not a source change");
        assert_eq!(verdict_for(std::slice::from_ref(&stamped), &[bare], "x.rs"), Verdict::UpToDate);

        let (out, _, _) = promote_into(&empty(), &[stamped], &["x.rs".to_string()]);
        assert!(impls_of(&out)[0].get("build").is_none(), "the facet must not reach the committed store");
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
        let (out, missing, _) =
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
        let (out, missing, _refused) = promote_into(&repo, &[], &["keep.rs".to_string()]);
        assert_eq!(missing, vec!["keep.rs".to_string()]);
        assert_eq!(impls_of(&out).len(), 1, "the record is still there");
    }

    #[test]
    fn promote_strips_bookkeeping_so_the_committed_file_does_not_churn_on_every_write() {
        let runtime = vec![json!({
            "id": "a.rs", "code": "fn a() {}", "rev": 7,
            "history": [{ "rev": 7 }], "updatedAt": "2026-08-19T00:00:00Z", "updatedBy": "claude"
        })];
        let (out, _, _) = promote_into(&empty(), &runtime, &["a.rs".to_string()]);
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

    /// THE REGRESSION THIS EXISTS FOR. On 2026-08-20 the running app rewrote the runtime store from 969
    /// implementations to 726, stripping `domain`/`folder`/`kind`/`vizCode`/`src`/`tests` while leaving
    /// `code` byte-identical. The check called it "the repo store is out of date — run promote", and
    /// obeying that would have deleted the richer committed copy.
    #[test]
    fn a_regressed_runtime_record_is_reported_behind_rather_than_drifted() {
        let rich = json!({ "id": "x.rs", "code": "fn x() {}", "vizCode": "({})", "domain": "sorting" });
        let thin = json!({ "id": "x.rs", "code": "fn x() {}" });
        assert_eq!(
            verdict_for(std::slice::from_ref(&thin), std::slice::from_ref(&rich), "x.rs"),
            Verdict::RuntimeBehind,
            "same code, fewer fields — the runtime regressed, the repo did not go stale"
        );
        // The other direction is still real drift: the runtime has something the repo lacks.
        assert_eq!(
            verdict_for(std::slice::from_ref(&rich), std::slice::from_ref(&thin), "x.rs"),
            Verdict::Differs
        );
    }

    #[test]
    fn promote_refuses_to_write_a_record_that_would_lose_fields() {
        let rich = json!({ "id": "x.rs", "code": "fn x() {}", "vizCode": "({})" });
        let thin = json!({ "id": "x.rs", "code": "fn x() {}" });
        let repo = json!({ "version": 1, "implementations": [rich] });
        let (out, missing, refused) = promote_into(&repo, std::slice::from_ref(&thin), &["x.rs".to_string()]);
        assert!(missing.is_empty());
        assert_eq!(refused, vec!["x.rs".to_string()], "refused rather than silently stripping");
        assert!(impls_of(&out)[0].get("vizCode").is_some(), "the field survived");
    }

    /// A genuine edit must still get through — the guard must not freeze the store.
    #[test]
    fn promote_still_writes_a_real_change() {
        let repo = json!({ "version": 1, "implementations": [json!({ "id": "x.rs", "code": "old" })] });
        let up = json!({ "id": "x.rs", "code": "new" });
        let (out, _, refused) = promote_into(&repo, std::slice::from_ref(&up), &["x.rs".to_string()]);
        assert!(refused.is_empty());
        assert_eq!(impls_of(&out)[0]["code"], json!("new"));
    }

    #[test]
    fn loss_is_about_key_presence_not_value_equality() {
        assert!(loses_fields(&json!({ "a": 1 }), &json!({ "a": 1, "b": 2 })), "b would be dropped");
        assert!(!loses_fields(&json!({ "a": 1, "b": 9 }), &json!({ "a": 1, "b": 2 })), "b changes, nothing lost");
        assert!(!loses_fields(&json!({ "a": 1 }), &json!({ "a": 1 })));
        // An empty value is nothing to lose.
        assert!(!loses_fields(&json!({ "a": 1 }), &json!({ "a": 1, "b": "" })));
    }

    /// The 3 records the first (subset-based) rule missed: they lost fields AND had a summary rewritten,
    /// so they were not a clean subset — but promoting them would still have deleted the lost fields.
    #[test]
    fn a_record_that_lost_fields_and_changed_one_is_still_behind() {
        let rich = json!({ "id": "x.rs", "code": "fn x() {}", "vizCode": "({})", "summary": "long form" });
        let thin = json!({ "id": "x.rs", "code": "fn x() {}", "summary": "short" });
        assert_eq!(
            verdict_for(std::slice::from_ref(&thin), std::slice::from_ref(&rich), "x.rs"),
            Verdict::RuntimeBehind,
        );
    }
}
