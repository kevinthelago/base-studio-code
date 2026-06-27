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
    println!("{s}");
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
fn parse_json_items<T: DeserializeOwned>(buf: &str, noun: &str) -> Result<Vec<T>, String> {
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
