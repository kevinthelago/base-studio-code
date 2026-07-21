//! The core issue-table verbs of `bsc plan` (#1864): `add`/`get`/`summary`/`list`/`mine`/`status`/
//! `remove`/`render`. Split out of `cli.rs` as a pure move — the dispatch in [`super::run`] calls
//! each `cmd_*` here; the shared arg/store/emit plumbing stays in the parent module and the pure
//! renderers live in [`super::render`]. Output is byte-for-byte what `cli.rs` emitted before the split.

use super::{emit_set_result, open_store, Args};
use super::render::{compute_overview, overview_json, render_fields_tsv, render_issue, render_overview_text, render_summary_tsv};
use crate::{is_valid_status, PlanIssue, Store, STATUSES};
use bsc_sqlite_util::{print_json, read_stdin_json};

/// `add` — upsert issues from JSON on stdin, echo the assigned ref(s).
pub(crate) fn cmd_add_cmd(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let refs = cmd_add(&s, args.force)?;
    emit_set_result(args.json, &refs, "");
    Ok(())
}

/// `get <ref>` — one issue's FULL spec (compact `--json` by design; `--pretty` re-indents). An agent
/// escalates here for the detail the lean list omits.
pub(crate) fn cmd_get(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan get <ref>")?;
    let s = open_store(&args.db)?;
    let issue = s.get(r).map_err(|e| e.to_string())?.ok_or_else(|| format!("no issue with ref '{r}'"))?;
    // #3279: a scoped worker may read only its own stream's issues. Denied AFTER the fetch so the
    // message can name the owning stream — a denial that reads as "no such issue" would hide the boundary.
    crate::scope::check_access(crate::scope::env_stream().as_deref(), r, issue.stream.as_deref())?;
    if args.json {
        print_json(&serde_json::to_value(&issue).unwrap_or_default(), args.pretty);
    } else {
        print!("{}", render_issue(&issue));
    }
    Ok(())
}

/// `summary` — the cheapest "where does the plan stand" read: totals + per-status/stream counts.
pub(crate) fn cmd_summary(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    // #3279: a scoped session's summary counts only its own stream's issues.
    let own = crate::scope::env_stream();
    let rows = s.list_summary(None, own.as_deref(), None, None).map_err(|e| e.to_string())?;
    let o = compute_overview(&rows);
    if args.json {
        print_json(&overview_json(&o), args.pretty);
    } else {
        print!("{}", render_overview_text(&o));
    }
    Ok(())
}

/// `list` / `mine` — the issue table. Lean by default (#1562); `--fields` is an explicit TSV
/// projection, `--full` every field (TSV lines or full `--json`).
pub(crate) fn cmd_list(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    // #3279: a scoped worker session ($BSC_STREAM) sees only its own stream; an explicit --stream for
    // another stream is denied, not silently widened. Unscoped (director/planner) → unchanged.
    let own = crate::scope::env_stream();
    let stream = crate::scope::resolve_read_stream(own.as_deref(), args.stream.as_deref())?;
    let (status, stream) = (args.status.as_deref(), stream.as_deref());
    if let Some(fields) = &args.fields {
        // Explicit projection wins over lean/full: fetch the full record, emit only the named
        // columns as TSV (so `body` is reachable when asked for, a typo'd field is a blank column).
        let issues = s.list_filtered(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        print!("{}", render_fields_tsv(&issues, fields));
    } else if args.full {
        let issues = s.list_filtered(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        if args.json {
            print_json(&serde_json::to_value(&issues).unwrap_or_default(), args.pretty);
        } else if issues.is_empty() {
            println!("(no matching issues)");
        } else {
            for issue in &issues {
                println!("{}", render_issue_line(issue));
            }
        }
    } else {
        // Lean by default (#1562): body omitted at the SQL layer, value-lists as counts.
        let rows = s.list_summary(status, stream, args.limit, args.since).map_err(|e| e.to_string())?;
        if args.json {
            print_json(&serde_json::to_value(&rows).unwrap_or_default(), args.pretty);
        } else if rows.is_empty() {
            println!("(no matching issues)");
        } else {
            print!("{}", render_summary_tsv(&rows));
        }
    }
    Ok(())
}

/// `status <ref> <status>` — set an issue's status (validated against {@link STATUSES}).
pub(crate) fn cmd_status(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan status <ref> <status>")?;
    let new = args.positional.get(2).ok_or("usage: bsc plan status <ref> <status>")?;
    if !is_valid_status(new) {
        return Err(format!("unknown status '{new}' (expected one of {STATUSES:?})"));
    }
    let s = open_store(&args.db)?;
    // #3279: fetch first so we know the issue's stream — a scoped worker may only set status on its own.
    let issue = s.get(r).map_err(|e| e.to_string())?.ok_or_else(|| format!("no issue with ref '{r}'"))?;
    crate::scope::check_access(crate::scope::env_stream().as_deref(), r, issue.stream.as_deref())?;
    let n = s.set_status(r, new).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no issue with ref '{r}'"));
    }
    if !args.json {
        println!("{r} → {new}");
    }
    Ok(())
}

/// `remove <ref>` — delete one issue.
pub(crate) fn cmd_remove(args: &Args) -> Result<(), String> {
    let r = args.positional.get(1).ok_or("usage: bsc plan remove <ref>")?;
    let s = open_store(&args.db)?;
    // #3279: a scoped worker may remove only its own stream's issues. A get-first so a missing issue
    // still says "no issue with ref", and an out-of-stream one names the owner rather than silently
    // succeeding (remove is idempotent, so an unscoped remove of a nonexistent ref is a no-op today).
    if let Some(own) = crate::scope::env_stream() {
        let issue = s.get(r).map_err(|e| e.to_string())?.ok_or_else(|| format!("no issue with ref '{r}'"))?;
        crate::scope::check_access(Some(&own), r, issue.stream.as_deref())?;
    }
    s.remove(r).map_err(|e| e.to_string())?;
    if !args.json {
        println!("removed {r}");
    }
    Ok(())
}

/// `render` — print the issues.json projection (full, unchanged) to stdout.
pub(crate) fn cmd_render(args: &Args) -> Result<(), String> {
    // #3279: render is the WHOLE-plan projection by design; a scoped worker has no business dumping
    // every stream. Rather than emit a misleading partial "full projection", deny and point at the
    // scoped read. Unscoped (director/planner/app) → the full projection, unchanged.
    if let Some(own) = crate::scope::env_stream() {
        return Err(format!(
            "scoped to stream '{own}': `render` dumps the whole plan — use `bsc plan list` for your own issues"
        ));
    }
    let s = open_store(&args.db)?;
    println!("{}", s.render_issues_json().map_err(|e| e.to_string())?);
    Ok(())
}

/// Read JSON from stdin (one issue object or an array), upsert each, return the assigned refs.
/// The WHOLE batch is validated before anything is written (#2395) — ref + title + a known status
/// per issue — so a bad item in an array can't leave a half-written batch behind. `force` relaxes
/// the status-enum check only; the ref/title floor always holds (a keyless row is unusable).
fn cmd_add(s: &Store, force: bool) -> Result<Vec<String>, String> {
    let mut issues: Vec<PlanIssue> = read_stdin_json("issue")?;
    // #3279: a scoped worker's added issue is stamped with ITS stream; adding to another stream is
    // denied. Resolved for the WHOLE batch before any write (matches the validate-then-write floor —
    // one out-of-stream item can't leave a half-written batch). Unscoped ⇒ the stream is left as-authored.
    let own = crate::scope::env_stream();
    for issue in &mut issues {
        issue.stream = crate::scope::resolve_write_stream(own.as_deref(), &issue.r#ref, issue.stream.as_deref())?;
    }
    for issue in &issues {
        crate::validate::validate_issue(issue, force)?;
    }
    let mut refs = Vec::new();
    for issue in &issues {
        s.upsert(issue).map_err(|e| e.to_string())?;
        refs.push(issue.r#ref.clone());
    }
    Ok(refs)
}

/// A one-line list entry: `F3  [in_progress]  Add login   (auth)`.
fn render_issue_line(i: &PlanIssue) -> String {
    let stream = i.stream.as_deref().map(|s| format!("   ({s})")).unwrap_or_default();
    format!("{:<8} [{}]  {}{}", i.r#ref, i.status, i.title, stream)
}
