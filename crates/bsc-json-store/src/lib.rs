//! `bsc-json-store` core — the shared record CRUD behind the USER **verbatim-JSON-per-id** stores
//! (#2158, an instance of #1325). `bsc-blueprint` (`blueprints`), `bsc-persona` (`personas`),
//! `bsc-component` (`components`/`kits`), `bsc-teams` (`orgs`), `bsc-studio` (`studios`), and the
//! `bsc-ui` theme/variant stores were byte-identical copies of this store; they are now thin shims
//! that supply their own directory segment + noun.
//!
//! **Backend: SQLite (#2983, epic #2982).** Each store segment is one `.db` file — the store's
//! directory `<base>/<segment>` maps to the sibling `<base>/<segment>.db` (so the `components` segment
//! → `~/.base-studio-code/components.db`) — holding a single table
//! `records(id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL)`. Records stay
//! **verbatim JSON** (the frontend owns the shape; the store never imposes a typed schema). WAL + a
//! shared busy_timeout let the desktop app and a live session's `bsc` CLI touch the same db at once.
//!
//! **One-time legacy import.** On first open of a store whose db has never been migrated, if the legacy
//! `<segment>/` directory of `*.json` files exists it is imported verbatim (keyed by each file's id) —
//! but only while the db is empty, so it never clobbers later db edits or re-imports (guarded by a
//! `PRAGMA user_version` latch). The legacy dir is left in place; a later issue removes it.
//!
//! The `id` is slugified into a single safe segment (byte-identical to the app's `fsx::safe_dir_segment`
//! slug guard, #1761) before it keys a row, so a hostile id can never do anything but collide onto a
//! safe key — the same guarantee the old on-disk filename gave.
//!
//! The agent-facing CLI scaffold lives in [`cli`] (`bsc <noun> …`), parameterized per store by a
//! [`cli::CliSpec`] and dispatched by the unified `bsc` binary (#1877). Its `Store`-facing behavior
//! (`list`/`get`/`set`/`remove`) is unchanged by the SQLite migration.

pub mod cli;

use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};

/// A handle to a verbatim-JSON-per-id user store. Cheap to construct (it just resolves paths); the
/// SQLite connection is opened lazily per operation, so `new` stays infallible for the many callers
/// that build a `Store` without a `?` (matching the old file-store handle).
///
/// `dir` is the store's directory — historically `<id>.json` lived under it, and it is STILL the
/// one-time legacy-import source; the live db is the sibling `<dir>.db`. `noun` names the record in
/// the id-validation error (e.g. `"blueprint"`, `"persona"`).
pub struct Store {
    /// The store's directory (`~/.base-studio-code/<segment>/`) — the legacy `*.json` import source.
    dir: PathBuf,
    /// The SQLite db backing the store: the sibling `<dir>.db` (`~/.base-studio-code/<segment>.db`).
    db_path: PathBuf,
    noun: &'static str,
}

impl Store {
    /// Open a store whose directory is `dir` (used by the CLI + tests). The live db is the sibling
    /// `<dir>.db`; `dir` itself is only read once, to import any legacy `<dir>/<id>.json` files.
    /// `noun` names the record for the id-validation error (e.g. `"blueprint"`, `"persona"`).
    ///
    /// Infallible by design (the connection opens lazily on first use), so the existing callers that do
    /// `Store::new(base.join(segment), noun)` inline keep compiling unchanged.
    pub fn new(dir: impl Into<PathBuf>, noun: &'static str) -> Self {
        let dir = dir.into();
        let db_path = db_path_for(&dir);
        Store { dir, db_path, noun }
    }

    /// Open the default user store at `~/.base-studio-code/<segment>/` (db at `<segment>.db`). `Err`
    /// when no home dir is resolvable (matching the `bsc-*` CLI convention).
    pub fn open_default(segment: &str, noun: &'static str) -> Result<Self, String> {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        Ok(Store::new(base.join(segment), noun))
    }

    /// The **legacy** on-disk path a record `id` had before the SQLite migration
    /// (`<dir>/<slug(id)>.json`) — the file the one-time import reads. Still validates the id via the
    /// slug guard (empty / all-punctuation ⇒ `Err`), so it doubles as the id-safety check. The live
    /// store no longer writes this path; see [`Store::db_path`] for where records actually live.
    pub fn file(&self, id: &str) -> Result<PathBuf, String> {
        let safe = safe_id(id, self.noun)?;
        Ok(self.dir.join(format!("{safe}.json")))
    }

    /// The verbatim JSON of every record, ordered by id (the library hydrates from this). A
    /// whitespace-only value is skipped; an unopenable db ⇒ empty (matching the old "missing dir ⇒
    /// empty" leniency). Runs the one-time legacy import on first open.
    pub fn list(&self) -> Vec<String> {
        match self.conn() {
            Ok(conn) => list_records(&conn),
            Err(_) => Vec::new(),
        }
    }

    /// The verbatim JSON of one record, or `None` if absent. `Err` only on an invalid id or a db open
    /// failure.
    pub fn get(&self, id: &str) -> Result<Option<String>, String> {
        let key = safe_id(id, self.noun)?;
        let conn = self.conn()?;
        Ok(get_record(&conn, &key))
    }

    /// Persist a record keyed by (the slug of) `id`, stored verbatim (the frontend owns the shape).
    /// Upserts — a same-id write overwrites in place.
    pub fn set(&self, id: &str, json: &str) -> Result<(), String> {
        let key = safe_id(id, self.noun)?;
        let conn = self.conn()?;
        upsert_record(&conn, &key, json).map_err(|e| format!("set: {e}"))
    }

    /// Remove a record by (the slug of) `id` (a no-op, not an error, when absent).
    pub fn remove(&self, id: &str) -> Result<(), String> {
        let key = safe_id(id, self.noun)?;
        let conn = self.conn()?;
        remove_record(&conn, &key).map_err(|e| format!("remove: {e}"))
    }

    /// The store's directory (`~/.base-studio-code/<segment>/`) — the value a caller round-trips back
    /// through `--dir` / [`Store::new`] to reopen the SAME store. The backing db is the sibling
    /// `<dir>.db` (see [`Store::db_path`]).
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The SQLite file backing the store (`~/.base-studio-code/<segment>.db`).
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Open the backing db (creating parent dirs + setting the shared busy_timeout via
    /// [`bsc_sqlite_util::open_db`]), ensure the schema, and run the one-time legacy import. Every
    /// public method funnels through here, so the store is self-migrating on first touch.
    fn conn(&self) -> Result<Connection, String> {
        let conn = bsc_sqlite_util::open_db(&self.db_path)
            .map_err(|e| format!("open {}: {e}", self.noun))?;
        init_schema(&conn).map_err(|e| format!("{} schema: {e}", self.noun))?;
        maybe_import_legacy(&conn, &self.dir).map_err(|e| format!("{} import: {e}", self.noun))?;
        Ok(conn)
    }
}

/// The sibling `.db` path for a store directory: `<base>/<segment>` → `<base>/<segment>.db`. Appends
/// the extension (rather than `with_extension`) so a segment carrying a dot keeps its whole name
/// (`x.store` → `x.store.db`, never `x.db`).
fn db_path_for(dir: &Path) -> PathBuf {
    let mut s = dir.as_os_str().to_os_string();
    s.push(".db");
    PathBuf::from(s)
}

/// The single-table schema + WAL (idempotent — safe to run on every open). Mirrors the plandb/skilldb
/// pattern: WAL + the shared busy_timeout (set by `open_db`) let the app and a `bsc` CLI share the db.
fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS records (
            id          TEXT PRIMARY KEY,
            json        TEXT NOT NULL,
            updated_at  INTEGER NOT NULL DEFAULT 0
         );",
    )
}

/// Upsert one record verbatim by `id`, stamping `updated_at` with the current epoch seconds. A same-id
/// write overwrites the json in place (and re-stamps).
fn upsert_record(conn: &Connection, id: &str, json: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO records (id, json, updated_at) VALUES (?1, ?2, strftime('%s','now'))
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
        params![id, json],
    )?;
    Ok(())
}

/// Fetch one record's verbatim json by `id`, or `None` on a miss (or any read error — lenient, matching
/// the old `NotFound ⇒ None` file read).
fn get_record(conn: &Connection, id: &str) -> Option<String> {
    conn.query_row("SELECT json FROM records WHERE id = ?1", [id], |r| r.get(0)).ok()
}

/// Every record's verbatim json, ordered by id (deterministic). Whitespace-only values are skipped (the
/// old `list` skipped blank files); a prepare/query failure ⇒ empty.
fn list_records(conn: &Connection) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(mut stmt) = conn.prepare("SELECT json FROM records ORDER BY id") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for json in rows.flatten() {
                if !json.trim().is_empty() {
                    out.push(json);
                }
            }
        }
    }
    out
}

/// Delete one record by `id` (no-op if absent — `DELETE` affects 0 rows).
fn remove_record(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM records WHERE id = ?1", [id])?;
    Ok(())
}

/// The number of records currently in the table.
fn record_count(conn: &Connection) -> rusqlite::Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM records", [], |r| r.get(0))
}

/// The one-time legacy-import gate, run on every open. A `PRAGMA user_version` latch makes it fire at
/// most ONCE per db: after the first attempt (whether or not anything was imported) `user_version` is
/// stamped to 1, so a later op that empties the table (e.g. a studio `apply` that clears then re-seeds)
/// never re-imports the legacy files. The actual import is [`import_legacy_if_empty`].
fn maybe_import_legacy(conn: &Connection, legacy_dir: &Path) -> rusqlite::Result<()> {
    let migrated: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if migrated >= 1 {
        return Ok(());
    }
    import_legacy_if_empty(conn, legacy_dir)?;
    conn.execute_batch("PRAGMA user_version = 1;")
}

/// Import each `<legacy_dir>/<id>.json` file into the `records` table verbatim, keyed by the filename's
/// id — but ONLY while the table is empty (so it never clobbers db edits). Returns how many records were
/// imported. A non-empty table, a missing dir, an unreadable / whitespace-only / non-`.json` file, or a
/// stemless name are each skipped (never fatal). Idempotent by the empty-check: a second call over a
/// now-populated db is a no-op (returns 0).
///
/// The filename stem is already a `safe_id` slug (that is how the old store wrote it) and `safe_id` is
/// idempotent over its own output, so the imported key matches what a later `get(id)` computes.
fn import_legacy_if_empty(conn: &Connection, legacy_dir: &Path) -> rusqlite::Result<usize> {
    if record_count(conn)? > 0 {
        return Ok(0);
    }
    let Ok(entries) = std::fs::read_dir(legacy_dir) else {
        return Ok(0);
    };
    let mut imported = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(json) = std::fs::read_to_string(&path) else {
            continue;
        };
        if json.trim().is_empty() {
            continue;
        }
        upsert_record(conn, id, &json)?;
        imported += 1;
    }
    Ok(imported)
}

/// Slugify a record id into a single safe segment: keep `[A-Za-z0-9_-]`, replace every other char with
/// `_`, and reject an id with no real content (so it can never escape the store, exactly as the old
/// filename guard did). Same output as `platform/fsx.rs::safe_dir_segment` for every id carrying an
/// alphanumeric (kept duplicated because that helper lives in the (Tauri) app crate) — this copy is
/// stricter only for degenerate all-punctuation ids, which it rejects instead of collapsing to `_`.
///
/// Idempotent over its own output (a slug of `[A-Za-z0-9_-]` maps to itself), so a legacy filename stem
/// re-slugs to the same key.
fn safe_id(id: &str, noun: &str) -> Result<String, String> {
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // A dot can never survive the mapper above, so the fsx-style post-slug `.`/`..` match would be
    // dead code here; requiring an alphanumeric rejects the same traversal shapes (`..` slugs to `__`)
    // and keeps all-punctuation ids from colliding onto one underscores-only key.
    if !safe.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("{noun} id is empty/invalid"));
    }
    Ok(safe)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_sqlite_util::open_in_memory_db;

    // A per-test unique suffix so parallel tests never share a dir/db.
    fn uniq() -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    // A scratch on-disk store rooted at a fresh temp dir (the db is the sibling `<dir>.db`).
    fn tmp_store() -> (Store, PathBuf) {
        let dir = std::env::temp_dir().join(format!("bsc-json-store-test-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(db_path_for(&dir));
        (Store::new(dir.clone(), "record"), dir)
    }

    // A blank in-memory db with the schema applied — for the SQL-layer tests.
    fn mem() -> Connection {
        let conn = open_in_memory_db().unwrap();
        init_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn record_crud_round_trips_over_an_in_memory_db() {
        let conn = mem();
        assert!(list_records(&conn).is_empty(), "a fresh table ⇒ empty list");
        assert_eq!(get_record(&conn, "demo"), None, "absent ⇒ None");

        let json = r#"{"id":"demo","name":"Demo","sections":[]}"#;
        upsert_record(&conn, "demo", json).unwrap();
        assert_eq!(get_record(&conn, "demo").as_deref(), Some(json), "stored verbatim");
        assert_eq!(list_records(&conn), vec![json.to_string()]);

        // Upsert overwrites by id (one row).
        upsert_record(&conn, "demo", r#"{"id":"demo","name":"v2"}"#).unwrap();
        assert_eq!(get_record(&conn, "demo").as_deref(), Some(r#"{"id":"demo","name":"v2"}"#));
        assert_eq!(record_count(&conn).unwrap(), 1, "same id ⇒ one row");

        remove_record(&conn, "demo").unwrap();
        assert_eq!(get_record(&conn, "demo"), None);
        assert!(list_records(&conn).is_empty());
        // remove is a no-op when absent.
        remove_record(&conn, "demo").unwrap();
    }

    #[test]
    fn list_orders_by_id_and_skips_blank_values() {
        let conn = mem();
        upsert_record(&conn, "b", r#"{"id":"b"}"#).unwrap();
        upsert_record(&conn, "a", r#"{"id":"a"}"#).unwrap();
        upsert_record(&conn, "blank", "   ").unwrap(); // whitespace-only ⇒ skipped
        assert_eq!(
            list_records(&conn),
            vec![r#"{"id":"a"}"#.to_string(), r#"{"id":"b"}"#.to_string()],
            "ordered by id, blank skipped",
        );
    }

    #[test]
    fn store_set_get_list_remove_round_trips_on_disk() {
        let (s, _dir) = tmp_store();
        assert!(s.list().is_empty(), "a fresh store ⇒ empty list");
        assert_eq!(s.get("demo").unwrap(), None, "absent ⇒ None");

        let json = r#"{"id":"demo","name":"Demo"}"#;
        s.set("demo", json).unwrap();
        assert_eq!(s.get("demo").unwrap().as_deref(), Some(json), "stored verbatim");
        assert_eq!(s.list(), vec![json.to_string()]);

        // Upsert by id.
        s.set("demo", r#"{"id":"demo","name":"v2"}"#).unwrap();
        assert_eq!(s.get("demo").unwrap().as_deref(), Some(r#"{"id":"demo","name":"v2"}"#));
        assert_eq!(s.list().len(), 1, "same id ⇒ one row");

        s.remove("demo").unwrap();
        assert_eq!(s.get("demo").unwrap(), None);
        assert!(s.list().is_empty());
        s.remove("demo").unwrap(); // no-op when absent
    }

    #[test]
    fn a_reopened_store_sees_the_same_db() {
        // The db is the sibling `<dir>.db`, so a second handle over the same dir reads prior writes —
        // the round-trip the CLI relies on (`--dir <store.dir()>` reopens the same store).
        let (s, dir) = tmp_store();
        s.set("r", r#"{"id":"r"}"#).unwrap();
        let reopened = Store::new(s.dir(), "record");
        assert_eq!(reopened.get("r").unwrap().as_deref(), Some(r#"{"id":"r"}"#));
        // The backing file is the sibling `<dir>.db`, not a file inside the dir.
        assert_eq!(reopened.db_path(), db_path_for(&dir));
    }

    #[test]
    fn legacy_json_files_import_once_and_are_idempotent() {
        // Write a couple of legacy `<id>.json` files, then import them into a blank db.
        let dir = std::env::temp_dir().join(format!("bsc-json-store-legacy-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("one.json"), r#"{"id":"one","name":"One"}"#).unwrap();
        std::fs::write(dir.join("two.json"), r#"{"id":"two","name":"Two"}"#).unwrap();
        std::fs::write(dir.join("blank.json"), "   ").unwrap(); // whitespace-only ⇒ skipped
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap(); // non-json ⇒ skipped

        let conn = mem();
        let imported = import_legacy_if_empty(&conn, &dir).unwrap();
        assert_eq!(imported, 2, "the two real json files landed; blank + non-json skipped");
        assert_eq!(get_record(&conn, "one").as_deref(), Some(r#"{"id":"one","name":"One"}"#));
        assert_eq!(get_record(&conn, "two").as_deref(), Some(r#"{"id":"two","name":"Two"}"#));

        // Idempotency: a second import over the now-NON-EMPTY db is a no-op (imports nothing, keeps
        // the existing rows even though the legacy files are still on disk).
        remove_record(&conn, "two").unwrap(); // leave one row so the table is non-empty
        let again = import_legacy_if_empty(&conn, &dir).unwrap();
        assert_eq!(again, 0, "a non-empty db ⇒ no re-import");
        assert_eq!(get_record(&conn, "two"), None, "the removed row was NOT resurrected");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_imports_legacy_files_on_first_open_then_latches() {
        // A store whose legacy dir holds `<id>.json` files (and whose db doesn't exist yet) imports
        // them on first touch, then never again (the user_version latch), even after the db is emptied.
        let dir = std::env::temp_dir().join(format!("bsc-json-store-open-import-{}", uniq()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(db_path_for(&dir));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("seed.json"), r#"{"id":"seed","name":"Seed"}"#).unwrap();

        let s = Store::new(dir.clone(), "record");
        assert_eq!(s.get("seed").unwrap().as_deref(), Some(r#"{"id":"seed","name":"Seed"}"#), "imported on first open");

        // Empty the db, then reopen: the latch means the legacy file is NOT re-imported.
        s.remove("seed").unwrap();
        let reopened = Store::new(dir.clone(), "record");
        assert_eq!(reopened.get("seed").unwrap(), None, "latched — no re-import after a later delete");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(db_path_for(&dir));
    }

    #[test]
    fn slug_check_neutralizes_path_traversal() {
        // `..`, slashes, and separators all map to `_`, so the key stays a single safe segment and the
        // legacy path stays inside the store dir.
        let (s, dir) = tmp_store();
        let path = s.file("../../etc/passwd").unwrap();
        assert_eq!(path.parent(), Some(dir.as_path()), "never escapes the store dir");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), "______etc_passwd.json");
    }

    #[test]
    fn slug_check_rejects_empty_id_with_the_stores_noun() {
        let (s, _dir) = tmp_store();
        assert!(s.file("").is_err(), "empty id is rejected");
        assert!(s.get("").is_err(), "get with empty id is rejected");
        assert!(s.set("", "{}").is_err(), "set with empty id is rejected");
        assert!(s.remove("..").is_err(), "remove with an all-punctuation id is rejected");
        // The error carries the store's own noun so each shim reports its record name.
        assert_eq!(safe_id("", "blueprint"), Err("blueprint id is empty/invalid".into()));
        assert_eq!(safe_id("..", "persona"), Err("persona id is empty/invalid".into()));
    }

    #[test]
    fn safe_id_is_idempotent_over_its_own_output() {
        // The legacy import keys by the filename stem (already a slug); re-slugging must be a no-op so
        // the imported key matches a later `get(id)`.
        for id in ["button", "react-ui", "persona_worker", "______etc_passwd"] {
            let once = safe_id(id, "record").unwrap();
            assert_eq!(safe_id(&once, "record").unwrap(), once, "slug of a slug is itself");
        }
    }
}
