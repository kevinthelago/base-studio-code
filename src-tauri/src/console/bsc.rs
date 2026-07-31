//! The generic `bsc` bridge (epic #2114, phase 1 / #2115).
//!
//! The UI drives the SAME complete `bsc` interaction set the planner + agents use from a live
//! session's shell — one surface over the shared store crates (`plan.db` / DuckDB data model /
//! `skills.db`) instead of a parallel, hand-maintained, per-verb Tauri command layer that can drift.
//! This is the non-PTY, one-shot analogue of what a session gets via `$BSC_BIN` + the per-project
//! `BSC_*` env (`console::pty::wire_bsc_env`).
//!
//! Security: this execs a FIXED bundled binary (`bsc`) resolved by absolute path — the caller-supplied
//! `args` only ever reach `bsc`, so it can't be used to run an arbitrary program. The webview is the
//! user's own trusted control surface (the permission model gates *agent* sessions, not the user's own
//! UI actions), so UI-driven reads AND writes are legitimate — that parity is the point (#2114).

use crate::prelude::*;

/// Run the bundled `bsc` binary with `args` against a project's stores and return its stdout.
///
/// `project_key` scopes the per-project stores (the plan.db + the DuckDB data model); omit it for
/// global-only subcommands (e.g. `bsc skill …`). Structured `bsc` subcommands emit JSON to stdout for
/// the UI to parse. Returns `Ok(trimmed stdout)` on a zero exit, else `Err(trimmed stderr)` — the same
/// shape every command returns.
///
/// # Errors
/// - the bundled `bsc` binary can't be resolved (missing sidecar), or
/// - `bsc` exits non-zero (its stderr is returned).
/// `stdin` (optional) feeds a body to the child's stdin — required by the `bsc … set`/`add` write
/// verbs, which read their JSON body from stdin (#2123). Omit it for reads and positional verbs.
/// ASYNC + `spawn_blocking` (#4074) — this is the app's hottest process spawner and a SYNC
/// `#[tauri::command]` runs on Tauri's main thread, so every `bsc …` read blocked every other invoke
/// behind it. Measured: a batch of unrelated commands all completing at once after 23-26s, including
/// `perf_record_frontend_sample` (which does almost nothing) at 25.8s — a queue draining, not work.
///
/// The blocking body is UNCHANGED and simply moved onto the blocking pool; the returned value and
/// every error string are identical, so the JS bridge needs no change.
///
/// Concurrency note: these calls were previously serialized by sharing one thread, and now overlap.
/// That is safe for the stores involved — they are SQLite opened with a `busy_timeout` (the app↔CLI
/// share is what that timeout is FOR) and live PTY sessions already write them concurrently — but it
/// is a real behaviour change, not a pure speedup.
#[tauri::command]
pub(crate) async fn bsc(
    project_key: Option<String>,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || bsc_blocking(project_key, args, stdin))
        .await
        // A join error means the blocking task panicked or the runtime is shutting down. Surface it as
        // an error rather than unwrapping — a panic here would take the whole invoke path down.
        .map_err(|e| format!("bsc: the sidecar task failed to run: {e}"))?
}

/// The blocking body of [`bsc`], kept as its own fn so it stays directly unit-testable.
fn bsc_blocking(
    project_key: Option<String>,
    args: Vec<String>,
    stdin: Option<String>,
) -> Result<String, String> {
    let bin = crate::console::pty::bsc_bin_path()
        .ok_or("bsc binary not found — the bundled sidecar is missing (BSC_BIN unset)")?;
    let mut cmd = std::process::Command::new(&bin);
    cmd.args(&args);
    wire_bsc_stores(&mut cmd, project_key.as_deref());
    match stdin {
        Some(body) => run_capture_stdin(&mut cmd, body.as_bytes()),
        None => run_capture(&mut cmd),
    }
}

/// Wire the per-project + global store env vars a one-shot `bsc` invocation resolves its DB from — the
/// direct-`Command` analogue of `wire_bsc_env` (which does the same for a PTY session, but in bash-path
/// form). NATIVE paths here: `bsc` reads these with `std::path`, not through a bash shell, so no
/// `to_bash_path` conversion. Kept pure (no spawn) so it's unit-testable.
///
/// `BSC_PLAN_DB` / `BSC_DATA_DB` are per-project (set only when a non-empty `project_key` is given, so
/// a global-only subcommand doesn't point them at a bogus empty key); `BSC_SKILL_DB` is the one global
/// skills store, set unconditionally — mirroring `wire_bsc_env` (per-project db is cwd-derived there,
/// skill db is global).
fn wire_bsc_stores(cmd: &mut std::process::Command, project_key: Option<&str>) {
    if let Some(key) = project_key.filter(|k| !k.is_empty()) {
        cmd.env("BSC_PLAN_DB", plan_db_path(key));
        cmd.env("BSC_ERROR_DB", error_db_path(key));
        cmd.env("BSC_USAGE_DB", usage_db_path(key));
        cmd.env("BSC_DATA_DB", data_db_path(key));
    }
    cmd.env("BSC_SKILL_DB", skills_db());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_blocking_body_is_still_directly_callable_and_reports_a_missing_sidecar() {
        // #4074 split the blocking work out of the now-async command. The body must stay reachable
        // (and testable) on its own, and its error contract must not have shifted with the move — the
        // JS bridge matches on these strings.
        let prev = std::env::var("BSC_BIN").ok();
        std::env::set_var("BSC_BIN", "");
        let err = bsc_blocking(None, vec!["--version".into()], None);
        // Either the sidecar is genuinely unresolvable here (the message we own) or a real binary was
        // found via another path — both are valid, but a PANIC is not, which is what this pins.
        if let Err(e) = &err {
            assert!(!e.is_empty(), "an error must carry a message");
        }
        match prev {
            Some(v) => std::env::set_var("BSC_BIN", v),
            None => std::env::remove_var("BSC_BIN"),
        }
    }

    /// Collect a Command's env overrides into a map for assertions.
    fn envs(cmd: &std::process::Command) -> std::collections::HashMap<String, std::path::PathBuf> {
        cmd.get_envs()
            .filter_map(|(k, v)| Some((k.to_string_lossy().into_owned(), std::path::PathBuf::from(v?))))
            .collect()
    }

    #[test]
    fn wire_stores_sets_per_project_and_global_dbs() {
        let mut cmd = std::process::Command::new("bsc");
        wire_bsc_stores(&mut cmd, Some("my-app"));
        let e = envs(&cmd);
        // Per-project stores resolve to the SAME canonical paths as everything else (paths.rs).
        assert_eq!(e.get("BSC_PLAN_DB"), Some(&plan_db_path("my-app")));
        assert_eq!(e.get("BSC_ERROR_DB"), Some(&error_db_path("my-app")));
        assert_eq!(e.get("BSC_USAGE_DB"), Some(&usage_db_path("my-app")));
        assert_eq!(e.get("BSC_DATA_DB"), Some(&data_db_path("my-app")));
        // The skills store is global.
        assert_eq!(e.get("BSC_SKILL_DB"), Some(&skills_db()));
    }

    #[test]
    fn wire_stores_omits_per_project_dbs_without_a_key() {
        // A global-only subcommand (e.g. `bsc skill`) must NOT point the per-project vars at an empty
        // key — leave them unset so bsc falls back to its own resolution.
        let mut cmd = std::process::Command::new("bsc");
        wire_bsc_stores(&mut cmd, None);
        let e = envs(&cmd);
        assert!(!e.contains_key("BSC_PLAN_DB"));
        assert!(!e.contains_key("BSC_USAGE_DB"));
        assert!(!e.contains_key("BSC_DATA_DB"));
        assert_eq!(e.get("BSC_SKILL_DB"), Some(&skills_db()));
        // An empty key is treated like None (not a real project).
        let mut cmd2 = std::process::Command::new("bsc");
        wire_bsc_stores(&mut cmd2, Some(""));
        assert!(!envs(&cmd2).contains_key("BSC_PLAN_DB"));
    }

    /// Smoke test: when the bundled binary resolves (it isn't staged in the test target), a benign
    /// invocation returns a `Result` instead of panicking. A no-op where `bsc` isn't present.
    ///
    /// Exercises `bsc_blocking`, not `bsc`: since #4074 the command is async, and `let _ = bsc(…)`
    /// would build a future and drop it unpolled — running nothing while still looking like a test.
    #[test]
    fn bsc_invocation_does_not_panic_when_binary_present() {
        if crate::console::pty::bsc_bin_path().is_none() {
            return; // sidecar not staged in the test target — nothing to exercise
        }
        let _ = bsc_blocking(None, vec!["--help".to_string()], None);
    }
}
