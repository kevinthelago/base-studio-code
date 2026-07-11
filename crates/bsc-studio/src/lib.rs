//! `bsc-studio` — the **Studio** store (#2890, slice 1 of the Studio epic #2889). A *Studio* is the
//! top-level shareable bundle: a self-contained snapshot of the app's current LIBRARY state, saved to
//! `~/.base-studio-code/studios/<id>.json` (an instance of #1325). This slice is the foundation —
//! SAVE the snapshot and read it back (`list`/`get`/`remove`); gist export + apply land in later slices.
//!
//! The snapshot is assembled by reading each sibling library collection DIRECTLY through the shared
//! verbatim-JSON-per-id store ([`bsc_json_store::Store`], #2158) — no per-sibling crate dependency —
//! keyed by system into an EXTENSIBLE map, so more systems can be added without a breaking change.
//!
//! **Golden rule:** snapshot the AUTHORITATIVE stores (the json-store files), never a cache, and never
//! live session state (tabs/panes/running sessions) — libraries only.
//!
//! The agent-facing CLI lives in [`cli`] (`bsc studio …`), dispatched by the unified `bsc` binary (#1877).

pub mod cli;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The library systems a snapshot captures, as `(system key, on-disk dir segment, record noun)`. Each
/// is a verbatim-JSON-per-id [`bsc_json_store`] collection under the base dir, read uniformly via
/// `.list()`. The system KEY is the snapshot map key (`teams`), which can differ from the on-disk
/// SEGMENT (`orgs`, kept unrenamed so existing saved data is never orphaned, #2700).
///
/// This is the GUARANTEED roster. The snapshot map is extensible, so a follow-up adds a system with a
/// single row here (plus, if it is not a json-store, a bespoke reader) — no wire break.
pub const SYSTEMS: &[(&str, &str, &str)] = &[
    ("teams", "orgs", "org"),
    ("personas", "personas", "persona"),
    ("components", "components", "component"),
    ("kits", "kits", "kit"),
    ("variants", "variants", "variant"),
    ("themes", "themes", "theme"),
    ("blueprints", "blueprints", "blueprint"),
];

// TODO(#2889): capture algorithms (bsc-graph) — the Algorithms knowledge graph is a curated
//   NODE+EDGE ontology, not a flat verbatim-per-id record store, so it does not fit the array-of-
//   records snapshot value; and its crate pulls in the heavy tree-sitter toolchain. A follow-up adds
//   it via the extensible map (as its own graph shape) without a breaking change.
// TODO(#2889): capture skills (skilldb, SQLite-backed) — needs a SQLite read that would bloat this
//   slice; a follow-up adds it through the extensible map.

/// The studios collection's directory segment under the base dir (`~/.base-studio-code/studios/`).
pub const STUDIOS_SEGMENT: &str = "studios";
/// The studio record noun (the id-validation error name + the store's noun).
pub const NOUN: &str = "studio";

/// The extensible snapshot: system key → that store's records (each a parsed JSON [`Value`]). A
/// `BTreeMap` so serialization is deterministic (stable output + byte-stable tests). Every rostered
/// system is always PRESENT (an absent store yields an empty array), so the snapshot self-describes
/// its full roster.
pub type Snapshot = BTreeMap<String, Vec<Value>>;

/// A **Studio** — a self-contained, shareable snapshot of the app's library state. The top-level
/// bundle: identity (`id` = a slug of `name`) + the extensible `snapshot` map.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Studio {
    /// The stable id (a slug of `name`); keys the on-disk `studios/<id>.json`.
    pub id: String,
    /// The human name given at save time.
    pub name: String,
    /// An optional one-line description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// An optional bundle version (reserved for later slices; unset by this slice's `save`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The captured library state, keyed by system name — extensible.
    pub snapshot: Snapshot,
}

/// Resolve the base `~/.base-studio-code` directory every store lives under. `flag` (the `--dir`
/// override, used by tests + power users) wins; else the shared home resolver. `Err` when no home dir
/// resolves (matching the `bsc-*` CLI convention). NOTE: for `bsc studio`, `--dir` is the BASE dir (the
/// snapshot reads its sibling collections under it), not a single collection dir.
pub fn resolve_base(flag: &Option<String>) -> Result<PathBuf, String> {
    match flag {
        Some(d) => Ok(PathBuf::from(d)),
        None => bsc_util::bsc_base_dir()
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string()),
    }
}

/// The studios store handle under `base` (`base/studios/`).
pub fn studios_store(base: &Path) -> bsc_json_store::Store {
    bsc_json_store::Store::new(base.join(STUDIOS_SEGMENT), NOUN)
}

/// Read one sibling json-store collection under `base` (`base/<segment>/*.json`) as parsed records.
/// Lenient (matching `Store::list`): an unparseable file is skipped, a missing dir ⇒ empty.
fn read_collection(base: &Path, segment: &str, noun: &'static str) -> Vec<Value> {
    let store = bsc_json_store::Store::new(base.join(segment), noun);
    store
        .list()
        .iter()
        .filter_map(|j| serde_json::from_str::<Value>(j).ok())
        .collect()
}

/// Assemble the [`Snapshot`] by reading every rostered sibling collection under `base`. Every system
/// key is present (empty array when its store is absent/empty), so an empty base still yields a valid,
/// self-describing snapshot.
pub fn build_snapshot(base: &Path) -> Snapshot {
    SYSTEMS
        .iter()
        .map(|(key, segment, noun)| ((*key).to_string(), read_collection(base, segment, noun)))
        .collect()
}

/// Slugify a studio `name` into its id: lowercase, every run of non-`[a-z0-9]` collapsed to a single
/// `-`, trimmed of leading/trailing `-`. `Err` when nothing alphanumeric survives (an id must key a
/// file). The result is already `safe_id`-safe, so the store writes it unchanged.
pub fn slug(name: &str) -> Result<String, String> {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash {
                out.push('-');
                pending_dash = false;
            }
            out.push(ch.to_ascii_lowercase());
        } else if !out.is_empty() {
            // Defer the separator so a trailing run never leaves a hanging '-'.
            pending_dash = true;
        }
    }
    if out.is_empty() {
        return Err(format!("studio name '{name}' has no slug-able characters"));
    }
    Ok(out)
}

/// Save a Studio for `name` (id = [`slug`]) capturing the current library state under `base`, persist
/// it to `base/studios/<id>.json`, and return the bundle. Upserts by id (a same-named re-save
/// overwrites). An empty `description` is dropped.
pub fn save(base: &Path, name: &str, description: Option<String>) -> Result<Studio, String> {
    let id = slug(name)?;
    let studio = Studio {
        id: id.clone(),
        name: name.to_string(),
        description: description.filter(|d| !d.trim().is_empty()),
        version: None,
        snapshot: build_snapshot(base),
    };
    let json = serde_json::to_string(&studio).map_err(|e| format!("save: {e}"))?;
    studios_store(base).set(&id, &json)?;
    Ok(studio)
}

/// Every saved Studio's lean `{id, name}` projection (the full bundle is one [`get`] away). Robust to
/// odd-shaped files (an unparseable blob yields empty strings, never a panic).
pub fn list_meta(base: &Path) -> Vec<Value> {
    studios_store(base)
        .list()
        .iter()
        .map(|j| bsc_json_store::cli::lean_meta(j, &["id", "name"]))
        .collect()
}

/// The full stored Studio bundle for `id` as a parsed [`Value`], or `None` when absent. `Err` only
/// when a present record is not valid JSON.
pub fn get(base: &Path, id: &str) -> Result<Option<Value>, String> {
    match studios_store(base).get(id)? {
        Some(j) => serde_json::from_str::<Value>(&j)
            .map(Some)
            .map_err(|e| format!("get: stored studio '{id}' is not valid JSON: {e}")),
        None => Ok(None),
    }
}

/// Remove a Studio by `id` (a no-op, not an error, when absent).
pub fn remove(base: &Path, id: &str) -> Result<(), String> {
    studios_store(base).remove(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A per-test unique base dir so parallel tests never share on-disk state.
    fn tmp_base(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "bsc-studio-test-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// Seed one record into a sibling collection under `base` via the same store the app writes.
    fn seed(base: &Path, segment: &str, noun: &'static str, id: &str, json: &str) {
        bsc_json_store::Store::new(base.join(segment), noun).set(id, json).unwrap();
    }

    #[test]
    fn slug_lowercases_collapses_and_trims() {
        assert_eq!(slug("My Studio").unwrap(), "my-studio");
        assert_eq!(slug("  Trim -- Me!! ").unwrap(), "trim-me");
        assert_eq!(slug("Already-slug").unwrap(), "already-slug");
        assert_eq!(slug("a__b  c").unwrap(), "a-b-c");
        assert!(slug("   ").is_err(), "no alphanumerics ⇒ error");
        assert!(slug("!!!").is_err());
    }

    #[test]
    fn build_snapshot_always_has_every_system_key_even_when_empty() {
        let base = tmp_base("empty");
        let snap = build_snapshot(&base);
        // Empty-but-valid: every rostered system present, each an empty array.
        assert_eq!(snap.len(), SYSTEMS.len());
        for (key, _, _) in SYSTEMS {
            assert!(snap.contains_key(*key), "system '{key}' is present");
            assert!(snap[*key].is_empty(), "system '{key}' is empty for an empty base");
        }
    }

    #[test]
    fn save_assembles_a_snapshot_from_seeded_sibling_stores() {
        let base = tmp_base("save");
        // Seed two DIFFERENT sibling collections (note: teams lives on-disk under `orgs`).
        seed(&base, "blueprints", "blueprint", "bp1", r#"{"id":"bp1","name":"Full-stack"}"#);
        seed(&base, "blueprints", "blueprint", "bp2", r#"{"id":"bp2","name":"Mobile"}"#);
        seed(&base, "orgs", "org", "team1", r#"{"id":"team1","name":"Core"}"#);

        let studio = save(&base, "My Studio", Some("a snapshot".into())).unwrap();

        // Identity + description.
        assert_eq!(studio.id, "my-studio");
        assert_eq!(studio.name, "My Studio");
        assert_eq!(studio.description.as_deref(), Some("a snapshot"));
        assert_eq!(studio.version, None);

        // The snapshot captured the seeded records, keyed by SYSTEM name (teams, not orgs).
        let bps = &studio.snapshot["blueprints"];
        assert_eq!(bps.len(), 2);
        let bp_ids: Vec<&str> = bps.iter().filter_map(|v| v["id"].as_str()).collect();
        assert!(bp_ids.contains(&"bp1") && bp_ids.contains(&"bp2"));
        assert_eq!(studio.snapshot["teams"].len(), 1);
        assert_eq!(studio.snapshot["teams"][0]["name"], "Core");
        // A rostered-but-unseeded system is present and empty.
        assert!(studio.snapshot["personas"].is_empty());

        // It persisted verbatim: a `get` reads the same bundle back.
        let got = get(&base, "my-studio").unwrap().expect("saved studio is readable");
        assert_eq!(got["id"], "my-studio");
        assert_eq!(got["snapshot"]["blueprints"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn save_with_an_empty_store_yields_an_empty_but_valid_snapshot() {
        let base = tmp_base("save-empty");
        let studio = save(&base, "Blank", None).unwrap();
        assert_eq!(studio.id, "blank");
        assert_eq!(studio.description, None);
        assert_eq!(studio.snapshot.len(), SYSTEMS.len());
        assert!(studio.snapshot.values().all(|recs| recs.is_empty()));
        // Round-trips through the store unchanged.
        assert!(get(&base, "blank").unwrap().is_some());
    }

    #[test]
    fn list_get_remove_round_trip() {
        let base = tmp_base("crud");
        assert!(list_meta(&base).is_empty(), "a fresh base has no studios");
        assert_eq!(get(&base, "one").unwrap(), None, "absent ⇒ None");

        save(&base, "One", None).unwrap();
        save(&base, "Two", None).unwrap();

        // list projects the lean {id, name} of each.
        let mut metas = list_meta(&base);
        metas.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0], serde_json::json!({"id": "one", "name": "One"}));
        assert_eq!(metas[1], serde_json::json!({"id": "two", "name": "Two"}));

        // get returns the full bundle.
        assert!(get(&base, "one").unwrap().is_some());

        // remove drops one; the other survives; remove-absent is a no-op.
        remove(&base, "one").unwrap();
        assert_eq!(get(&base, "one").unwrap(), None);
        assert_eq!(list_meta(&base).len(), 1);
        remove(&base, "one").unwrap(); // no-op, not an error
    }
}
