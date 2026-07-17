//! The `bsc request` subcommand (#3295, epic #3260) — the designer→debug channel. A session confined to
//! `bsc ui` files an improvement request when the surface can't do what it needs (with the exact failing
//! command as the grounding); a full-capability debug session reads the open queue and resolves it. Each
//! request is a standalone contract — no conversation transcript is piped anywhere.
//!
//! The db is global (`~/.base-studio-code/requests.db`), located via `--db <path>` or `$BSC_REQUEST_DB`.
//! Reads are lean by default; `--json`/`--pretty` for machine-readable JSON. Help is per-command:
//! `bsc request help` · `bsc request <cmd> help`.

use crate::{Filter, NewRequest, Request, Store};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the improvement-request store — the designer→debug channel (#3295)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "new",
        summary: "file an improvement request; prints its id",
        usage: "\
USAGE:
  bsc request new \"<text>\" [--surface S] [--cmd \"<failing command>\"] [--shot PATH]

Files a request for something the tool surface can't do. Ground it — pass the EXACT command that failed
via --cmd (a request is observed, not narrated). --surface defaults to `bsc ui`. --shot attaches a PNG
(#3261). Prints the new request's id.",
    },
    CmdDoc {
        name: "list",
        summary: "the request queue (lean TSV; newest first)",
        usage: "\
USAGE:
  bsc request list [--open] [--surface S] [--limit N] [--json|--pretty]

The requests, newest first. --open shows only unresolved (the debug session's work queue); --surface
filters by tool. Lean TSV by default; --json emits the full rows (with cmd + note).",
    },
    CmdDoc {
        name: "get",
        summary: "one request's full record",
        usage: "\
USAGE:
  bsc request get <id> [--json|--pretty]

One request's full record — the failing command + the resolve note the lean list omits.",
    },
    CmdDoc {
        name: "resolve",
        summary: "mark a request resolved (the debug session, after fixing it)",
        usage: "\
USAGE:
  bsc request resolve <id> [--note \"<what changed>\"]

Marks the request resolved (drops it from `list --open`), stamping --note with what was fixed. A no-op
(reported) for an unknown or already-resolved id.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    surface: Option<String>,
    cmd: Option<String>,
    shot: Option<String>,
    note: Option<String>,
    open: bool,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        pretty: false,
        db: None,
        surface: None,
        cmd: None,
        shot: None,
        note: None,
        open: false,
        limit: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut val = |flag: &str| -> Result<String, String> { it.next().ok_or_else(|| format!("flag {flag} needs a value")) };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--open" => a.open = true,
            "--db" => a.db = Some(val("--db")?),
            "--surface" => a.surface = Some(val("--surface")?),
            "--cmd" => a.cmd = Some(val("--cmd")?),
            "--shot" => a.shot = Some(val("--shot")?),
            "--note" => a.note = Some(val("--note")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `request` subcommand entrypoint: `args` is everything after `bsc request`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "new" => cmd_new(&args),
        "list" => cmd_list(&args),
        "get" => cmd_get(&args),
        "resolve" => cmd_resolve(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `new "<text>"` — file a request; prints its id.
fn cmd_new(args: &Args) -> Result<(), String> {
    let text = args.positional.get(1).ok_or("usage: bsc request new \"<text>\" [--cmd \"...\"]")?;
    let input = NewRequest {
        text: text.clone(),
        surface: args.surface.clone().unwrap_or_default(),
        cmd: args.cmd.clone(),
        shot_path: args.shot.clone(),
        ts: now_ms(),
    };
    let r = open_store(&args.db)?.create(&input).map_err(|e| format!("filing request: {e}"))?;
    println!("{}", r.id);
    Ok(())
}

/// `list` — the request queue.
fn cmd_list(args: &Args) -> Result<(), String> {
    let filter = Filter { open_only: args.open, surface: args.surface.clone(), limit: args.limit };
    let requests = open_store(&args.db)?.list(&filter).map_err(|e| format!("listing requests: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &requests, || {
        if requests.is_empty() {
            "(no requests)".to_string()
        } else {
            requests.iter().map(request_line).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

/// `get <id>` — one request's full record.
fn cmd_get(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let r = open_store(&args.db)?
        .get(id)
        .map_err(|e| format!("reading request: {e}"))?
        .ok_or_else(|| format!("no request {id}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &r, || request_block(&r));
    Ok(())
}

/// `resolve <id>` — mark a request resolved.
fn cmd_resolve(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let matched =
        open_store(&args.db)?.resolve(id, args.note.as_deref(), now_ms()).map_err(|e| format!("resolving request: {e}"))?;
    println!("{}", if matched { format!("resolved request {id}") } else { format!("no open request {id}") });
    Ok(())
}

/// One lean TSV row: id, status, surface, cmd?, text.
fn request_line(r: &Request) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}",
        r.id,
        r.status,
        r.surface,
        r.cmd.as_deref().unwrap_or("-"),
        r.text,
    )
}

/// The full one-request block for `get` (human form).
fn request_block(r: &Request) -> String {
    let mut s = format!("request {}  [{}]  ({})\n{}", r.id, r.status, r.surface, r.text);
    if let Some(cmd) = &r.cmd {
        s.push_str(&format!("\nfailing command: {cmd}"));
    }
    if let Some(shot) = &r.shot_path {
        s.push_str(&format!("\nshot: {shot}"));
    }
    if let Some(note) = &r.note {
        s.push_str(&format!("\nresolved: {note}"));
    }
    s
}

/// Parse the request id from the first positional after the command word.
fn positional_id(args: &Args) -> Result<i64, String> {
    let raw = args.positional.get(1).ok_or("usage: bsc request <cmd> <id> …")?;
    raw.parse().map_err(|_| format!("request id must be an integer (got '{raw}')"))
}

/// Open the global requests.db (resolved from `--db` / `$BSC_REQUEST_DB` / `~/.base-studio-code/requests.db`).
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the requests.db path: `--db` → `$BSC_REQUEST_DB` → `~/.base-studio-code/requests.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(f) = flag {
        return Ok(PathBuf::from(f));
    }
    bsc_sqlite_util::default_store_path("BSC_REQUEST_DB", &["requests.db"])
        .ok_or_else(|| "cannot locate requests.db (no home directory); pass --db <path>".to_string())
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(vec![
            "new".into(),
            "theme can't reach the scrollbar".into(),
            "--cmd".into(),
            "bsc ui theme set-token default --scrollbar x".into(),
            "--surface".into(),
            "bsc ui".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["new", "theme can't reach the scrollbar"]);
        assert_eq!(a.cmd.as_deref(), Some("bsc ui theme set-token default --scrollbar x"));
        assert_eq!(a.surface.as_deref(), Some("bsc ui"));
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_value() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--cmd".into()]).is_err(), "value-flag with no value");
        assert!(parse_args(vec!["--limit".into(), "abc".into()]).is_err(), "non-integer");
    }

    #[test]
    fn help_overview_and_per_command_help() {
        let ov = bsc_cli_util::help_overview("bsc request", TAGLINE, COMMANDS);
        for name in ["new", "list", "get", "resolve"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        let new = bsc_cli_util::help_for("bsc request", TAGLINE, COMMANDS, "new");
        assert!(new.contains("bsc request new"));
        assert!(new.contains("--cmd"), "documents the grounding flag");
    }

    #[test]
    fn end_to_end_new_list_resolve_over_a_temp_db() {
        let dir = std::env::temp_dir().join(format!("bsc-request-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("BSC_REQUEST_DB", &path);

        cmd_new(&args_for(vec!["new", "gap"], |a| a.cmd = Some("bsc ui foo".into()))).unwrap();
        let store = open_store(&None).unwrap();
        assert_eq!(store.list(&Filter { open_only: true, ..Default::default() }).unwrap().len(), 1);
        cmd_resolve(&args_for(vec!["resolve", "1"], |a| a.note = Some("added foo".into()))).unwrap();
        assert!(open_store(&None).unwrap().list(&Filter { open_only: true, ..Default::default() }).unwrap().is_empty());

        std::env::remove_var("BSC_REQUEST_DB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Build an `Args` for a handler test — the command word + positionals, then a mutator for flags.
    fn args_for(positional: Vec<&str>, set: impl FnOnce(&mut Args)) -> Args {
        let mut a = parse_args(positional.into_iter().map(String::from).collect()).unwrap();
        set(&mut a);
        a
    }
}
