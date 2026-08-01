//! Shared helpers for the SQLite CLI+lib trio (#1621). `plandb`, `skilldb`, and `logs` (plus their
//! `bsc-plan` / `bsc-skill` / `bsc-logs` binaries) each grew the same tiny utilities; this crate is
//! their single home so the copies don't drift:
//!
//! - [`arr_to_json`] / [`json_to_arr`] — persist a `Vec<String>` as a JSON-TEXT column (and back).
//! - [`home_dir`] — re-exported from [`bsc_util`] (#1646), the single source of truth for home-dir
//!   resolution shared by the desktop app and every `bsc-*` CLI.
//! - [`print_json`] — print any `Serialize` value to stdout, compact by default / indented with `--pretty`.
//! - [`read_stdin_json`] — read stdin as JSON, accepting either one object or an array, into a `Vec<T>`.
//! - [`read_stdin_json_one`] — read stdin as a single JSON object into one `T` (the singleton-blob `set` shape).
//!
//! Tauri-free and dependency-light (`serde` / `serde_json` + the leaf `bsc-util`) so the small CLIs stay small.

/// Home-directory resolution, re-exported from the leaf `bsc-util` crate (#1646) so there is exactly
/// ONE implementation (with the app's `USERPROFILE`-first-on-Windows precedence). Existing
/// `bsc_sqlite_util::home_dir` callers keep compiling against this re-export.
pub use bsc_util::home_dir;

use serde::de::DeserializeOwned;
use std::io::Read;

/// Serialize a string list to a JSON array TEXT value for a SQLite column. Infallible in practice
/// (a `Vec<String>` always serializes) — falls back to `"[]"` rather than erroring.
pub fn arr_to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// Parse a JSON array TEXT column back into a string list. A malformed/empty value yields `[]`.
pub fn json_to_arr(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

/// Print a `Serialize` value to stdout as JSON — compact by default (the agent-facing reads are
/// token-budget-sensitive, so an embedded read shouldn't cost an extra newline+indent per field),
/// or indented when `pretty` is set (for human inspection). A serialization failure prints an empty
/// line rather than erroring.
pub fn print_json<T: serde::Serialize>(value: &T, pretty: bool) {
    let s = if pretty {
        serde_json::to_string_pretty(value).unwrap_or_default()
    } else {
        serde_json::to_string(value).unwrap_or_default()
    };
    // #4152: through the shared emitter so a warm serve loop can capture it; identical to `println!`
    // when nothing is capturing, which is what keeps the served and one-shot outputs byte-equal.
    bsc_util::emit_line(&s);
}

/// Read JSON from stdin as a list of `T`, accepting **either** a single object **or** an array (the
/// shape every `bsc-* add`/`set`-style command takes). `noun` names the item for error messages
/// (e.g. `"issue"`, `"feature"`, `"skill"`).
///
/// # Errors
/// - the stdin read fails,
/// - the input is empty/whitespace,
/// - the JSON doesn't parse into `T` (or `Vec<T>` when it starts with `[`).
pub fn read_stdin_json<T: DeserializeOwned>(noun: &str) -> Result<Vec<T>, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    parse_json_items(&buf, noun)
}

/// Read JSON from stdin as exactly one `T` — the shape every singleton-blob `set`-style command takes
/// (`deploy`/`deps`/`blueprint`/`fleet set`, `bsc-data` connector writes). `noun` names the value for
/// error messages (e.g. `"deploy JSON"`, `"blueprint JSON"`).
///
/// Shares [`parse_json_items`]' trim/empty guard, but parses a single object (no array form).
///
/// # Errors
/// - the stdin read fails,
/// - the input is empty/whitespace,
/// - the JSON doesn't parse into `T`.
pub fn read_stdin_json_one<T: DeserializeOwned>(noun: &str) -> Result<T, String> {
    let mut buf = String::new();
    std::io::stdin().read_to_string(&mut buf).map_err(|e| format!("reading stdin: {e}"))?;
    parse_json_one(&buf, noun)
}

/// Trim `buf` and reject empty/whitespace input — the shared guard both stdin readers run before
/// parsing. `shape` is appended after `noun` in the error: `""` for a lone object, the array hint for
/// the object-or-array reader.
fn trim_or_empty_err<'a>(buf: &'a str, noun: &str, shape: &str) -> Result<&'a str, String> {
    let buf = buf.trim();
    if buf.is_empty() {
        return Err(format!("expected {noun}{shape} as JSON on stdin"));
    }
    Ok(buf)
}

/// The object-or-array dispatch behind [`read_stdin_json`], split out so it's testable without
/// driving real stdin. Trims `buf`; empty input is an error; a leading `[` parses as `Vec<T>`,
/// otherwise as a single `T` wrapped in a one-element vec.
pub fn parse_json_items<T: DeserializeOwned>(buf: &str, noun: &str) -> Result<Vec<T>, String> {
    let buf = trim_or_empty_err(buf, noun, &format!(" (or array of {noun}s)"))?;
    if buf.starts_with('[') {
        serde_json::from_str(buf).map_err(|e| format!("parsing {noun} array: {e}"))
    } else {
        let one: T = serde_json::from_str(buf).map_err(|e| format!("parsing {noun}: {e}"))?;
        Ok(vec![one])
    }
}

/// The single-object parse behind [`read_stdin_json_one`], split out so it's testable without driving
/// real stdin. Trims `buf`; empty input is an error; parses one `T` (an array is a parse error, not a
/// vec — this reader is the singleton-blob shape).
fn parse_json_one<T: DeserializeOwned>(buf: &str, noun: &str) -> Result<T, String> {
    let buf = trim_or_empty_err(buf, noun, "")?;
    serde_json::from_str(buf).map_err(|e| format!("parsing {noun}: {e}"))
}

// ── connection plumbing (feature = "conn") ────────────────────────────────────────────────────────
// The open/PRAGMA/row helpers the SQLite STORES (plandb / skilldb / compliance / research) shared by
// copy-paste (#1863). SCHEMAS STAY PER-CRATE (each store runs its own `migrate`/`init` after open) —
// only the plumbing lives here. Gated behind `conn` so rusqlite isn't forced on the JSON-only
// consumers.
#[cfg(feature = "conn")]
mod conn {
    use rusqlite::Connection;
    use serde::de::DeserializeOwned;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    /// The shared busy_timeout (ms) for a store the desktop app AND a `bsc-*` CLI open concurrently
    /// (#1621): a quick CLI write must not lose to the app's poll with `SQLITE_BUSY`. Paired with WAL
    /// (each store enables WAL in its own `migrate`). 5s — the value plandb + skilldb both used.
    pub const BUSY_TIMEOUT_MS: u32 = 5_000;

    /// Open (creating parent dirs, best-effort) an ON-DISK SQLite db at `path` with the shared
    /// app↔CLI [`BUSY_TIMEOUT_MS`] busy_timeout — the plandb/skilldb open path. The caller then runs
    /// its own `migrate` (which enables WAL + creates the schema). `rusqlite::Result` so the stores
    /// keep their existing error shape.
    pub fn open_db(path: &Path) -> rusqlite::Result<Connection> {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS as u64))?;
        Ok(conn)
    }

    /// Open an EPHEMERAL in-memory SQLite db with the same [`BUSY_TIMEOUT_MS`] busy_timeout — the
    /// `open_in_memory` test path of the WAL+busy_timeout stores (WAL is moot in-memory).
    pub fn open_in_memory_db() -> rusqlite::Result<Connection> {
        let conn = Connection::open_in_memory()?;
        conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS as u64))?;
        Ok(conn)
    }

    /// Open a SQLite db at `path`, honoring the `":memory:"` sentinel (an on-disk path gets its
    /// parent dirs created first), mapping every failure to `String` — the compliance/research store
    /// open path. `noun` labels the errors EXACTLY as those stores did: `"<noun> dir: …"` for the
    /// dir-create failure, `"open <noun>: …"` for the open. The caller runs its own schema `init`.
    pub fn open_db_str(path: &Path, noun: &str) -> Result<Connection, String> {
        if path.as_os_str() != ":memory:" {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("{noun} dir: {e}"))?;
            }
        }
        Connection::open(path).map_err(|e| format!("open {noun}: {e}"))
    }

    /// The default on-disk path for a store: the trimmed `env` override when non-empty, else
    /// `~/.base-studio-code/<segments…>`. Home is `$HOME` then `$USERPROFILE` (the compliance/research
    /// precedence; `None` if neither is set). The shared body behind each store's `default_path`.
    pub fn default_store_path(env: &str, segments: &[&str]) -> Option<PathBuf> {
        if let Ok(p) = std::env::var(env) {
            let p = p.trim();
            if !p.is_empty() {
                return Some(PathBuf::from(p));
            }
        }
        let home = std::env::var("HOME").ok().or_else(|| std::env::var("USERPROFILE").ok())?;
        let mut path = PathBuf::from(home).join(".base-studio-code");
        for s in segments {
            path = path.join(s);
        }
        Some(path)
    }

    /// Fetch a single JSON-TEXT column value by id and deserialize it into `T`, or `None` on a miss
    /// or a parse failure (the lenient blob read the compliance/research stores do). `sql` must
    /// select one TEXT column and bind `id` as its only `?1` parameter.
    pub fn get_json<T: DeserializeOwned>(conn: &Connection, sql: &str, id: &str) -> Option<T> {
        let json: String = conn.query_row(sql, [id], |r| r.get(0)).ok()?;
        serde_json::from_str(&json).ok()
    }

    /// Run `sql` (binding `params`) over a single JSON-TEXT column and collect each value that
    /// deserializes into `T`, skipping any that error — the lenient list read (an odd-shaped row
    /// never aborts the listing). Mirrors compliance's `query` helper.
    pub fn list_json<T: DeserializeOwned>(
        conn: &Connection,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> Vec<T> {
        let mut out = Vec::new();
        if let Ok(mut stmt) = conn.prepare(sql) {
            if let Ok(rows) = stmt.query_map(params, |r| r.get::<_, String>(0)) {
                for json in rows.flatten() {
                    if let Ok(v) = serde_json::from_str::<T>(&json) {
                        out.push(v);
                    }
                }
            }
        }
        out
    }
}

#[cfg(feature = "conn")]
pub use conn::{
    default_store_path, get_json, list_json, open_db, open_db_str, open_in_memory_db, BUSY_TIMEOUT_MS,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arr_json_round_trips() {
        let v = vec!["a".to_string(), "b c".to_string()];
        assert_eq!(arr_to_json(&v), "[\"a\",\"b c\"]");
        assert_eq!(json_to_arr(&arr_to_json(&v)), v);
    }

    #[test]
    fn json_to_arr_is_lenient() {
        assert!(json_to_arr("not json").is_empty());
        assert!(json_to_arr("").is_empty());
        assert_eq!(json_to_arr("[\"x\"]"), vec!["x".to_string()]);
    }

    #[test]
    fn parse_json_items_handles_object_array_empty_and_malformed() {
        // The stdin read can't be exercised in a unit test, but the object-or-array dispatch is the
        // crux — `parse_json_items` is the shared core `read_stdin_json` delegates to.
        let one: Vec<i64> = parse_json_items("42", "n").unwrap();
        assert_eq!(one, vec![42]);
        let many: Vec<i64> = parse_json_items("[1, 2, 3]", "n").unwrap();
        assert_eq!(many, vec![1, 2, 3]);
        assert!(parse_json_items::<i64>("   ", "n").unwrap_err().contains("expected n"));
        assert!(parse_json_items::<i64>("nope", "n").unwrap_err().contains("parsing n"));
        assert!(parse_json_items::<i64>("[nope", "n").unwrap_err().contains("parsing n array"));
    }

    #[test]
    fn parse_json_one_reads_a_single_object_empty_and_malformed() {
        // The stdin read can't be exercised in a unit test; `parse_json_one` is the shared core
        // `read_stdin_json_one` delegates to (the single-object analogue of `parse_json_items`).
        let one: i64 = parse_json_one("42", "deploy JSON").unwrap();
        assert_eq!(one, 42);
        // A nested object round-trips as one T.
        let obj: serde_json::Value = parse_json_one("{\"a\":1}", "deploy JSON").unwrap();
        assert_eq!(obj, serde_json::json!({ "a": 1 }));
        // Empty/whitespace shares the trim guard — noun in the error, no array hint.
        let empty = parse_json_one::<serde_json::Value>("  \n ", "deploy JSON").unwrap_err();
        assert!(empty.contains("expected deploy JSON"));
        assert!(!empty.contains("array"));
        // Malformed JSON names the noun.
        assert!(parse_json_one::<serde_json::Value>("nope", "deploy JSON").unwrap_err().contains("parsing deploy JSON"));
    }
}

#[cfg(all(test, feature = "conn"))]
mod conn_tests {
    use super::*;

    #[test]
    fn open_in_memory_db_sets_the_shared_busy_timeout() {
        let conn = open_in_memory_db().unwrap();
        let timeout: i64 = conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(timeout, BUSY_TIMEOUT_MS as i64);
    }

    #[test]
    fn open_db_creates_parent_dirs_and_sets_busy_timeout() {
        // An on-disk path under a not-yet-existing dir: open_db must mkdir -p the parent, open, and
        // set the busy_timeout (the plandb/skilldb app↔CLI share contract).
        let dir = std::env::temp_dir().join(format!("bsc-sqlite-util-open-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("nested").join("t.db");
        let conn = open_db(&path).unwrap();
        let timeout: i64 = conn.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap();
        assert_eq!(timeout, BUSY_TIMEOUT_MS as i64);
        // WAL is on for an on-disk db (after the caller's migrate would set it — but the file + dirs
        // already exist here, proving the parent-dir creation).
        assert!(path.exists());
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn open_db_str_honors_the_memory_sentinel_and_labels_errors_by_noun() {
        // `:memory:` opens without touching the filesystem.
        let conn = open_db_str(std::path::Path::new(":memory:"), "store").unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, json TEXT NOT NULL)").unwrap();
        // A dir-create failure is labelled "<noun> dir: …": point at a path whose parent is an
        // existing FILE, so create_dir_all must fail.
        let file = std::env::temp_dir().join(format!("bsc-sqlite-util-file-{}", std::process::id()));
        std::fs::write(&file, b"x").unwrap();
        let under_file = file.join("sub").join("t.db");
        let err = open_db_str(&under_file, "cache").unwrap_err();
        assert!(err.starts_with("cache dir:"), "got: {err}");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn default_store_path_prefers_trimmed_env_then_falls_back_to_home() {
        let env = "BSC_SQLITE_UTIL_TEST_STORE";
        // A non-empty (trimmed) env override wins verbatim.
        std::env::set_var(env, "  /tmp/over.db  ");
        assert_eq!(default_store_path(env, &["x", "y.db"]), Some(std::path::PathBuf::from("/tmp/over.db")));
        // An empty/whitespace env falls through to ~/.base-studio-code/<segments…>.
        std::env::set_var(env, "   ");
        std::env::set_var("HOME", "/home/me");
        let got = default_store_path(env, &["compliance", "store.db"]).unwrap();
        assert!(got.ends_with(std::path::Path::new(".base-studio-code/compliance/store.db")), "got: {got:?}");
        std::env::remove_var(env);
    }

    #[test]
    fn get_json_and_list_json_round_trip_and_are_lenient() {
        let conn = open_in_memory_db().unwrap();
        conn.execute_batch(
            "CREATE TABLE rows (id TEXT PRIMARY KEY, json TEXT NOT NULL, ord INTEGER);
             INSERT INTO rows VALUES ('a', '{\"n\":1}', 1);
             INSERT INTO rows VALUES ('b', 'not json', 2);
             INSERT INTO rows VALUES ('c', '{\"n\":3}', 3);",
        )
        .unwrap();
        // get_json: a hit parses, a miss / unparseable value is None.
        let hit: Option<serde_json::Value> = get_json(&conn, "SELECT json FROM rows WHERE id = ?1", "a");
        assert_eq!(hit, Some(serde_json::json!({ "n": 1 })));
        assert_eq!(get_json::<serde_json::Value>(&conn, "SELECT json FROM rows WHERE id = ?1", "missing"), None);
        assert_eq!(get_json::<serde_json::Value>(&conn, "SELECT json FROM rows WHERE id = ?1", "b"), None);
        // list_json: collects the deserializable rows in query order, silently skipping the bad one.
        let all: Vec<serde_json::Value> =
            list_json(&conn, "SELECT json FROM rows ORDER BY ord", rusqlite::params![]);
        assert_eq!(all, vec![serde_json::json!({ "n": 1 }), serde_json::json!({ "n": 3 })]);
    }
}
