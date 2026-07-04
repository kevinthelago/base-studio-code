//! The `bsc todo` subcommand (#1872) — the session-facing CLI over the two-scope agent todo store.
//! `--scope feature` (the default) reaches the project's `plan.db` (via `$BSC_PLAN_DB`); `--scope
//! global` reaches the shared workflow-runbook store at `~/.base-studio-code/todos.db` (via
//! `$BSC_TODO_DB`). Dispatched by the unified `bsc` umbrella (#1877).
//!
//! Output is JSON to stdout (like `bsc plan` / `bsc skill`) — compact by default, indented with
//! `--pretty`. Help is per-command so a model loads only what it needs (#1762):
//!   bsc todo help          # compact menu
//!   bsc todo <cmd> help    # detailed help for ONE command

use crate::{GlobalStore, Todo};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::print_json;
use std::path::PathBuf;

const TAGLINE: &str =
    "the two-scope agent todo store — the feature checklist (plan.db) + the global workflow runbook (#1872)";

/// The command catalog — drives the shared help system. One detailed `usage` block per command keeps
/// the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "add",
        summary: "append a step to the active list; prints its id",
        usage: "\
USAGE:
  bsc todo add <text…> [--scope feature|global] [--feature <ref>] [--pretty]

Appends one step (all trailing words are the text, so quoting is optional). Idempotent: re-adding the
same text in the same list is a no-op that returns the existing id. Feature scope keys the step to
--feature (or $BSC_TODO_FEATURE, else the project-general list); global scope has no feature key.",
    },
    CmdDoc {
        name: "list",
        summary: "list the todos (JSON), optionally only open ones",
        usage: "\
USAGE:
  bsc todo list [--scope feature|global] [--feature <ref>] [--open] [--pretty]

Lists todos in stable order. --open restricts to unchecked (pending) items. Feature scope: --feature
filters to one issue's list; omit it for every feature. Each row is { id, scope, feature, text,
status, position, … }.",
    },
    CmdDoc {
        name: "next",
        summary: "the next OPEN step, or null when the list is done",
        usage: "\
USAGE:
  bsc todo next [--scope feature|global] [--feature <ref>] [--pretty]

Prints the first unchecked step (the one to work now), or null when nothing is open.",
    },
    CmdDoc {
        name: "done",
        summary: "check a step off by id",
        usage: "\
USAGE:
  bsc todo done <id> [--scope feature|global] [--pretty]

Marks the step with <id> done, dropping it from the open set + `next`. Errors on an unknown id.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a step by id (no-op if absent)",
        usage: "\
USAGE:
  bsc todo remove <id> [--scope feature|global] [--pretty]

Permanently deletes the step keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "seed-feature",
        summary: "materialize a feature list from an issue's acceptance + owns",
        usage: "\
USAGE:
  bsc todo seed-feature <ref> [--pretty]

Feature scope only. Reads the plan.db issue <ref> and creates one pending step per acceptance
criterion (in order), plus one trailing step naming the files the issue owns. Idempotent (re-seeding
de-dupes). Prints the ids. Requires $BSC_PLAN_DB (a project session).",
    },
];

/// Parsed global flags + leftover positional args (verb + operands).
struct Args {
    db: Option<String>,
    /// `feature` (default) | `global` — which store the verb operates on.
    scope: String,
    /// `--feature <ref>`: the feature key (feature scope only).
    feature: Option<String>,
    /// `--open`: restrict `list` to unchecked items.
    open: bool,
    /// Indent the JSON output; `--json` is an accepted no-op (output is always JSON).
    pretty: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        db: None,
        scope: "feature".into(),
        feature: None,
        open: false,
        pretty: false,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--scope" => a.scope = it.next().ok_or("--scope needs feature|global")?,
            "--feature" => a.feature = Some(it.next().ok_or("--feature needs a ref")?),
            "--open" => a.open = true,
            "--pretty" => a.pretty = true,
            "--json" => {}
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The feature key an `add` writes under: `--feature` → `$BSC_TODO_FEATURE` → `""` (project-general).
fn feature_key(a: &Args) -> String {
    a.feature
        .clone()
        .or_else(|| std::env::var("BSC_TODO_FEATURE").ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
        .unwrap_or_default()
}

/// The `todo` subcommand entrypoint: `args` is everything after `bsc todo`; `prog` is the display
/// name for help/errors.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help, before opening any store (help works without a db).
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    if !matches!(args.scope.as_str(), "feature" | "global") {
        return Err(bad_scope(&args.scope));
    }

    match cmd.as_str() {
        "add" => cmd_add(&args),
        "list" => cmd_list(&args),
        "next" => cmd_next(&args),
        "done" => cmd_done(&args),
        "remove" => cmd_remove(&args),
        "seed-feature" => cmd_seed_feature(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn bad_scope(scope: &str) -> String {
    format!("unknown --scope '{scope}' (expected feature|global)")
}

/// Open the feature-scope store (plan.db, resolved from `--db` / `$BSC_PLAN_DB` — no default: a
/// feature list is meaningless without a project).
fn open_feature(a: &Args) -> Result<plandb::Store, String> {
    let path = bsc_cli_util::resolve_store_path(&a.db, "BSC_PLAN_DB", || {
        Err("no plan.db in this session — run in a project (or pass --db <path> / set BSC_PLAN_DB)".to_string())
    })?;
    plandb::Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Open the global-scope store (todos.db, resolved from `--db` / `$BSC_TODO_DB` / the default
/// `~/.base-studio-code/todos.db`).
fn open_global(a: &Args) -> Result<GlobalStore, String> {
    let path = resolve_global_db(&a.db)?;
    GlobalStore::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

fn resolve_global_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, crate::TODO_DB_ENV, || {
        crate::default_global_db_path()
            .ok_or_else(|| "could not resolve a home directory; pass --db <path> or set BSC_TODO_DB".to_string())
    })
}

fn cmd_add(a: &Args) -> Result<(), String> {
    // All trailing words after the verb are the step text (quoting optional for weak models).
    let text = a.positional[1..].join(" ");
    if text.trim().is_empty() {
        return Err("usage: bsc todo add <text…> [--scope feature|global] [--feature <ref>]".into());
    }
    let id = match a.scope.as_str() {
        "global" => open_global(a)?.add(&text).map_err(|e| e.to_string())?,
        _ => open_feature(a)?.todo_add(&feature_key(a), &text).map_err(|e| e.to_string())?,
    };
    print_json(&id, a.pretty);
    Ok(())
}

fn cmd_list(a: &Args) -> Result<(), String> {
    let items: Vec<Todo> = match a.scope.as_str() {
        "global" => open_global(a)?.list(a.open).map_err(|e| e.to_string())?,
        _ => open_feature(a)?.todo_list(a.feature.as_deref(), a.open).map_err(|e| e.to_string())?,
    };
    print_json(&items, a.pretty);
    Ok(())
}

fn cmd_next(a: &Args) -> Result<(), String> {
    let nx: Option<Todo> = match a.scope.as_str() {
        "global" => open_global(a)?.next().map_err(|e| e.to_string())?,
        _ => open_feature(a)?.todo_next(a.feature.as_deref()).map_err(|e| e.to_string())?,
    };
    print_json(&nx, a.pretty);
    Ok(())
}

fn cmd_done(a: &Args) -> Result<(), String> {
    let id = a.positional.get(1).ok_or("usage: bsc todo done <id>")?;
    let changed = match a.scope.as_str() {
        "global" => open_global(a)?.done(id).map_err(|e| e.to_string())?,
        _ => open_feature(a)?.todo_done(id).map_err(|e| e.to_string())?,
    };
    if changed == 0 {
        return Err(format!("no todo with id '{id}'"));
    }
    print_json(id, a.pretty);
    Ok(())
}

fn cmd_remove(a: &Args) -> Result<(), String> {
    let id = a.positional.get(1).ok_or("usage: bsc todo remove <id>")?;
    match a.scope.as_str() {
        "global" => open_global(a)?.remove(id).map_err(|e| e.to_string())?,
        _ => open_feature(a)?.todo_remove(id).map_err(|e| e.to_string())?,
    };
    print_json(id, a.pretty);
    Ok(())
}

fn cmd_seed_feature(a: &Args) -> Result<(), String> {
    if a.scope == "global" {
        return Err("seed-feature is a feature-scope command (it reads a plan.db issue)".into());
    }
    let r#ref = a.positional.get(1).ok_or("usage: bsc todo seed-feature <ref>")?;
    let ids = open_feature(a)?.todo_seed_feature(r#ref).map_err(|e| e.to_string())?;
    print_json(&ids, a.pretty);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_defaults_to_feature_and_flag_overrides() {
        assert_eq!(parse_args(vec!["list".into()]).unwrap().scope, "feature", "default scope is feature");
        let a = parse_args(vec!["list".into(), "--scope".into(), "global".into()]).unwrap();
        assert_eq!(a.scope, "global");
        // --feature / --open / --pretty parse.
        let a = parse_args(vec![
            "list".into(),
            "--feature".into(),
            "F1".into(),
            "--open".into(),
            "--pretty".into(),
        ])
        .unwrap();
        assert_eq!(a.feature.as_deref(), Some("F1"));
        assert!(a.open && a.pretty);
        // `add` keeps all trailing words as positional (the text is joined in cmd_add).
        let a = parse_args(vec!["add".into(), "write".into(), "the".into(), "ddl".into()]).unwrap();
        assert_eq!(a.positional, vec!["add", "write", "the", "ddl"]);
    }

    #[test]
    fn unknown_flag_and_help_routing() {
        // An unknown flag errors.
        assert!(parse_args(vec!["list".into(), "--bogus".into()]).is_err());
        // -h / --help fold to a leading `help` token that handle_help claims.
        let a = parse_args(vec!["list".into(), "--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
        assert!(bsc_cli_util::handle_help("bsc todo", TAGLINE, COMMANDS, &a.positional));
    }

    #[test]
    fn help_overview_lists_every_verb_and_unknown_command_shows_the_menu() {
        let ov = bsc_cli_util::help_overview("bsc todo", TAGLINE, COMMANDS);
        for c in ["add", "list", "next", "done", "remove", "seed-feature"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // seed-feature's detail explains the feature-scope requirement.
        assert!(bsc_cli_util::help_for("bsc todo", TAGLINE, COMMANDS, "seed-feature").contains("acceptance"));
        // An unknown command names it and appends the overview.
        let msg = bsc_cli_util::unknown_command("bsc todo", TAGLINE, COMMANDS, "frobnicate");
        assert!(msg.starts_with("unknown command 'frobnicate'"));
        assert!(msg.contains("COMMANDS:"));
    }

    #[test]
    fn bad_scope_is_rejected_by_run() {
        // A bogus --scope is a clear error (not silently treated as feature).
        let err = run(vec!["list".into(), "--scope".into(), "sideways".into()], "bsc todo").unwrap_err();
        assert!(err.contains("unknown --scope 'sideways'"));
    }
}
