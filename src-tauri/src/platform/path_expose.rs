//! Expose the bundled `bsc` binary to EXTERNAL terminals via the user's PATH (#2734).
//!
//! Inside the app, sessions exec the sidecars by an absolute `$BSC_BIN` path (#2001) — no PATH involved.
//! OUTSIDE the app those env vars don't exist, so a bare `bsc` in the user's own terminal won't resolve.
//! This module is the opt-in external-PATH feature: it resolves the dir the bundled `bsc` lives in,
//! reports whether that dir is already on PATH (so the app surfaces a dismissible "configure PATH" banner
//! ONLY when needed), and — on the user's explicit banner action — adds that dir to their PERSISTENT PATH.
//!
//! Editing the user's PATH is an outward, semi-persistent change, so `path_expose_configure` runs ONLY
//! from the consented banner click, is idempotent, and returns exactly what it changed + how to undo it.
//! Windows writes the USER `Path` env (no elevation); Unix appends a marked `export` line to the shell
//! profile. The optional installer checkbox is the remaining slice.
//!
//! The pure PATH builders (`path_contains` / `path_append` / `ps_single_quote` / `profile_block`) are
//! unit-tested; the OS read/write is a thin layer over them.
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

/// `path_var` with `dir` appended (separator-joined) when it isn't already an entry; unchanged when it
/// already is (idempotent) or when `dir` is blank. Pure — the Windows write applies this to the user
/// `Path`, so the "append if absent" rule lives in one tested place. Windows-only (Unix appends a shell
/// profile line instead — see {@link profile_block}).
#[cfg(windows)]
pub(crate) fn path_append(path_var: &str, dir: &str) -> String {
    if dir.trim().is_empty() || path_contains(path_var, dir) {
        return path_var.to_string();
    }
    if path_var.is_empty() {
        return dir.to_string();
    }
    format!("{path_var}{SEP}{dir}")
}

/// Quote `s` as a PowerShell SINGLE-quoted string literal (all literal except `''` = one `'`), so an
/// arbitrary PATH value can't break out of the `SetEnvironmentVariable` argument. Pure.
#[cfg(windows)]
fn ps_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
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

/// The outcome of a consented PATH-configure (#2734), shown back to the user so an outward change to
/// their environment is transparent: whether anything changed, WHERE, and how to undo it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathConfigResult {
    /// A change was written (false = the dir was already present; an idempotent no-op).
    changed: bool,
    /// Where it was written (e.g. "your user PATH" / "~/.zshrc"), for the confirmation UI.
    target: String,
    /// How to undo the change.
    undo: String,
}

/// Add the bundled `bsc` dir to the user's PERSISTENT PATH (#2734) — the CONSENTED write behind the
/// banner's "Configure" action, never called on its own. Idempotent (a second call is a no-op). Windows:
/// the USER `Path` env (no elevation — the user's own env). Unix: an `export` line in the shell profile.
/// Returns what changed for the confirmation UI; errors if the bundled `bsc` can't be located.
#[tauri::command]
pub(crate) fn path_expose_configure() -> Result<PathConfigResult, String> {
    let dir = bin_dir()
        .and_then(|d| d.to_str().map(str::to_string))
        .ok_or("the bundled bsc binary could not be located — there is nothing to add to PATH")?;
    configure_impl(&dir)
}

/// Windows: append `dir` to the USER `Path` via PowerShell `[Environment]::SetEnvironmentVariable`
/// (User scope, no elevation). Reads the current user `Path` first so the write is idempotent.
#[cfg(windows)]
fn configure_impl(dir: &str) -> Result<PathConfigResult, String> {
    use crate::platform::process::run_capture;
    let undo = format!(
        "Remove \"{dir}\" from your user Path: Settings → System → About → Advanced system settings → \
         Environment Variables → (User) Path."
    );
    let cur = run_capture(std::process::Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetEnvironmentVariable('Path','User')",
    ]))
    .unwrap_or_default();
    let cur = cur.trim().to_string();
    if path_contains(&cur, dir) {
        return Ok(PathConfigResult { changed: false, target: "your user PATH".into(), undo });
    }
    let script = format!(
        "[Environment]::SetEnvironmentVariable('Path', {}, 'User')",
        ps_single_quote(&path_append(&cur, dir)),
    );
    run_capture(std::process::Command::new("powershell").args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script.as_str(),
    ]))?;
    Ok(PathConfigResult { changed: true, target: "your user PATH".into(), undo })
}

/// The marker bracketing our shell-profile addition, so we add it at most once and the user can find
/// (and remove) exactly what we wrote.
#[cfg(not(windows))]
const UNIX_MARKER: &str = "# base-studio-code (bsc on PATH)";

/// The shell-profile block we append on Unix — a marker line + the `export`. Pure.
#[cfg(not(windows))]
fn profile_block(dir: &str) -> String {
    format!("\n{UNIX_MARKER}\nexport PATH=\"$PATH:{dir}\"\n")
}

/// The shell profile to append to — `~/.zshrc` / `~/.bashrc` by `$SHELL`, else `~/.profile`.
#[cfg(not(windows))]
fn unix_profile_path() -> PathBuf {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    let shell = std::env::var("SHELL").unwrap_or_default();
    let file = if shell.contains("zsh") {
        ".zshrc"
    } else if shell.contains("bash") {
        ".bashrc"
    } else {
        ".profile"
    };
    home.join(file)
}

/// Unix: append a marked `export PATH` line to the shell profile. Idempotent — skips if the marker or
/// the dir is already present.
#[cfg(not(windows))]
fn configure_impl(dir: &str) -> Result<PathConfigResult, String> {
    let profile = unix_profile_path();
    let target = profile.display().to_string();
    let undo = format!("Delete the two lines under '{UNIX_MARKER}' in {target}, then reopen your terminal.");
    let existing = std::fs::read_to_string(&profile).unwrap_or_default();
    if existing.contains(UNIX_MARKER) || existing.contains(dir) {
        return Ok(PathConfigResult { changed: false, target, undo });
    }
    std::fs::write(&profile, format!("{existing}{}", profile_block(dir)))
        .map_err(|e| e.to_string())?;
    Ok(PathConfigResult { changed: true, target, undo })
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

    #[cfg(windows)]
    #[test]
    fn path_append_is_idempotent_and_separator_joined() {
        let pv = format!(r"C:\a{SEP}C:\bsc");
        assert_eq!(path_append(&pv, r"C:\bsc"), pv); // present (case/slash-insensitive) → unchanged
        assert_eq!(path_append(&pv, r"c:/BSC/"), pv); // ...even spelled differently
        assert_eq!(path_append(&pv, r"C:\new"), format!(r"{pv}{SEP}C:\new")); // absent → appended
        assert_eq!(path_append("", r"C:\bsc"), r"C:\bsc"); // empty base → just the dir
        assert_eq!(path_append(&pv, ""), pv); // blank dir → unchanged
    }

    #[cfg(windows)]
    #[test]
    fn ps_single_quote_escapes_embedded_quotes() {
        assert_eq!(ps_single_quote(r"C:\a;C:\b"), r"'C:\a;C:\b'");
        assert_eq!(ps_single_quote("it's"), "'it''s'"); // a lone ' becomes '' inside the literal
    }

    #[cfg(not(windows))]
    #[test]
    fn profile_block_carries_the_marker_and_export() {
        let b = profile_block("/opt/bsc");
        assert!(b.contains(UNIX_MARKER));
        assert!(b.contains("export PATH=\"$PATH:/opt/bsc\""));
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

    #[test]
    fn config_result_serializes_the_transparency_fields() {
        let json = serde_json::to_string(&PathConfigResult {
            changed: true,
            target: "your user PATH".into(),
            undo: "remove it".into(),
        })
        .unwrap();
        assert!(json.contains("\"changed\"") && json.contains("\"target\"") && json.contains("\"undo\""));
    }
}
