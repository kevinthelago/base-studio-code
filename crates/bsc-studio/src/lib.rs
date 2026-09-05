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
