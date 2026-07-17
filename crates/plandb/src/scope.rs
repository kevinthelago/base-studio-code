//! Per-stream access scoping for `bsc plan` (#3279, epic #3277 — local-first).
//!
//! ## Why
//! When GitHub goes optional and plan.db is the durable issue store, the access boundary that GitHub
//! provided implicitly (a worker's `gh` was scoped by repo + assignment) is gone. Without a replacement,
//! a worker session — which gets `$BSC_PLAN_DB` pointing at the WHOLE project store — can `bsc plan list`
//! (no filter) and read + `status` every stream's issues. This module is that replacement.
//!
//! ## The boundary
//! A WORKER pane launches with `$BSC_STREAM=<its stream id>`; director / planner / triage panes get NO
//! `$BSC_STREAM` (they coordinate across streams). When set:
//! - **reads** ([`resolve_read_stream`]) auto-scope to that stream; an explicit `--stream other` is denied
//! - **single-issue access** ([`check_access`]) — `get`/`status`/`remove` — is denied for an out-of-stream
//!   (or unowned) issue, with a message naming the owner
//! - **writes** ([`resolve_write_stream`]) — `add` — force the stream; adding to another stream is denied
//!
//! ## Trust boundary (be honest about it)
//! This is env-based, exactly like the rest of the runtime `bsc` CLI surface (`$BSC_PLAN_DB`, …). A
//! well-behaved agent, by default, sees only its own work — preventing ACCIDENTAL cross-stream edits and
//! scoping context. It is NOT a defense against a hostile agent that `unset BSC_STREAM`s its own shell;
//! that adversary is the OS-sandbox layer's job (#1988 WSL isolation), not this one.
//!
//! ## Purity
//! Every rule is a pure function of `(env_stream, …)` so it is unit-testable without mutating the process
//! environment (which is global + unsafe to touch in parallel tests). [`env_stream`] is the one thin
//! wrapper that reads the real env; handlers call it and pass the value in.

/// Read `$BSC_STREAM` — the current session's owning stream, or `None` for an unrestricted
/// (director / planner / triage) session. Empty / whitespace ⇒ `None`.
pub fn env_stream() -> Option<String> {
    match std::env::var("BSC_STREAM") {
        Ok(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

/// The worker's open issues, rendered as a compact system-prompt block — or `None` when there's nothing
/// to inject (no `$BSC_PLAN_DB`, no `$BSC_STREAM`, or no open issues). Best-effort: any read failure
/// yields `None`, never an error, so it can never abort an agent turn.
///
/// This replaces the todo-checklist injection removed in #3278 (`bsc_todo::render_active_from_env`) —
/// `bsc-agent` folds it into each turn's system prompt so a weak model stays on its OWN plan across
/// context compaction. It reuses the same `$BSC_STREAM` boundary the CLI enforces, so a worker only
/// ever sees its own issues here.
pub fn render_assigned_from_env() -> Option<String> {
    let db = std::env::var("BSC_PLAN_DB").ok().filter(|p| !p.trim().is_empty())?;
    let stream = env_stream()?;
    let store = crate::Store::open(std::path::Path::new(db.trim())).ok()?;
    let open = store.list_summary(Some("open"), Some(&stream), None, None).ok()?;
    render_assigned(&stream, &open)
}

/// Pure renderer for [`render_assigned_from_env`] — `None` when there are no open issues (so an empty
/// block is never folded into the prompt). Kept separate so it is unit-testable without a DB.
fn render_assigned(stream: &str, open: &[crate::IssueSummary]) -> Option<String> {
    if open.is_empty() {
        return None;
    }
    let mut out = format!("# Your open issues (stream '{stream}') — work only these\n");
    for i in open {
        out.push_str(&format!("- [{}] {}  {}\n", i.status, i.r#ref, i.title));
    }
    Some(out)
}

/// Resolve the effective stream filter for a plural read (`list` / `mine` / `summary`).
///
/// - unrestricted (`env = None`) → the caller's `requested` filter passes through unchanged
/// - restricted, no explicit filter → scope to the session's stream
/// - restricted, explicit filter == own stream → fine
/// - restricted, explicit filter for ANOTHER stream → **denied** (not silently widened to your own —
///   a caller asking for someone else's work should be told no, not quietly handed their own)
pub fn resolve_read_stream(env: Option<&str>, requested: Option<&str>) -> Result<Option<String>, String> {
    match (env, requested) {
        (None, req) => Ok(req.map(str::to_string)),
        (Some(own), None) => Ok(Some(own.to_string())),
        (Some(own), Some(req)) if req == own => Ok(Some(own.to_string())),
        (Some(own), Some(req)) => Err(deny_read(own, req)),
    }
}

/// Guard single-issue access (`get` / `status` / `remove`) after the issue's own stream is known.
///
/// A restricted session may touch ONLY issues in its own stream. An UNOWNED issue (`stream = None`) is
/// also denied — a stream-less issue is the director's to assign, not a worker's to grab.
pub fn check_access(env: Option<&str>, issue_ref: &str, issue_stream: Option<&str>) -> Result<(), String> {
    match env {
        None => Ok(()),
        Some(own) => match issue_stream {
            Some(s) if s == own => Ok(()),
            Some(other) => Err(deny_issue(issue_ref, own, Some(other))),
            None => Err(deny_issue(issue_ref, own, None)),
        },
    }
}

/// Resolve the stream to stamp on an ISSUE being written (`add`).
///
/// - unrestricted → whatever the caller set (may be `None`)
/// - restricted, issue has no stream → force the session's stream (a worker's added issue is its own)
/// - restricted, issue already names the own stream → fine
/// - restricted, issue names ANOTHER stream → **denied**
pub fn resolve_write_stream(env: Option<&str>, issue_ref: &str, issue_stream: Option<&str>) -> Result<Option<String>, String> {
    match (env, issue_stream) {
        (None, s) => Ok(s.map(str::to_string)),
        (Some(own), None) => Ok(Some(own.to_string())),
        (Some(own), Some(s)) if s == own => Ok(Some(own.to_string())),
        (Some(own), Some(other)) => Err(deny_write(issue_ref, own, other)),
    }
}

// ── Denial messages ─────────────────────────────────────────────────────────────────────────────
// A denial must be UNMISTAKABLE — never an empty result that reads as "no such issue" — and name the
// owner so the caller understands the boundary rather than guessing. It does NOT leak the other issue's
// contents; only the stream ownership, which the plan already makes public.

fn deny_read(own: &str, requested: &str) -> String {
    format!("scoped to stream '{own}': you can't read stream '{requested}' — drop --stream to see your own issues")
}

fn deny_issue(issue_ref: &str, own: &str, owner: Option<&str>) -> String {
    match owner {
        Some(o) => format!("scoped to stream '{own}': issue '{issue_ref}' belongs to stream '{o}', not yours"),
        None => format!("scoped to stream '{own}': issue '{issue_ref}' has no stream — it isn't yours to work (the director assigns it)"),
    }
}

fn deny_write(issue_ref: &str, own: &str, requested: &str) -> String {
    format!("scoped to stream '{own}': you can't add issue '{issue_ref}' to stream '{requested}'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unrestricted_passes_everything_through() {
        // Director / planner / triage: no $BSC_STREAM ⇒ byte-identical to today.
        assert_eq!(resolve_read_stream(None, None).unwrap(), None);
        assert_eq!(resolve_read_stream(None, Some("auth")).unwrap(), Some("auth".into()));
        assert!(check_access(None, "F1", Some("auth")).is_ok());
        assert!(check_access(None, "F1", None).is_ok());
        assert_eq!(resolve_write_stream(None, "F1", Some("auth")).unwrap(), Some("auth".into()));
        assert_eq!(resolve_write_stream(None, "F1", None).unwrap(), None);
    }

    #[test]
    fn a_restricted_read_scopes_to_its_own_stream() {
        assert_eq!(resolve_read_stream(Some("ui"), None).unwrap(), Some("ui".into()));
        assert_eq!(resolve_read_stream(Some("ui"), Some("ui")).unwrap(), Some("ui".into()));
    }

    #[test]
    fn a_restricted_read_of_another_stream_is_denied_not_widened() {
        // The critical property: asking for someone else's work is refused, NOT silently handed your own
        // (which would let a caller believe it saw the other stream).
        let err = resolve_read_stream(Some("ui"), Some("auth")).unwrap_err();
        assert!(err.contains("stream 'ui'") && err.contains("stream 'auth'"), "{err}");
    }

    #[test]
    fn single_issue_access_is_own_stream_only() {
        assert!(check_access(Some("ui"), "F1", Some("ui")).is_ok());
        let e1 = check_access(Some("ui"), "F7", Some("auth")).unwrap_err();
        assert!(e1.contains("'F7'") && e1.contains("'auth'"), "names the ref + owner: {e1}");
        // An unowned issue is denied too — not a worker's to grab.
        let e2 = check_access(Some("ui"), "F9", None).unwrap_err();
        assert!(e2.contains("no stream"), "{e2}");
    }

    #[test]
    fn a_restricted_add_forces_its_own_stream() {
        assert_eq!(resolve_write_stream(Some("ui"), "F1", None).unwrap(), Some("ui".into()));
        assert_eq!(resolve_write_stream(Some("ui"), "F1", Some("ui")).unwrap(), Some("ui".into()));
    }

    #[test]
    fn a_restricted_add_to_another_stream_is_denied() {
        let err = resolve_write_stream(Some("ui"), "F1", Some("auth")).unwrap_err();
        assert!(err.contains("'F1'") && err.contains("'auth'"), "{err}");
    }

    #[test]
    fn render_assigned_lists_open_issues_or_nothing() {
        use crate::IssueSummary;
        let none: Vec<IssueSummary> = vec![];
        assert!(render_assigned("ui", &none).is_none(), "no open issues ⇒ no block folded into the prompt");

        let open = vec![IssueSummary {
            r#ref: "F1".into(),
            title: "UI work".into(),
            status: "open".into(),
            stream: Some("ui".into()),
            phase: None,
            acceptance: 0,
            owns: 0,
            depends_on: 0,
        }];
        let block = render_assigned("ui", &open).unwrap();
        assert!(block.contains("stream 'ui'") && block.contains("F1") && block.contains("UI work"), "{block}");
    }

    #[test]
    fn a_denial_is_never_silent() {
        // Every denied path returns Err with a reason — never Ok(empty), which would read as
        // "no such issue" and hide the boundary.
        assert!(resolve_read_stream(Some("ui"), Some("x")).is_err());
        assert!(check_access(Some("ui"), "r", Some("x")).is_err());
        assert!(check_access(Some("ui"), "r", None).is_err());
        assert!(resolve_write_stream(Some("ui"), "r", Some("x")).is_err());
    }
}
