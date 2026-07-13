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

use include_dir::{include_dir, Dir};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The packaged built-in studios, embedded from `src-tauri/data/studios/*.json` (#2894) — the same
/// `include_dir!` pattern skilldb uses for its packaged skills. Built-ins are the shipped PRESETS
/// (e.g. `web-app-dev`, the zero-change baseline). They're merged UNDER the user store — a same-id user
/// studio overrides one — and are READ-ONLY (`remove` leaves them; the on-disk store holds only user
/// studios).
static PACKAGED_STUDIOS_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/../../src-tauri/data/studios");

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

/// Upsert a full Studio bundle (parsed from `json`) into the studios store, keyed by its `id`.
/// Validation is MINIMAL by design (#2891): the bundle must be a JSON object carrying a non-empty `id`
/// AND `name` — the identity every studio needs to key its `studios/<id>.json` file and render in the
/// library; the `snapshot` (and any other fields) ride through unexamined. The parsed value is stored
/// (normalized to compact JSON, matching [`save`]), so a same-id bundle overwrites (upsert). Returns
/// the id written.
///
/// This is the write half of the gist IMPORT path: the frontend fetches + validates the shared
/// extension manifest and coerces the studio payload, then hands the reconstructed bundle here (via the
/// `bsc` bridge) to land it in the store — the mirror of `bsc blueprint set`.
pub fn set(base: &Path, json: &str) -> Result<String, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("set: studio is not valid JSON: {e}"))?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "set: studio JSON needs a non-empty \"id\"".to_string())?
        .to_string();
    let has_name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .is_some_and(|s| !s.is_empty());
    if !has_name {
        return Err("set: studio JSON needs a non-empty \"name\"".to_string());
    }
    let normalized = serde_json::to_string(&value).map_err(|e| format!("set: {e}"))?;
    studios_store(base).set(&id, &normalized)?;
    Ok(id)
}

/// The packaged built-in studios, parsed from the embedded `src-tauri/data/studios/*.json` (#2894), in
/// a stable order (by filename). A malformed file is skipped (never poisons the set). Each carries
/// `"builtin": true` in its JSON so the library can tag + protect it.
pub fn builtin_studios() -> Vec<Value> {
    let mut files: Vec<_> = PACKAGED_STUDIOS_DIR
        .files()
        .filter(|f| f.path().extension().is_some_and(|e| e == "json"))
        .collect();
    files.sort_by_key(|f| f.path().to_path_buf());
    files
        .iter()
        .filter_map(|f| f.contents_utf8().and_then(|s| serde_json::from_str::<Value>(s).ok()))
        .collect()
}

/// A studio Value's non-empty string `id`, else `None`.
fn studio_id(v: &Value) -> Option<&str> {
    v.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

/// Every Studio's lean `{id, name}` projection — the USER-saved ones plus every packaged built-in a user
/// studio doesn't override (#2894), with `builtin: true` on the built-in entries. Built-ins come first
/// (they're the shipped presets). Robust to odd-shaped files (an unparseable blob yields empty strings,
/// never a panic).
pub fn list_meta(base: &Path) -> Vec<Value> {
    let user: Vec<Value> = studios_store(base)
        .list()
        .iter()
        .map(|j| bsc_json_store::cli::lean_meta(j, &["id", "name"]))
        .collect();
    let user_ids: std::collections::BTreeSet<String> =
        user.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).map(str::to_string).collect();
    // Built-ins a user studio doesn't shadow by id, tagged so the library shows + protects them.
    let mut out: Vec<Value> = builtin_studios()
        .iter()
        .filter_map(|v| {
            let id = studio_id(v)?;
            if user_ids.contains(id) {
                return None;
            }
            let name = v.get("name").and_then(Value::as_str).unwrap_or(id);
            Some(serde_json::json!({ "id": id, "name": name, "builtin": true }))
        })
        .collect();
    out.extend(user);
    out
}

/// The full Studio bundle for `id` as a parsed [`Value`], or `None` when absent. A user-saved studio wins;
/// else it falls back to a packaged built-in (#2894), so `get`/`apply` work on a built-in even with no
/// user copy. `Err` only when a present user record is not valid JSON.
pub fn get(base: &Path, id: &str) -> Result<Option<Value>, String> {
    if let Some(j) = studios_store(base).get(id)? {
        return serde_json::from_str::<Value>(&j)
            .map(Some)
            .map_err(|e| format!("get: stored studio '{id}' is not valid JSON: {e}"));
    }
    Ok(builtin_studios().into_iter().find(|v| studio_id(v) == Some(id)))
}

/// Remove a Studio by `id` (a no-op, not an error, when absent).
pub fn remove(base: &Path, id: &str) -> Result<(), String> {
    studios_store(base).remove(id)
}

/// Apply a saved Studio by `id` — RE-SEED the app's libraries from its captured snapshot. The inverse
/// of [`save`]/[`build_snapshot`]: it writes back through the SAME `(system key → on-disk segment)`
/// [`bsc_json_store::Store`] mapping the snapshot was read through, so the `teams` system re-seeds the
/// on-disk `orgs/` store, etc.
///
/// For EACH system PRESENT in the studio's `snapshot`, it REPLACES that system's store: every existing
/// record is removed ([`bsc_json_store::Store`] has no `clear`, so we `list()` the current records,
/// read each one's `id`, and `remove` it), then every record in the snapshot array is written
/// (`set(record.id, record)`). A snapshot record with no string `id` is SKIPPED (it cannot key a file)
/// rather than aborting the whole apply, and a listed live record with no readable `id` is left in
/// place (it cannot be addressed for removal). Only systems the snapshot actually contains are touched
/// — a PARTIAL studio (a snapshot missing a system, or carrying a subset) leaves every unlisted system
/// untouched. A snapshot key outside the [`SYSTEMS`] roster is ignored.
///
/// Returns a summary `{ "applied": { "<system>": <count> }, "id": "<id>", "name": "<name>" }` where
/// each count is how many records were written for that system. `Err` when no studio is stored for
/// `id` (or a stored record is unreadable, via [`get`]).
pub fn apply(base: &Path, id: &str) -> Result<Value, String> {
    let studio = get(base, id)?.ok_or_else(|| format!("apply: studio '{id}' not found"))?;
    let name = studio.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
    let mut applied = serde_json::Map::new();

    if let Some(snapshot) = studio.get("snapshot").and_then(Value::as_object) {
        for &(key, segment, noun) in SYSTEMS {
            // Only touch a system the snapshot actually carries (partial studios are safe).
            let Some(records) = snapshot.get(key).and_then(Value::as_array) else { continue };
            let store = bsc_json_store::Store::new(base.join(segment), noun);

            // REPLACE step 1 — drop every existing record (addressed by its own `id`).
            for existing in store.list() {
                if let Some(eid) = serde_json::from_str::<Value>(&existing)
                    .ok()
                    .as_ref()
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_str)
                {
                    store.remove(eid)?;
                }
            }

            // REPLACE step 2 — write the snapshot's records (skip any with no string `id`).
            let mut count: u64 = 0;
            for rec in records {
                let Some(rid) = rec.get("id").and_then(Value::as_str) else { continue };
                let json = serde_json::to_string(rec).map_err(|e| format!("apply: {e}"))?;
                store.set(rid, &json)?;
                count += 1;
            }
            applied.insert(key.to_string(), Value::from(count));
        }
    }

    Ok(serde_json::json!({ "applied": applied, "id": id, "name": name }))
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

    /// The lean listing WITHOUT the packaged built-ins (#2894 ships `web-app-dev`) — the user-authored
    /// studios these CRUD tests assert over. (The built-in merge itself is covered by its own tests.)
    fn user_meta(base: &Path) -> Vec<Value> {
        list_meta(base)
            .into_iter()
            .filter(|v| v.get("builtin").and_then(Value::as_bool) != Some(true))
            .collect()
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
    fn user_studios_persist_to_sqlite_not_json_files() {
        // #2988 (epic #2982): the shared `bsc-json-store` backend was migrated JSON-files → SQLite
        // (#2983) transparently, so the studios store now persists to a `.db`. This is the EXPLICIT
        // regression guard for that property on the USER studio store.
        let base = tmp_base("sqlite");

        // A user studio round-trips through the store: save it, then read it back both ways.
        save(&base, "My Studio", Some("a snapshot".into())).unwrap();
        let got = get(&base, "my-studio").unwrap().expect("saved studio is readable");
        assert_eq!(got["id"], "my-studio");
        assert_eq!(user_meta(&base), vec![serde_json::json!({"id": "my-studio", "name": "My Studio"})]);

        // The backing is SQLite: the sibling `<base>/studios.db` exists after the write...
        assert!(base.join("studios.db").is_file(), "user studios persist to the SQLite `studios.db`");
        // ...and NO legacy per-id `<base>/studios/<id>.json` file was written (that path is now only
        // the one-time legacy-import source, never a live write target).
        assert!(
            !base.join(STUDIOS_SEGMENT).join("my-studio.json").exists(),
            "no per-id JSON file — user studios live in SQLite, not `studios/<id>.json`",
        );
    }

    #[test]
    fn set_upserts_a_bundle_and_get_reads_it_back() {
        let base = tmp_base("set");
        // A full imported bundle (the shape the gist-import path hands back) lands by id + reads back.
        let bundle = r#"{"id":"imported","name":"Imported Studio","description":"from a gist","version":"2.0.0","snapshot":{"blueprints":[{"id":"bp1","name":"Full-stack"}],"teams":[]}}"#;
        let id = set(&base, bundle).unwrap();
        assert_eq!(id, "imported");

        let got = get(&base, "imported").unwrap().expect("set studio is readable");
        assert_eq!(got["id"], "imported");
        assert_eq!(got["name"], "Imported Studio");
        assert_eq!(got["description"], "from a gist");
        assert_eq!(got["version"], "2.0.0");
        assert_eq!(got["snapshot"]["blueprints"].as_array().unwrap().len(), 1);
        assert_eq!(got["snapshot"]["blueprints"][0]["name"], "Full-stack");
        // It shows up in the lean listing too.
        assert_eq!(user_meta(&base), vec![serde_json::json!({"id": "imported", "name": "Imported Studio"})]);

        // Upsert: a same-id re-set overwrites in place (no duplicate).
        set(&base, r#"{"id":"imported","name":"Renamed","snapshot":{}}"#).unwrap();
        let got2 = get(&base, "imported").unwrap().unwrap();
        assert_eq!(got2["name"], "Renamed");
        assert_eq!(user_meta(&base).len(), 1);
    }

    #[test]
    fn set_rejects_malformed_bundles() {
        let base = tmp_base("set-bad");
        assert!(set(&base, "not json").is_err(), "invalid JSON is rejected");
        assert!(set(&base, r#"{"name":"No Id","snapshot":{}}"#).is_err(), "missing id is rejected");
        assert!(set(&base, r#"{"id":"","name":"Blank Id"}"#).is_err(), "empty id is rejected");
        assert!(set(&base, r#"{"id":"x","snapshot":{}}"#).is_err(), "missing name is rejected");
        assert!(set(&base, r#"{"id":"x","name":"  "}"#).is_err(), "blank name is rejected");
        // Nothing landed on any rejection.
        assert!(user_meta(&base).is_empty());
    }

    #[test]
    fn list_get_remove_round_trip() {
        let base = tmp_base("crud");
        assert!(user_meta(&base).is_empty(), "a fresh base has no studios");
        assert_eq!(get(&base, "one").unwrap(), None, "absent ⇒ None");

        save(&base, "One", None).unwrap();
        save(&base, "Two", None).unwrap();

        // list projects the lean {id, name} of each.
        let mut metas = user_meta(&base);
        metas.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        assert_eq!(metas.len(), 2);
        assert_eq!(metas[0], serde_json::json!({"id": "one", "name": "One"}));
        assert_eq!(metas[1], serde_json::json!({"id": "two", "name": "Two"}));

        // get returns the full bundle.
        assert!(get(&base, "one").unwrap().is_some());

        // remove drops one; the other survives; remove-absent is a no-op.
        remove(&base, "one").unwrap();
        assert_eq!(get(&base, "one").unwrap(), None);
        assert_eq!(user_meta(&base).len(), 1);
        remove(&base, "one").unwrap(); // no-op, not an error
    }

    // The set of record ids currently on disk for one sibling system store under `base`.
    fn store_ids(base: &Path, segment: &str, noun: &'static str) -> std::collections::BTreeSet<String> {
        bsc_json_store::Store::new(base.join(segment), noun)
            .list()
            .iter()
            .filter_map(|j| serde_json::from_str::<Value>(j).ok())
            .filter_map(|v| v["id"].as_str().map(str::to_string))
            .collect()
    }

    #[test]
    fn ships_the_web_app_dev_builtin_a_reset_to_defaults_baseline() {
        let builtins = builtin_studios();
        let web = builtins.iter().find(|v| v["id"] == "web-app-dev").expect("web-app-dev built-in ships");
        assert_eq!(web["builtin"], true);
        assert_eq!(web["name"], "Web App Dev");
        // Its snapshot is empty-per-system — applying it CLEARS the user library so the packaged
        // defaults re-hydrate (the zero-change baseline), rather than duplicating every seed record.
        let snap = web["snapshot"].as_object().expect("snapshot is an object");
        for (key, _, _) in SYSTEMS {
            assert!(snap.get(*key).and_then(Value::as_array).is_some_and(|a| a.is_empty()), "system '{key}' present + empty");
        }
    }

    #[test]
    fn builtins_merge_into_list_and_get_and_a_user_studio_overrides_by_id() {
        let base = tmp_base("builtins");
        // A fresh base (no user studios) still lists the built-in, tagged, and `get` resolves it.
        let metas = list_meta(&base);
        let web_meta = metas.iter().find(|m| m["id"] == "web-app-dev").expect("built-in listed on an empty base");
        assert_eq!(web_meta["builtin"], true);
        assert!(get(&base, "web-app-dev").unwrap().is_some(), "get falls back to the built-in");

        // A user studio with the SAME id (slug of "Web App Dev") overrides the built-in: no duplicate,
        // and the entry is no longer tagged builtin (the user copy wins).
        save(&base, "Web App Dev", Some("my override".into())).unwrap();
        let metas = list_meta(&base);
        let web = metas.iter().filter(|m| m["id"] == "web-app-dev").collect::<Vec<_>>();
        assert_eq!(web.len(), 1, "no duplicate when a user studio shadows the built-in");
        assert!(web[0].get("builtin").is_none(), "the user copy wins, not tagged built-in");
        assert_eq!(get(&base, "web-app-dev").unwrap().unwrap()["description"], "my override");
    }

    #[test]
    fn apply_works_on_a_builtin_clearing_the_user_library() {
        let base = tmp_base("apply-builtin");
        // Seed user records across two systems; applying web-app-dev (empty snapshot) clears them.
        seed(&base, "blueprints", "blueprint", "mine", r#"{"id":"mine","name":"My BP"}"#);
        seed(&base, "components", "component", "mycomp", r#"{"id":"mycomp","name":"MyComp"}"#);
        let summary = apply(&base, "web-app-dev").unwrap();
        assert_eq!(summary["id"], "web-app-dev");
        assert_eq!(summary["applied"]["blueprints"], 0); // replaced with the empty snapshot ⇒ cleared
        assert!(store_ids(&base, "blueprints", "blueprint").is_empty());
        assert!(store_ids(&base, "components", "component").is_empty());
    }

    #[test]
    fn apply_replaces_captured_systems_and_leaves_others_untouched() {
        let base = tmp_base("apply");
        // The LIVE stores: two blueprints to be replaced, and a persona the studio never mentions.
        seed(&base, "blueprints", "blueprint", "old1", r#"{"id":"old1","name":"Old One"}"#);
        seed(&base, "blueprints", "blueprint", "old2", r#"{"id":"old2","name":"Old Two"}"#);
        seed(&base, "personas", "persona", "keep", r#"{"id":"keep","name":"Keep Me"}"#);

        // A DIFFERENT studio: three blueprints (and NO personas key) — imported via `set`.
        let bundle = r#"{"id":"other","name":"Other Studio","snapshot":{"blueprints":[
            {"id":"new1","name":"New One"},{"id":"new2","name":"New Two"},{"id":"new3","name":"New Three"}]}}"#;
        set(&base, bundle).unwrap();

        let summary = apply(&base, "other").unwrap();
        assert_eq!(summary["id"], "other");
        assert_eq!(summary["name"], "Other Studio");
        assert_eq!(summary["applied"]["blueprints"], 3);
        // personas was NOT in the snapshot → not touched, not reported.
        assert!(summary["applied"].get("personas").is_none(), "unlisted system not reported");

        // The blueprints store now holds EXACTLY the studio's records — old ids gone, new present.
        assert_eq!(
            store_ids(&base, "blueprints", "blueprint"),
            ["new1", "new2", "new3"].iter().map(|s| s.to_string()).collect()
        );
        // The unlisted personas store is untouched.
        assert_eq!(store_ids(&base, "personas", "persona"), ["keep".to_string()].into_iter().collect());
    }

    #[test]
    fn apply_skips_idless_records_and_errors_on_an_absent_studio() {
        let base = tmp_base("apply-edge");
        assert!(apply(&base, "nope").is_err(), "an absent studio ⇒ error");

        // One good record + one id-less record in the same array.
        let bundle = r#"{"id":"s","name":"S","snapshot":{"blueprints":[{"id":"good","name":"Good"},{"name":"No Id"}]}}"#;
        set(&base, bundle).unwrap();
        let summary = apply(&base, "s").unwrap();
        // Only the record carrying a string id was written; the id-less one was skipped (not fatal).
        assert_eq!(summary["applied"]["blueprints"], 1);
        assert_eq!(store_ids(&base, "blueprints", "blueprint"), ["good".to_string()].into_iter().collect());
    }
}
