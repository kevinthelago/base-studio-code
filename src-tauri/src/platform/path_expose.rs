//! Expose the bundled `bsc` binary to EXTERNAL terminals via the user's PATH (#2734).
//!
//! Inside the app, sessions exec the sidecars by an absolute `$BSC_BIN` path (#2001) — no PATH involved.
//! OUTSIDE the app those env vars don't exist, so a bare `bsc` in the user's own terminal won't resolve.
//! This module is the DETECTION half of the opt-in external-PATH feature: it resolves the dir the bundled
//! `bsc` lives in and reports whether that dir is already on PATH, so the app can surface a dismissible
//! "configure PATH" banner ONLY when it's needed.
//!
//! The consented WRITE (Windows user-env / Unix shell-profile append) + the banner + the optional
//! installer step are the following slices. Editing the user's PATH is an outward, semi-persistent change,
//! so it never happens here without an explicit user action — this slice is read-only.
//!
//! The PATH-string comparison (`path_contains`) is pure + unit-tested; the OS PATH read is a thin layer
//! over it. The write slice will add the idempotent `path_append` counterpart next to its OS writer.
use serde::Serialize;
use std::path::{Path, PathBuf};

/// The platform PATH separator (`;` on Windows, `:` elsewhere).
#[cfg(windows)]
const SEP: char = ';';
#[cfg(not(windows))]
const SEP: char = ':';

/// The directory the bundled `bsc` lives in — the dir a user would add to PATH to run `bsc` from their
/// own terminal. `None` when the sidecar can't be resolved (an incomplete build, #2001). Reuses the ONE
/// sidecar resolver (`pty::bsc_bin_path`, #2001) so it tracks the same bundle location the sessions use —
/// including across updates, since it re-resolves from the running exe each call.
pub(crate) fn bin_dir() -> Option<PathBuf> {
    crate::console::pty::bsc_bin_path().and_then(|p| p.parent().map(Path::to_path_buf))
}

/// Normalize a PATH entry for comparison: trim, drop a trailing slash. On Windows also lowercase + unify
/// slashes, since Windows paths are case-insensitive and may be `/`- or `\`-separated.
fn norm(entry: &str) -> String {
    let e = entry.trim().trim_end_matches(['/', '\\']).to_string();
    #[cfg(windows)]
    let e = e.to_lowercase().replace('/', "\\");
    e
}

/// Is `dir` already present as an entry in the `PATH`-style string `path_var`? Pure. An empty `dir` is
/// never "present" (so the caller never treats a missing bin dir as configured).
pub(crate) fn path_contains(path_var: &str, dir: &str) -> bool {
    let target = norm(dir);
    !target.is_empty()
        && path_var
            .split(SEP)
            .filter(|e| !e.trim().is_empty())
            .any(|e| norm(e) == target)
}

/// Whether the bundled `bsc` dir is reachable on the CURRENT process PATH — the first-cut detection for
/// the banner (a terminal launched now would resolve `bsc`). The persistent per-user PATH read/write is
/// the following slice. A missing bin dir reports not-configured (nothing to run yet).
fn on_current_path() -> bool {
    let Some(dir) = bin_dir().and_then(|d| d.to_str().map(str::to_string)) else { return false };
    std::env::var("PATH").map(|p| path_contains(&p, &dir)).unwrap_or(false)
}

/// The PATH-exposure status the frontend banner reads (#2734).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathExposeStatus {
    /// `bsc` already resolves on PATH — no banner needed.
    configured: bool,
    /// The dir a user/installer would add to PATH (absolute), shown for transparency; `None` if the
    /// sidecar is missing (nothing to expose).
    bin_dir: Option<String>,
}

/// Report whether the bundled `bsc` is on PATH + the dir that would be added (#2734). Read-only — the
/// consented configure action is a later slice. `#[serde(rename_all = "camelCase")]` because Tauri does
/// NOT camelCase return values (only args), so the frontend reads `configured` + `binDir`.
#[tauri::command]
pub(crate) fn path_expose_status() -> PathExposeStatus {
    PathExposeStatus {
        configured: on_current_path(),
        bin_dir: bin_dir().and_then(|d| d.to_str().map(str::to_string)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_contains_matches_an_entry_ignoring_trailing_sep_and_blanks() {
        let pv = format!("/usr/bin{SEP}/opt/bsc{SEP}");
        assert!(path_contains(&pv, "/opt/bsc"));
        assert!(path_contains(&pv, "/opt/bsc/")); // trailing slash normalized away
        assert!(!path_contains(&pv, "/opt/other"));
        assert!(!path_contains("", "/opt/bsc"));
        assert!(!path_contains(&pv, "")); // an empty dir is never "present"
    }

    #[cfg(windows)]
    #[test]
    fn path_contains_is_case_and_slash_insensitive_on_windows() {
        assert!(path_contains(r"C:\Apps\BSC", "c:/apps/bsc"));
    }

    #[test]
    fn status_serializes_with_camelcase_keys() {
        let json = serde_json::to_string(&PathExposeStatus {
            configured: false,
            bin_dir: Some("/opt/bsc".into()),
        })
        .unwrap();
        assert!(json.contains("\"configured\""));
        assert!(json.contains("\"binDir\""), "return value must be camelCase for the frontend: {json}");
    }
}
