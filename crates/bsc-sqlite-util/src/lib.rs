//! Shared helpers for the SQLite CLI+lib trio (#1621). `plandb`, `skilldb`, and `logs` (plus their
//! `bsc-plan` / `bsc-skill` / `bsc-logs` binaries) each grew the same tiny utilities; this crate is
//! their single home so the copies don't drift:
//!
//! - [`arr_to_json`] / [`json_to_arr`] — persist a `Vec<String>` as a JSON-TEXT column (and back).
//! - [`home_dir`] — cross-platform home directory from the standard env vars (no `dirs` dependency).
//! - [`print_json`] — print any `Serialize` value to stdout, compact by default / indented with `--pretty`.
//! - [`read_stdin_json`] — read stdin as JSON, accepting either one object or an array, into a `Vec<T>`.
//!
//! Tauri-free and dependency-light (just `serde` / `serde_json`) so the small CLIs stay small.

use serde::de::DeserializeOwned;
use std::io::Read;
use std::path::PathBuf;

/// Serialize a string list to a JSON array TEXT value for a SQLite column. Infallible in practice
/// (a `Vec<String>` always serializes) — falls back to `"[]"` rather than erroring.
pub fn arr_to_json(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".into())
}

/// Parse a JSON array TEXT column back into a string list. A malformed/empty value yields `[]`.
pub fn json_to_arr(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

/// The user's home directory, from the platform's standard env var (`HOME`, else `USERPROFILE` on
/// Windows). `None` when neither is set (or is empty) — callers fall back to an explicit `--db`/dir.
pub fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
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

/// The object-or-array dispatch behind [`read_stdin_json`], split out so it's testable without
/// driving real stdin. Trims `buf`; empty input is an error; a leading `[` parses as `Vec<T>`,
/// otherwise as a single `T` wrapped in a one-element vec.
fn parse_json_items<T: DeserializeOwned>(buf: &str, noun: &str) -> Result<Vec<T>, String> {
    let buf = buf.trim();
    if buf.is_empty() {
        return Err(format!("expected a {noun} (or array of {noun}s) as JSON on stdin"));
    }
    if buf.starts_with('[') {
        serde_json::from_str(buf).map_err(|e| format!("parsing {noun} array: {e}"))
    } else {
        let one: T = serde_json::from_str(buf).map_err(|e| format!("parsing {noun}: {e}"))?;
        Ok(vec![one])
    }
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
    fn home_dir_reads_the_standard_env_vars() {
        // Can't mutate process env safely under parallel tests; just assert the contract holds for
        // whichever var the runner sets (CI/dev always sets one of HOME / USERPROFILE).
        let expected = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .filter(|p| !p.is_empty());
        assert_eq!(home_dir().is_some(), expected.is_some());
    }

    #[test]
    fn parse_json_items_handles_object_array_empty_and_malformed() {
        // The stdin read can't be exercised in a unit test, but the object-or-array dispatch is the
        // crux — `parse_json_items` is the shared core `read_stdin_json` delegates to.
        let one: Vec<i64> = parse_json_items("42", "n").unwrap();
        assert_eq!(one, vec![42]);
        let many: Vec<i64> = parse_json_items("[1, 2, 3]", "n").unwrap();
        assert_eq!(many, vec![1, 2, 3]);
        assert!(parse_json_items::<i64>("   ", "n").unwrap_err().contains("expected a n"));
        assert!(parse_json_items::<i64>("nope", "n").unwrap_err().contains("parsing n"));
        assert!(parse_json_items::<i64>("[nope", "n").unwrap_err().contains("parsing n array"));
    }
}
