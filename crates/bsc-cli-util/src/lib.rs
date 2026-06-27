//! Shared CLI scaffold for the `bsc-*` state CLIs (#1762). The seven binaries
//! (`bsc-plan` / `bsc-data` / `bsc-skill` / `bsc-compliance` / `bsc-logs` / `bsc-blueprint` /
//! `bsc-project`) all copy-pasted the same three tiny pieces of scaffolding; this crate is their
//! single home so the copies don't drift:
//!
//! - [`cli_main`] — the byte-identical `main() -> ExitCode` wrapper (`Ok ⇒ SUCCESS`, `Err(e) ⇒ print
//!   `<prog>: <e>` to stderr + `FAILURE`). Each bin's `main()` becomes one line, and the program name
//!   in the error is passed once (fixing the "wrong binary name in the error" footgun).
//! - [`resolve_store_path`] — the `--flag` → `$ENV` → default precedence every store-backed CLI
//!   repeats. The env value is trimmed and an empty/whitespace value falls through to the default.
//! - [`emit`] — the lean-text-vs-JSON output dispatch (`--pretty` ⇒ indented JSON, `--json` ⇒ compact
//!   JSON, neither ⇒ the caller's lean/TSV rendering).
//!
//! Deliberately **NOT** in `bsc-sqlite-util`: `bsc-data` is DuckDB and `bsc-project` is plain fs, so
//! the scaffold can't live in a SQLite-named crate. Tauri-free and dependency-light (`serde` /
//! `serde_json`) so the small CLIs stay small.

use serde::Serialize;
use std::path::PathBuf;
use std::process::ExitCode;

/// The byte-identical `main` of every `bsc-*` CLI: run `run`, mapping `Ok(())` to
/// [`ExitCode::SUCCESS`] and `Err(e)` to `<prog>: <e>` on stderr + [`ExitCode::FAILURE`]. `prog` is
/// the binary name printed in the error — passed once here rather than re-typed in each bin's
/// `eprintln!` (which is how they drifted out of sync with their actual binary name).
///
/// ```ignore
/// fn main() -> std::process::ExitCode {
///     bsc_cli_util::cli_main("bsc-plan", run)
/// }
/// ```
pub fn cli_main(prog: &str, run: impl FnOnce() -> Result<(), String>) -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{prog}: {e}");
            ExitCode::FAILURE
        }
    }
}

/// Resolve a store path by the shared `--flag` → `$ENV` → `default` precedence:
///
/// 1. an explicit `flag` (e.g. `--db <path>`) wins, taken verbatim;
/// 2. else the `env` var, **trimmed** — an empty/whitespace value is treated as unset;
/// 3. else the caller's `default` (a hard `Err` for the CLIs with no default location — `bsc-plan`
///    / `bsc-data` — or a computed path like `~/.base-studio-code/skills.db` for the ones that have
///    one).
///
/// Trimming the env value + falling through on empty unifies a split the bins had: `bsc-blueprint`
/// already treated an empty env as unset, `bsc-compliance` trimmed it, and the others used it
/// verbatim. The flag is never trimmed (an explicit path is taken as given).
///
/// # Errors
/// Whatever `default` returns when neither the flag nor the env var supplies a path.
pub fn resolve_store_path(
    flag: &Option<String>,
    env: &str,
    default: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var(env) {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    default()
}

/// Print `value` per the output flags, falling back to the caller's lean text. The shared
/// **`--pretty` ⇒ JSON** rule (#1762): `--pretty` always forces indented JSON, `--json` selects
/// compact JSON, and with neither the caller's `lean` rendering (a human line / TSV table) is
/// printed. So `--pretty` implies JSON output — the `bsc-data` / `bsc-logs` semantics, now the one
/// rule for every CLI with a lean text mode. (The JSON-only CLIs without a lean form — `bsc-plan`'s
/// blob reads, `bsc-skill`, `bsc-compliance`, `bsc-blueprint` — use `bsc_sqlite_util::print_json`
/// directly, where the same precedence holds with no `lean` branch.)
///
/// A serialization failure prints `null` rather than erroring (an embedded read never aborts on it).
pub fn emit<T: Serialize>(pretty: bool, json: bool, value: &T, lean: impl FnOnce() -> String) {
    if pretty {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into()));
    } else if json {
        println!("{}", serde_json::to_string(value).unwrap_or_else(|_| "null".into()));
    } else {
        println!("{}", lean());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_main_maps_ok_and_err_to_exit_codes() {
        // Ok ⇒ SUCCESS; Err ⇒ FAILURE (the stderr line is a side effect we don't capture here).
        assert_eq!(format!("{:?}", cli_main("bsc-x", || Ok(()))), format!("{:?}", ExitCode::SUCCESS));
        assert_eq!(
            format!("{:?}", cli_main("bsc-x", || Err("boom".into()))),
            format!("{:?}", ExitCode::FAILURE)
        );
    }

    #[test]
    fn resolve_store_path_flag_wins_verbatim() {
        // The flag beats both the env var and the default, and is taken as-is (not trimmed).
        std::env::set_var("BSC_CLI_UTIL_TEST_A", "/from/env");
        let got = resolve_store_path(&Some(" /from/flag ".into()), "BSC_CLI_UTIL_TEST_A", || {
            Err("default not reached".into())
        })
        .unwrap();
        assert_eq!(got, PathBuf::from(" /from/flag "));
        std::env::remove_var("BSC_CLI_UTIL_TEST_A");
    }

    #[test]
    fn resolve_store_path_env_is_used_and_trimmed() {
        std::env::set_var("BSC_CLI_UTIL_TEST_B", "  /from/env  ");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_B", || Err("default not reached".into())).unwrap();
        assert_eq!(got, PathBuf::from("/from/env"), "the env value is trimmed");
        std::env::remove_var("BSC_CLI_UTIL_TEST_B");
    }

    #[test]
    fn resolve_store_path_empty_or_whitespace_env_falls_through_to_default() {
        // Both an empty and a whitespace-only env var are treated as unset → the default runs.
        std::env::set_var("BSC_CLI_UTIL_TEST_C", "   ");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_C", || Ok(PathBuf::from("/default"))).unwrap();
        assert_eq!(got, PathBuf::from("/default"));
        std::env::set_var("BSC_CLI_UTIL_TEST_C", "");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_C", || Ok(PathBuf::from("/default"))).unwrap();
        assert_eq!(got, PathBuf::from("/default"));
        std::env::remove_var("BSC_CLI_UTIL_TEST_C");
    }

    #[test]
    fn resolve_store_path_propagates_the_default_error() {
        // With no flag + no env, the default's Err is returned (the bsc-plan / bsc-data shape).
        std::env::remove_var("BSC_CLI_UTIL_TEST_D");
        let err = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_D", || Err("no store".into())).unwrap_err();
        assert_eq!(err, "no store");
    }
}
