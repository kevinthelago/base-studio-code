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


use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

// The packaged built-in studios are read at RUNTIME from `data/studios/*.json` (#2894), by
// `builtin_studios` below. They moved off `include_dir!` in
// `the-directory-seeds-load-at-runtime-and-a-studio-can-be-written-anywhere`, because embedding the
// directory was one of the compile-time dependencies that made `src-tauri/data` undeletable.
//
// Built-ins are the shipped PRESETS (e.g. `web-app-dev`, the zero-change baseline). They are merged
// UNDER the user store — a same-id user studio overrides one — and are READ-ONLY (`remove` leaves
// them; the on-disk store holds only user studios).
//
// A `//` comment, not `///`: it documents the SEED rather than any one item, and a doc comment with
// no item under it is a hard clippy error.

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
    // Added by `the-snapshot-covers-every-authoritative-store`. Both are ordinary
    // `bsc_json_store` collections, so each costs exactly the row the doc above promised.
    ("sounds", "sounds", "sound"),
    ("networks", "networks", "network"),
];

/// Stores that are AUTHORITATIVE but deliberately NOT captured, and why.
///
/// A roster of exclusions rather than silence: the failure this whole surface guards against is a
/// backup that appears to succeed and quietly omits something. An omission that is DELIBERATE should
/// be as visible as one that is covered, and [`tests::every_known_store_is_captured_or_excluded`]
/// fails when a store appears on disk that is on neither list.
///
/// `secrets` is the one that must never move. A Studio is a SHAREABLE bundle by construction — the
/// module header says so and `apply` re-seeds another machine from it — so capturing the credential
/// store would put pairing metadata into a file whose whole purpose is being handed to someone else.
/// The values live in the OS keychain and no verb reads them back, but WHICH services a user is
/// paired with is itself disclosure, and a backup is not a reason to publish it.
pub const EXCLUDED: &[(&str, &str)] = &[
    ("secrets", "disclosure that cannot be walked back; needs its own backup decision (deferred)"),
    ("plans", "per-project plan.db is a bespoke schema, not a json-store — needs its own reader"),
    ("knowledge", "the algorithms graph is a NODE+EDGE ontology, not records (#2889)"),
    ("skills", "SQLite-backed with its own schema (#2889)"),
    ("runtime", "a cache — re-derived, never authored"),
    ("perf", "telemetry — measured, never authored"),
    ("studios", "the snapshot store itself; capturing it would nest snapshots"),
    // Found by `every_known_store_is_captured_or_excluded` on its first run — I had not accounted
    // for any of these four, which is precisely what the guard exists to stop. None is a flat
    // `bsc_json_store` collection, so none can be added by a row; each needs its own reader, and
    // whether it BELONGS in a shareable bundle is a separate judgement per store. Both questions are
    // deferred deliberately rather than answered here on a guess:
    // `the-snapshot-needs-a-reader-for-the-stores-that-are-not-json-collections`.
    ("atlas", "a relational feature-inventory corpus, not a json-store collection — it joins, so it needs its own reader"),
    ("projects", "project-hub list — not a json-store collection; needs its own reader"),
    ("requests", "improvement-request store with its own schema; needs its own reader"),
    ("loops", "conversation-loop store — not a json-store collection; needs its own reader"),
    ("entities", "the canonical data model has its own schema; needs its own reader"),
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

/// The snapshot restricted to `keys`, for a partial save.
///
/// An unknown key is REFUSED rather than quietly matching nothing — a typo'd `--persona` that
/// silently produced an empty bundle would be the same silent-empty failure this surface exists to
/// prevent, one level up.
pub fn build_snapshot_for(base: &Path, keys: &[String]) -> Result<Snapshot, String> {
    if let Some(bad) = keys.iter().find(|k| !SYSTEMS.iter().any(|(key, _, _)| *key == k.as_str())) {
        let known: Vec<&str> = SYSTEMS.iter().map(|(k, _, _)| *k).collect();
        return Err(format!("unknown system '{bad}' (known: {})", known.join(", ")));
    }
    Ok(SYSTEMS
        .iter()
        .filter(|(key, _, _)| keys.iter().any(|k| k == key))
        .map(|(key, segment, noun)| ((*key).to_string(), read_collection(base, segment, noun)))
        .collect())
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
    bsc_util::packaged::read_dir_json("studios")
        .into_iter()
        .filter_map(|(_name, body)| serde_json::from_str::<Value>(&body).ok())
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-studio--<module>.rs
//     bsc graph impl set --id bsc-studio--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-studio--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-studio--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
#[cfg(test)]
mod coverage_tests {
    use super::{EXCLUDED, SYSTEMS};

    /// EVERY authoritative store is either captured or explicitly excluded — never merely absent.
    ///
    /// This is the guard the coverage gap needed. A snapshot of this machine captured 489 records and
    /// silently omitted `sounds`, `networks`, `plans` and more; nothing failed, because nothing was
    /// asserting the roster was complete. Adding a store to the app must now force a decision here,
    /// and "I forgot" stops being expressible.
    ///
    /// It reads the DEFAULT base rather than a fixture on purpose: the thing being guarded is drift
    /// between what the app writes and what the snapshot knows about, and only the real directory can
    /// show that. A machine with no base dir yet has nothing to drift, so it skips.
    #[test]
    fn every_known_store_is_captured_or_excluded() {
        let Some(base) = bsc_util::bsc_base_dir() else { return };
        let Ok(entries) = std::fs::read_dir(&base) else { return };

        let captured: Vec<&str> = SYSTEMS.iter().map(|(_, seg, _)| *seg).collect();
        let excluded: Vec<&str> = EXCLUDED.iter().map(|(seg, _)| *seg).collect();

        let mut unaccounted: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                // A store is `<segment>.db` beside the base dir.
                let seg = name.strip_suffix(".db")?.to_string();
                (!captured.contains(&seg.as_str()) && !excluded.contains(&seg.as_str())).then_some(seg)
            })
            .collect();
        unaccounted.sort();
        unaccounted.dedup();

        // Scratch databases a session left behind are not app stores. Named rather than pattern-matched,
        // so a REAL store can never hide behind a loose filter.
        let scratch = ["clamp-live", "clamp-live2", "clamp-live3", "e2e-floor"];
        unaccounted.retain(|s| !scratch.contains(&s.as_str()));

        assert!(
            unaccounted.is_empty(),
            "these stores are neither captured by SYSTEMS nor listed in EXCLUDED, so a backup would \
             silently omit them: {unaccounted:?}. Add a SYSTEMS row if they belong in a snapshot, or \
             an EXCLUDED entry saying why they do not."
        );
    }

    /// A store is never on both lists — that would read as covered while being skipped.
    #[test]
    fn no_store_is_both_captured_and_excluded() {
        for (_, seg, _) in SYSTEMS {
            assert!(
                !EXCLUDED.iter().any(|(e, _)| e == seg),
                "{seg} is in SYSTEMS and EXCLUDED — one of them is a lie"
            );
        }
    }

    /// Every exclusion carries a REASON. An unexplained one is how a real omission gets parked.
    #[test]
    fn every_exclusion_states_why() {
        for (seg, why) in EXCLUDED {
            assert!(why.len() > 20, "{seg} is excluded without a real reason: {why:?}");
        }
    }
}

// ── FULL-SCOPE BACKUP (`the-save-verb-takes-a-scope-and-backs-up-everything`) ─────────────────────

/// What a save captures. The DEFAULT is [`Scope::Library`], and that is the safety property: the
/// artifact you get without thinking is the one that is safe to hand to someone.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Scope {
    /// The shareable library bundle — presets and design state. What `save` has always produced.
    Library,
    /// EVERYTHING, including private project state. NOT shareable: plan stores hold discovery,
    /// lessons and change history (1,027 changes in one store on the machine this was written on),
    /// and `projects` holds local filesystem paths.
    Full,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Library => "library",
            Scope::Full => "full",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "library" => Ok(Scope::Library),
            "full" => Ok(Scope::Full),
            other => Err(format!("unknown --scope '{other}' (expected library|full)")),
        }
    }
}

/// Stores a FULL backup must NEVER copy, and why.
///
/// A DENY-LIST, and the direction is the whole point. The full-backup set used to be an ALLOW-list, and
/// that is the wrong default for a backup: a crate adds a store, nobody remembers to add a row, and
/// the backup silently omits it. That is not hypothetical — `atlas.db` shipped and was omitted, and
/// the roster guard only caught it because this developer's machine happened to have created the
/// file. On a fresh machine it would have stayed invisible.
///
/// So a full backup now captures EVERY `*.db` under the base dir and skips only what is named here.
/// An unknown store is CAPTURED, which is the safe direction to fail: a backup holding something
/// unnecessary costs disk, while a backup missing something costs the data.
///
/// `secrets` is the one entry that is a hard rule rather than a preference. It is the store whose
/// disclosure cannot be walked back: the values live in the OS keychain, but WHICH services a user is
/// paired with is itself disclosure, and a backup travelling to a NAS or a cloud is exactly where
/// that leaks. Backing it up safely is a different problem from copying a database — it needs its own
/// decision about encryption and about what a restore on a DIFFERENT machine should even mean, since
/// the keychain entries it points at will not be there. Deferred on purpose, with a home:
/// `the-credential-store-needs-its-own-backup-decision`.
pub const NEVER_CAPTURED: &[(&str, &str)] = &[
    ("secrets", "disclosure that cannot be walked back; needs its own backup decision (deferred)"),
];

/// Every `*.db` directly under `base`, sorted, minus [`NEVER_CAPTURED`].
///
/// Discovery rather than a roster is what makes silent omission structurally impossible — there is no
/// list to forget to update. The scan is deliberately SHALLOW: `plans/` is captured separately
/// because its members are per-project and belong under their own key in the manifest.
pub fn discoverable_stores(base: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(base) else { return Vec::new() };
    let mut paths: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|x| x.to_str()) == Some("db"))
        .filter(|p| {
            let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
            !NEVER_CAPTURED.iter().any(|(name, _)| *name == stem)
        })
        .collect();
    paths.sort();
    paths
}

/// One captured store, as the manifest records it.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct CapturedStore {
    pub name: String,
    pub bytes: u64,
    /// `ok`, or SQLite's complaint. RECORDED rather than merely checked: a backup that cannot say
    /// whether it verified is not meaningfully different from one that did not.
    pub integrity: String,
}

/// A store the backup deliberately did NOT take, and why — recorded in the artifact itself.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct SkippedStore {
    pub name: String,
    pub reason: String,
}

/// What a full backup wrote, so the artifact can describe itself without being restored.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct BackupManifest {
    pub scope: String,
    pub studio: String,
    pub stores: Vec<CapturedStore>,
    pub plans: Vec<CapturedStore>,
    /// Stores that were declared but absent — an empty machine is legitimate, a SILENT gap is not.
    pub absent: Vec<String>,
    /// Stores present on the machine and deliberately left behind, each with its reason. A restore
    /// reads this to know what it can NOT put back.
    #[serde(default)]
    pub skipped: Vec<SkippedStore>,
}

/// Copy one SQLite database consistently, and verify it.
///
/// `VACUUM INTO` rather than a file copy, and this is the whole correctness argument: a live machine
/// has `-wal` sidecars beside its stores (16 of them beside `plans/` when this was written), and
/// copying a `.db` whose write-ahead log holds uncommitted pages yields a stale or torn file that
/// looks exactly like a working backup until someone restores it. `VACUUM INTO` takes a read
/// transaction, so it captures a consistent point-in-time image into ONE file with no sidecars.
///
/// The copy is then `integrity_check`ed and the answer is recorded. Verifying without recording
/// would leave the manifest unable to say whether it had.
fn vacuum_into(src: &Path, dest: &Path) -> Result<CapturedStore, String> {
    let name = src.file_stem().and_then(|s| s.to_str()).unwrap_or("store").to_string();
    if dest.exists() {
        // VACUUM INTO refuses an existing target, and that refusal is right — silently overwriting a
        // previous backup is how one bad run destroys the last good copy.
        return Err(format!("{} already exists; refusing to overwrite a previous backup", dest.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let conn = bsc_sqlite_util::open_db_str(src, "store")?;
    conn.execute("VACUUM INTO ?1", [dest.to_string_lossy().as_ref()])
        .map_err(|e| format!("VACUUM INTO {} failed: {e}", dest.display()))?;

    let copy = bsc_sqlite_util::open_db_str(dest, "store")?;
    let integrity: String = copy
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .unwrap_or_else(|e| format!("integrity_check could not run: {e}"));
    let bytes = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
    Ok(CapturedStore { name, bytes, integrity })
}

/// Total user rows in a SQLite file, or 0 if it cannot be read.
///
/// The caller MUST have checked the file exists — opening a path creates it, and creating the very
/// files we are about to call empty is how the first version of this guard defeated itself.
fn total_rows(db: &Path) -> u64 {
    let Ok(conn) = bsc_sqlite_util::open_db_str(db, "store") else { return 0 };
    let Ok(mut stmt) =
        conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    else {
        return 0;
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else { return 0 };
    let tables: Vec<String> = rows.flatten().collect();
    tables
        .iter()
        .map(|t| {
            // The table name comes from sqlite_master, not from user input, and cannot be bound as a
            // parameter in a FROM clause. Quoted to survive a table name needing it.
            conn.query_row(&format!("SELECT count(*) FROM \"{}\"", t.replace('"', "\"\"")), [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap_or(0)
            .max(0) as u64
        })
        .sum()
}

/// Is this base worth backing up at all? `Some(found)` when everything is bare, naming what was
/// looked at; `None` when there is real content.
///
/// READS ONLY WHAT ALREADY EXISTS. It must never call [`build_snapshot`], which CREATES the
/// json-store files it opens — the first version of this guard did, materialised nine empty stores,
/// and then could not see that the source was empty because it had just populated it with emptiness.
fn source_is_bare(base: &Path) -> Option<Vec<String>> {
    // Any plan store at all means real per-project work; never refuse in that case.
    if let Ok(entries) = std::fs::read_dir(base.join("plans")) {
        if entries.flatten().any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("db")) {
            return None;
        }
    }
    let mut found = Vec::new();
    for db in discoverable_stores(base) {
        if total_rows(&db) > 0 {
            return None;
        }
        found.push(db.file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_string());
    }
    found.sort();
    Some(found)
}

/// How a full backup should behave. A struct rather than a growing positional list — the same reason
/// `ensure_session_settings` stopped taking 29 arguments.
#[derive(Debug, Default, Clone)]
pub struct BackupOptions {
    pub description: Option<String>,
    /// Take the backup even when the source holds nothing. OFF by default, and that default is the
    /// feature: see [`backup_full`].
    pub allow_empty: bool,
    /// Which library systems the bundle carries. `None` means every system in the roster.
    pub systems: Option<Vec<String>>,
    /// Capture the SQLite stores and the per-project plan stores. `false` yields a library-only
    /// bundle, which is the shareable artifact.
    pub databases: bool,
}

/// THE ONE ENTRY POINT for taking a backup, and the place the shape rule is enforced.
///
/// Selecting only library collections can still produce a single JSON file. Selecting the databases
/// cannot: 28 MB of SQLite does not belong inside a JSON bundle, so the artifact becomes a DIRECTORY.
/// An `--out` naming a `.json` path while a database-backed system is selected is therefore REFUSED,
/// naming what forced the directory — silently writing a directory where a file was asked for is
/// worse than saying no, because the caller's next step (a copy, a checksum, a sync rule) is built
/// around the shape it asked for.
pub fn backup(base: &Path, out: &Path, name: &str, opts: &BackupOptions) -> Result<BackupManifest, String> {
    let looks_like_a_file = out.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")).unwrap_or(false);
    if opts.databases && looks_like_a_file {
        return Err(format!(
            "--out {} names a .json file, but the plan stores and SQLite stores force a DIRECTORY \
             (28 MB of SQLite cannot live in a JSON bundle). Give --out a directory path, or drop \
             the database selection to get a single-file library bundle.",
            out.display()
        ));
    }
    if opts.databases {
        return backup_full(base, out, name, opts);
    }

    // Library-only: one self-contained JSON file at exactly the path asked for.
    if !opts.allow_empty {
        if let Some(bare) = source_is_bare(base) {
            let what = if bare.is_empty() {
                "no stores were found there at all".to_string()
            } else {
                format!("every store is empty: {}", bare.join(", "))
            };
            return Err(format!(
                "refusing to back up {base}: {what}. Pass --allow-empty if that is genuinely intended.",
                base = base.display()
            ));
        }
    }
    let studio = Studio {
        id: slug(name)?,
        name: name.to_string(),
        description: opts.description.clone().filter(|d| !d.trim().is_empty()),
        version: None,
        snapshot: match &opts.systems {
            Some(keys) => build_snapshot_for(base, keys)?,
            None => build_snapshot(base),
        },
    };
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(&studio).map_err(|e| format!("backup: {e}"))?;
    std::fs::write(out, json).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    Ok(BackupManifest {
        scope: Scope::Library.as_str().to_string(),
        studio: studio.id,
        stores: Vec::new(),
        plans: Vec::new(),
        absent: Vec::new(),
        skipped: Vec::new(),
    })
}

/// Write a FULL backup of `base` into `out`: the library bundle plus a consistent copy of every
/// SQLite store, including every per-project plan store.
///
/// A directory rather than one file, because 28 MB of SQLite cannot live inside a JSON bundle
/// without base64 inflating it by a third and making the result unreadable by anything but this
/// tool. The bundle stays JSON; the databases stay databases.
pub fn backup_full(base: &Path, out: &Path, name: &str, opts: &BackupOptions) -> Result<BackupManifest, String> {
    // REFUSED BEFORE ANYTHING IS WRITTEN, and the order matters: `build_snapshot` CREATES the
    // json-store files it opens, so a backup of an empty base materialises empty stores at the SOURCE
    // and then faithfully captures them. The artifact looks populated and holds nothing — the worst
    // possible failure for a backup, and the one probed live on this feature's originating item
    // (`studio save --dir <empty>` produced an all-empty bundle and reported success).
    if !opts.allow_empty {
        if let Some(bare) = source_is_bare(base) {
            let what = if bare.is_empty() {
                "no stores were found there at all".to_string()
            } else {
                format!("every store is empty: {}", bare.join(", "))
            };
            return Err(format!(
                "refusing to back up {base}: {what}. A backup that appears to succeed and contains \
                 nothing is the worst outcome this verb has, so it is refused rather than written. \
                 Check --dir points at the install you meant to READ (it is not where the backup \
                 goes — that is --out); pass --allow-empty if an empty backup is genuinely intended.",
                base = base.display()
            ));
        }
    }
    std::fs::create_dir_all(out).map_err(|e| format!("cannot create {}: {e}", out.display()))?;

    let mut studio = Studio {
        id: slug(name)?,
        name: name.to_string(),
        description: opts.description.clone().filter(|d| !d.trim().is_empty()),
        version: None,
        snapshot: match &opts.systems {
            Some(keys) => build_snapshot_for(base, keys)?,
            None => build_snapshot(base),
        },
    };
    // The bundle self-identifies. A full-scope artifact must not be mistaken for a shareable one on
    // the strength of its filename alone.
    studio.description = Some(match studio.description.take() {
        Some(d) => format!("[scope: full — contains private project state] {d}"),
        None => "[scope: full — contains private project state]".to_string(),
    });
    let bundle = serde_json::to_string_pretty(&studio).map_err(|e| format!("backup: {e}"))?;
    std::fs::write(out.join("studio.json"), bundle)
        .map_err(|e| format!("cannot write the bundle: {e}"))?;

    // DISCOVERED, not enumerated. Every `*.db` under the base is captured unless NEVER_CAPTURED names
    // it, so a store added by a future crate is backed up without anyone remembering to list it.
    let mut stores = Vec::new();
    for src in discoverable_stores(base) {
        let file = src.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        stores.push(vacuum_into(&src, &out.join("stores").join(file))?);
    }
    // What was deliberately left behind, recorded IN the artifact. A backup that cannot say what it
    // skipped is indistinguishable from one that skipped something by accident.
    let skipped: Vec<SkippedStore> = NEVER_CAPTURED
        .iter()
        .filter(|(name, _)| base.join(format!("{name}.db")).is_file())
        .map(|(name, why)| SkippedStore { name: (*name).to_string(), reason: (*why).to_string() })
        .collect();
    let mut absent: Vec<String> = Vec::new();

    // Plan stores are per-project and their names are not knowable in advance, so they are captured
    // by SCAN. The `-wal`/`-shm` sidecars are deliberately NOT copied — `VACUUM INTO` folds them in,
    // and copying them beside a vacuumed file would leave a database with a log it does not match.
    let mut plans = Vec::new();
    let plans_dir = base.join("plans");
    if let Ok(entries) = std::fs::read_dir(&plans_dir) {
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("db"))
            .collect();
        paths.sort();
        for p in paths {
            let file = p.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
            plans.push(vacuum_into(&p, &out.join("plans").join(file))?);
        }
    } else {
        absent.push("plans".to_string());
    }

    let manifest = BackupManifest {
        scope: Scope::Full.as_str().to_string(),
        studio: studio.id.clone(),
        stores,
        plans,
        absent,
        skipped,
    };
    let text = serde_json::to_string_pretty(&manifest).map_err(|e| format!("manifest: {e}"))?;
    std::fs::write(out.join("manifest.json"), text)
        .map_err(|e| format!("cannot write the manifest: {e}"))?;
    Ok(manifest)
}

// ── VERIFY + RESTORE (`the-backup-proves-it-can-be-restored`) ────────────────────────────────────

/// One file's verdict, as `verify` found it on disk.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct VerifiedFile {
    pub name: String,
    pub kind: String,
    /// `ok`, SQLite's complaint, or why it could not be read at all.
    pub integrity: String,
    pub bytes: u64,
}

/// What a backup looks like NOW, as against what its manifest claims.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct VerifyReport {
    pub dir: String,
    pub scope: String,
    pub files: Vec<VerifiedFile>,
    /// Named in the manifest, missing from disk. The failure that matters most.
    pub missing: Vec<String>,
    /// On disk, absent from the manifest — the artifact and its own description disagree.
    pub unexpected: Vec<String>,
    /// Present and readable, but SQLite says the file is damaged.
    pub corrupt: Vec<String>,
    pub ok: bool,
}

fn read_manifest(dir: &Path) -> Result<BackupManifest, String> {
    let path = dir.join("manifest.json");
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "{} has no readable manifest.json ({e}). A full backup always writes one, so either this \
             is a library bundle (a single .json file, not a directory) or the backup is incomplete.",
            dir.display()
        )
    })?;
    serde_json::from_str(&text).map_err(|e| format!("manifest.json is not readable as a manifest: {e}"))
}

/// Re-check a backup WITHOUT restoring it — the answer to "is last week's copy still good?".
///
/// Every claim is re-derived from the files rather than trusted: each database is opened and
/// `integrity_check`ed, and the manifest is compared against the directory in BOTH directions. A file
/// the manifest forgot is as much a disagreement as one it promised and lost — the artifact must not
/// be able to describe itself incorrectly and still pass.
pub fn verify_backup(dir: &Path) -> Result<VerifyReport, String> {
    let manifest = read_manifest(dir)?;
    let mut files = Vec::new();
    let (mut missing, mut corrupt) = (Vec::new(), Vec::new());

    for (kind, listed) in [("store", &manifest.stores), ("plan", &manifest.plans)] {
        let sub = if kind == "store" { "stores" } else { "plans" };
        for captured in listed {
            // Both tiers name their file the same way — `vacuum_into` records the file STEM, so the
            // suffix is added back here for either kind.
            let name = format!("{}.db", captured.name);
            let path = dir.join(sub).join(&name);
            if !path.is_file() {
                missing.push(format!("{sub}/{name}"));
                continue;
            }
            let integrity = match bsc_sqlite_util::open_db_str(&path, "store") {
                Ok(conn) => conn
                    .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                    .unwrap_or_else(|e| format!("integrity_check could not run: {e}")),
                Err(e) => format!("could not open: {e}"),
            };
            if integrity != "ok" {
                corrupt.push(format!("{sub}/{name}"));
            }
            let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            files.push(VerifiedFile { name: format!("{sub}/{name}"), kind: kind.to_string(), integrity, bytes });
        }
    }

    // The other direction: a file on disk the manifest never mentioned.
    let mut unexpected = Vec::new();
    for sub in ["stores", "plans"] {
        if let Ok(entries) = std::fs::read_dir(dir.join(sub)) {
            for e in entries.flatten() {
                let n = e.file_name().to_string_lossy().into_owned();
                if !n.ends_with(".db") {
                    continue;
                }
                let rel = format!("{sub}/{n}");
                if !files.iter().any(|f| f.name == rel) && !missing.contains(&rel) {
                    unexpected.push(rel);
                }
            }
        }
    }
    missing.sort();
    unexpected.sort();
    corrupt.sort();
    let ok = missing.is_empty() && unexpected.is_empty() && corrupt.is_empty();
    Ok(VerifyReport {
        dir: dir.display().to_string(),
        scope: manifest.scope,
        files,
        missing,
        unexpected,
        corrupt,
        ok,
    })
}

/// How a restore should behave.
#[derive(Debug, Default, Clone)]
pub struct RestoreOptions {
    /// Report every write and perform NONE of them. The documented posture.
    pub dry_run: bool,
    /// Write over stores that already exist at the destination. OFF by default — see [`restore_backup`].
    pub force: bool,
}

/// What a restore did, or (dry) would do.
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RestoreReport {
    pub from: String,
    pub into: String,
    pub dry_run: bool,
    pub restored: Vec<String>,
    /// Present at the destination and left alone — only possible under `force`, or in a dry run.
    pub would_overwrite: Vec<String>,
    /// Stated on every restore so nobody believes their pairings came back.
    pub not_restored: Vec<SkippedStore>,
}

/// Put a full backup's stores and plan stores back under `base`.
///
/// REFUSES A NON-EMPTY DESTINATION unless `force`, and names what it would have overwritten. A
/// recovery that silently writes over a live install is how restoring destroys the thing it was
/// restoring — and the likeliest moment to run this verb wrongly is in a panic, pointed at the
/// machine that still has data on it.
///
/// VERIFIES BEFORE IT WRITES. A backup with a missing or corrupt file is refused whole rather than
/// applied in part, because a half-restored base is harder to reason about than one that was never
/// touched: the operator cannot tell which half is which.
pub fn restore_backup(from: &Path, base: &Path, opts: &RestoreOptions) -> Result<RestoreReport, String> {
    let report = verify_backup(from)?;
    if !report.ok {
        return Err(format!(
            "refusing to restore from {}: the backup does not verify (missing: {:?}, corrupt: {:?}, \
             unexpected: {:?}). A partial restore is worse than none — you cannot tell afterwards \
             which half landed. Run `bsc studio verify --from {}` for the detail.",
            from.display(),
            report.missing,
            report.corrupt,
            report.unexpected,
            from.display()
        ));
    }
    let manifest = read_manifest(from)?;

    let mut planned: Vec<(PathBuf, PathBuf, String)> = Vec::new();
    for captured in &manifest.stores {
        let name = format!("{}.db", captured.name);
        planned.push((from.join("stores").join(&name), base.join(&name), name));
    }
    for captured in &manifest.plans {
        let name = format!("{}.db", captured.name);
        planned.push((from.join("plans").join(&name), base.join("plans").join(&name), format!("plans/{name}")));
    }

    let occupied: Vec<String> =
        planned.iter().filter(|(_, dest, _)| dest.exists()).map(|(_, _, n)| n.clone()).collect();
    if !occupied.is_empty() && !opts.force && !opts.dry_run {
        return Err(format!(
            "refusing to restore into {}: {} store(s) already exist there and would be overwritten \
             ({}{}). Restore into an EMPTY base, or pass --force if you genuinely mean to replace a \
             live install. Run with --dry-run first to see every write.",
            base.display(),
            occupied.len(),
            occupied.iter().take(5).cloned().collect::<Vec<_>>().join(", "),
            if occupied.len() > 5 { ", …" } else { "" }
        ));
    }

    let mut restored = Vec::new();
    if !opts.dry_run {
        for (src, dest, name) in &planned {
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
            }
            std::fs::copy(src, dest).map_err(|e| format!("restoring {name}: {e}"))?;
            restored.push(name.clone());
        }
    } else {
        restored = planned.iter().map(|(_, _, n)| n.clone()).collect();
    }

    Ok(RestoreReport {
        from: from.display().to_string(),
        into: base.display().to_string(),
        dry_run: opts.dry_run,
        restored,
        would_overwrite: occupied,
        // Stated every time, from the artifact's own record rather than from this code's memory.
        not_restored: manifest.skipped,
    })
}


#[cfg(test)]
mod backup_tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("studio-backup-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("scratch");
        d
    }

    /// A store with a LIVE write-ahead log still copies consistently.
    ///
    /// THE WHOLE REASON `VACUUM INTO` IS USED. A file copy here would take the `.db` without the
    /// `-wal` beside it and lose every row still in the log — a backup that restores to an older
    /// state while reporting success. The fixture leaves rows in the WAL on purpose.
    #[test]
    fn a_store_with_an_open_wal_copies_every_committed_row() {
        let root = scratch("wal");
        let src = root.join("live.db");
        let conn = bsc_sqlite_util::open_db_str(&src, "store").expect("open");
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             CREATE TABLE t (id TEXT PRIMARY KEY);
             INSERT INTO t VALUES ('a'),('b'),('c');",
        )
        .expect("seed");
        assert!(src.with_extension("db-wal").exists() || root.join("live.db-wal").exists(),
            "the fixture must actually leave a WAL, or it proves nothing");

        let got = vacuum_into(&src, &root.join("out/live.db")).expect("vacuum");
        assert_eq!(got.integrity, "ok");
        let copy = bsc_sqlite_util::open_db_str(&root.join("out/live.db"), "store").expect("open copy");
        let n: i64 = copy.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).expect("count");
        assert_eq!(n, 3, "every committed row must survive, including those still in the WAL");
        // And no sidecar travels with it — the copy is one self-contained file.
        assert!(!root.join("out/live.db-wal").exists(), "a vacuumed copy needs no WAL beside it");
        std::fs::remove_dir_all(&root).ok();
    }

    /// An existing target is REFUSED, never overwritten. Silently clobbering the previous backup is
    /// how one bad run destroys the last good copy.
    #[test]
    fn an_existing_target_is_refused_rather_than_overwritten() {
        let root = scratch("refuse");
        let src = root.join("s.db");
        bsc_sqlite_util::open_db_str(&src, "store").expect("open")
            .execute_batch("CREATE TABLE t (id TEXT);").expect("seed");
        let dest = root.join("out/s.db");
        vacuum_into(&src, &dest).expect("first copy");
        let err = vacuum_into(&src, &dest).expect_err("a second copy must be refused");
        assert!(err.contains("refusing to overwrite"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// An absent store is RECORDED, not skipped in silence. An empty machine is legitimate; a gap
    /// nobody can see is the failure this whole surface exists to prevent.
    #[test]
    fn an_absent_store_is_recorded_rather_than_silently_skipped() {
        let root = scratch("absent");
        let out = root.join("backup");
        let m = backup_full(&root, &out, "probe", &BackupOptions { allow_empty: true, ..Default::default() }).expect("backup an empty base");
        // `plans/` is the one location a full backup EXPECTS by name, so its absence is reportable
        // where an undiscovered store's cannot be — there is no list of stores to be absent from.
        assert!(m.absent.contains(&"plans".to_string()), "a missing plans/ must be named: {:?}", m.absent);
        assert_eq!(m.scope, "full");
        assert!(out.join("manifest.json").is_file(), "the manifest must exist even for an empty base");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A full-scope bundle SAYS SO in its own description, so it cannot be mistaken for a shareable
    /// one on the strength of a filename.
    #[test]
    fn a_full_bundle_identifies_itself_as_private() {
        let root = scratch("marks");
        let out = root.join("backup");
        backup_full(&root, &out, "probe", &BackupOptions { description: Some("my notes".into()), allow_empty: true, ..Default::default() }).expect("backup");
        let text = std::fs::read_to_string(out.join("studio.json")).expect("bundle");
        assert!(text.contains("scope: full"), "the bundle must self-identify as full-scope");
        assert!(text.contains("private project state"), "and say why that matters");
        assert!(text.contains("my notes"), "without discarding the caller's own description");
        std::fs::remove_dir_all(&root).ok();
    }

    /// `secrets` is captured by NOTHING — not a scope, not a flag, not `--all`.
    ///
    /// Pinned rather than trusted to the roster staying right: it is the one store whose disclosure
    /// cannot be walked back, and the interim position while
    /// `the-credential-store-needs-its-own-backup-decision` is open is that it never travels.
    #[test]
    fn the_credential_store_is_captured_by_nothing() {
        // Proved by RUNNING a backup against a base that has one, not by inspecting a list. A list
        // assertion passes even if the capture loop stops consulting the list.
        let root = scratch("secrets");
        bsc_sqlite_util::open_db_str(&root.join("secrets.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE pairing (service TEXT); INSERT INTO pairing VALUES ('github');")
            .expect("seed");
        let out = root.join("backup");
        let m = backup_full(&root, &out, "probe", &BackupOptions { allow_empty: true, ..Default::default() }).expect("backup");

        assert!(
            !out.join("stores/secrets.db").exists(),
            "the credential store must never be written into a backup"
        );
        assert!(
            !m.stores.iter().any(|c| c.name == "secrets"),
            "and it must not be claimed in the manifest either"
        );
        // Its omission is RECORDED, not merely silent — that is the whole difference between a
        // deliberate exclusion and a bug.
        let noted = m.skipped.iter().find(|s| s.name == "secrets").expect("secrets must be recorded as skipped");
        assert!(noted.reason.len() > 20, "with a real reason: {:?}", noted.reason);
        std::fs::remove_dir_all(&root).ok();
    }

    /// NOTHING can be silently omitted — an unknown store is CAPTURED, not skipped.
    ///
    /// This is the guard the `atlas.db` miss earned. The full-backup set was an ALLOW-list, so a
    /// store a future crate adds was omitted until somebody remembered a row; `atlas` shipped that
    /// way and was only caught because this machine happened to have created the file. Discovery
    /// inverts it, and this test is what stops anyone inverting it back.
    #[test]
    fn a_store_nobody_declared_is_still_captured() {
        let root = scratch("unknown");
        // A store no roster in this crate has ever heard of.
        bsc_sqlite_util::open_db_str(&root.join("wildcard.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('kept');")
            .expect("seed");
        let out = root.join("backup");
        let m = backup_full(&root, &out, "probe", &BackupOptions { allow_empty: true, ..Default::default() }).expect("backup");

        assert!(
            out.join("stores/wildcard.db").is_file(),
            "an undeclared store must be captured, not silently dropped — that direction is the \
             whole safety argument for a backup"
        );
        assert!(m.stores.iter().any(|c| c.name == "wildcard" && c.integrity == "ok"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// AN EMPTY BACKUP IS REFUSED — the worst possible outcome for this feature.
    ///
    /// Probed live on the originating item: `studio save --dir <empty>` created empty stores at the
    /// destination, snapshotted THOSE, and reported success. `build_snapshot` materialises the files
    /// it opens, so the refusal has to run BEFORE anything is written or it can never fire.
    #[test]
    fn an_all_empty_source_is_refused_and_names_what_it_found_bare() {
        let root = scratch("empty");
        let out = root.join("backup");
        let err = backup_full(&root, &out, "probe", &BackupOptions::default())
            .expect_err("a source holding nothing must be refused");
        assert!(err.contains("no stores were found there at all"), "{err}");
        assert!(err.contains("--allow-empty"), "and say how to override it: {err}");
        assert!(err.contains("--dir"), "and point at the flag that is usually the real mistake: {err}");
        assert!(!out.exists(), "and nothing may be written — a refused backup must leave no artifact");
        std::fs::remove_dir_all(&root).ok();
    }

    /// The SECOND run of the same mistake is refused too, and this is the harder case.
    ///
    /// After one `--dir <empty>` the base is no longer empty: `build_snapshot` left nine created-but-
    /// empty stores behind. A guard that only checks whether store FILES exist passes here and backs
    /// up nothing, which is exactly the shape of the original bug. The stores must be read.
    #[test]
    fn a_base_of_created_but_empty_stores_is_still_refused() {
        let root = scratch("emptied");
        // Precisely what a previous run leaves behind: real store files with no rows in them.
        for name in ["personas", "components", "orgs"] {
            bsc_sqlite_util::open_db_str(&root.join(format!("{name}.db")), "store")
                .expect("open")
                .execute_batch("CREATE TABLE records (id TEXT PRIMARY KEY, json TEXT);")
                .expect("seed schema but no rows");
        }
        let out = root.join("backup");
        let err = backup_full(&root, &out, "probe", &BackupOptions::default())
            .expect_err("stores that exist but hold nothing must still be refused");
        assert!(err.contains("every store is empty"), "{err}");
        assert!(
            err.contains("personas") && err.contains("components"),
            "the refusal must NAME what it found bare: {err}"
        );
        assert!(!out.exists(), "a refused backup must leave no artifact");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A source with real content is NOT refused — the guard must not block the thing it protects.
    #[test]
    fn a_source_with_content_backs_up_without_the_override() {
        let root = scratch("nonempty");
        bsc_sqlite_util::open_db_str(&root.join("wildcard.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x');")
            .expect("seed");
        let out = root.join("backup");
        let m = backup_full(&root, &out, "probe", &BackupOptions::default())
            .expect("a base with a real store must back up with no override");
        assert!(m.stores.iter().any(|c| c.name == "wildcard"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// A backup with real content SAVES, VERIFIES and RESTORES onto an empty base with the rows intact.
    ///
    /// The round trip is the whole acceptance: a backup nobody has restored is a hope, not a backup.
    #[test]
    fn a_backup_round_trips_onto_an_empty_base_with_its_rows() {
        let root = scratch("roundtrip");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("things.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY); INSERT INTO t VALUES ('a'),('b'),('c');")
            .expect("seed");
        std::fs::create_dir_all(src.join("plans")).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("plans/proj.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE issues (ref TEXT); INSERT INTO issues VALUES ('x'),('y');")
            .expect("seed");

        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() })
            .expect("backup");

        let v = verify_backup(&out).expect("verify");
        assert!(v.ok, "a fresh backup must verify: {v:?}");
        assert!(v.files.iter().all(|f| f.integrity == "ok"));

        let dest = root.join("recovered");
        let r = restore_backup(&out, &dest, &RestoreOptions::default()).expect("restore");
        assert!(!r.dry_run);
        assert!(r.restored.iter().any(|n| n == "things.db"), "{:?}", r.restored);
        assert!(r.restored.iter().any(|n| n == "plans/proj.db"), "{:?}", r.restored);

        // THE ACCEPTANCE: the rows are actually there afterwards.
        let got: i64 = bsc_sqlite_util::open_db_str(&dest.join("things.db"), "store")
            .expect("open restored")
            .query_row("SELECT count(*) FROM t", [], |r| r.get(0))
            .expect("count");
        assert_eq!(got, 3, "every row must survive save -> restore");
        let issues: i64 = bsc_sqlite_util::open_db_str(&dest.join("plans/proj.db"), "store")
            .expect("open restored plan store")
            .query_row("SELECT count(*) FROM issues", [], |r| r.get(0))
            .expect("count");
        assert_eq!(issues, 2, "plan stores restore under plans/, not beside the others");
        std::fs::remove_dir_all(&root).ok();
    }

    /// RESTORING OVER A LIVE INSTALL IS REFUSED, and the refusal names what it would have destroyed.
    ///
    /// The likeliest moment to run this verb wrongly is in a panic, pointed at the machine that still
    /// has the data on it.
    #[test]
    fn restoring_over_an_occupied_base_is_refused_and_names_the_casualties() {
        let root = scratch("occupied");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("things.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a');")
            .expect("seed");
        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() }).expect("backup");

        // A destination that already holds a store — i.e. a live install.
        let dest = root.join("occupied");
        std::fs::create_dir_all(&dest).unwrap();
        bsc_sqlite_util::open_db_str(&dest.join("things.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('PRECIOUS');")
            .expect("seed");

        let err = restore_backup(&out, &dest, &RestoreOptions::default())
            .expect_err("an occupied base must be refused");
        assert!(err.contains("already exist"), "{err}");
        assert!(err.contains("things.db"), "the refusal must NAME what it would overwrite: {err}");
        assert!(err.contains("--force"), "and say how to override it: {err}");

        // And nothing was touched.
        let still: String = bsc_sqlite_util::open_db_str(&dest.join("things.db"), "store")
            .expect("open")
            .query_row("SELECT id FROM t", [], |r| r.get(0))
            .expect("row");
        assert_eq!(still, "PRECIOUS", "a refused restore must not have written anything");

        // --force goes through.
        restore_backup(&out, &dest, &RestoreOptions { force: true, ..Default::default() })
            .expect("--force must be able to replace a live install deliberately");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A dry run reports every write and performs NONE of them.
    #[test]
    fn a_dry_run_lists_the_writes_and_makes_none() {
        let root = scratch("dry");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("things.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('a');")
            .expect("seed");
        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() }).expect("backup");

        let dest = root.join("nowhere");
        let r = restore_backup(&out, &dest, &RestoreOptions { dry_run: true, ..Default::default() })
            .expect("a dry run always succeeds");
        assert!(r.dry_run);
        assert!(!r.restored.is_empty(), "it must still SAY what it would write");
        assert!(!dest.exists(), "and create nothing at all");
        std::fs::remove_dir_all(&root).ok();
    }

    /// A DAMAGED backup is refused WHOLE, never applied in part.
    ///
    /// Half a restore is worse than none: afterwards nobody can tell which half landed.
    #[test]
    fn a_backup_missing_a_file_is_refused_before_anything_is_written() {
        let root = scratch("damaged");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        for n in ["a", "b"] {
            bsc_sqlite_util::open_db_str(&src.join(format!("{n}.db")), "store")
                .expect("open")
                .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x');")
                .expect("seed");
        }
        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() }).expect("backup");

        // Rot: one captured file disappears after the fact.
        std::fs::remove_file(out.join("stores/a.db")).expect("simulate a lost file");

        let v = verify_backup(&out).expect("verify still reports");
        assert!(!v.ok, "verify must NOT call a backup with a lost file good");
        assert!(v.missing.iter().any(|m| m.contains("a.db")), "{v:?}");

        let dest = root.join("recovered");
        let err = restore_backup(&out, &dest, &RestoreOptions::default())
            .expect_err("a backup that does not verify must be refused");
        assert!(err.contains("does not verify"), "{err}");
        assert!(
            !dest.join("b.db").exists(),
            "and the GOOD file must not have landed either — the refusal is whole, not partial"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    /// The artifact and its own description must agree in BOTH directions.
    #[test]
    fn a_file_the_manifest_never_mentioned_fails_verification() {
        let root = scratch("extra");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("a.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x');")
            .expect("seed");
        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() }).expect("backup");

        // Something the manifest knows nothing about.
        bsc_sqlite_util::open_db_str(&out.join("stores/stowaway.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT);")
            .expect("seed");

        let v = verify_backup(&out).expect("verify");
        assert!(!v.ok, "an artifact that disagrees with its own manifest is not good");
        assert!(v.unexpected.iter().any(|u| u.contains("stowaway")), "{v:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Every restore SAYS that secrets were never captured, so nobody believes pairings came back.
    #[test]
    fn a_restore_states_what_was_never_captured() {
        let root = scratch("saysso");
        let src = root.join("live");
        std::fs::create_dir_all(&src).unwrap();
        bsc_sqlite_util::open_db_str(&src.join("a.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE t (id TEXT); INSERT INTO t VALUES ('x');")
            .expect("seed");
        bsc_sqlite_util::open_db_str(&src.join("secrets.db"), "store")
            .expect("open")
            .execute_batch("CREATE TABLE pairing (service TEXT); INSERT INTO pairing VALUES ('github');")
            .expect("seed");
        let out = root.join("backup");
        backup(&src, &out, "probe", &BackupOptions { databases: true, ..Default::default() }).expect("backup");

        let r = restore_backup(&out, &root.join("recovered"), &RestoreOptions::default()).expect("restore");
        let noted = r.not_restored.iter().find(|s| s.name == "secrets")
            .expect("a restore must SAY secrets were never in the backup");
        assert!(noted.reason.len() > 20, "with the reason: {:?}", noted.reason);
        assert!(!r.restored.iter().any(|n| n.contains("secrets")), "and must not have restored it");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Every deny-list entry states why, so an omission cannot be parked without an argument.
    #[test]
    fn every_never_captured_entry_states_why() {
        assert!(!NEVER_CAPTURED.is_empty(), "the deny-list must not quietly empty itself");
        for (name, why) in NEVER_CAPTURED {
            assert!(why.len() > 20, "{name} is skipped without a real reason: {why:?}");
        }
    }

    #[test]
    fn scope_parses_and_rejects_anything_else() {
        assert_eq!(Scope::parse("library").unwrap(), Scope::Library);
        assert_eq!(Scope::parse("full").unwrap(), Scope::Full);
        assert!(Scope::parse("everything").unwrap_err().contains("expected library|full"));
    }
}
