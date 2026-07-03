//! The `bsc errors` subcommand (#2260) — the agent-facing CLI over a project's error.db. Runtime
//! producers (the slice-2 collector, or an agent that hit a fault while testing) `record` faults; the
//! director/maintenance loop (#2265) reads `list --unresolved --since` and `resolve`s a fixed fault.
//!
//! The DB is located via `--db <path>` or `$BSC_ERROR_DB` (set per-session at launch, cwd-derived like
//! `$BSC_PLAN_DB`, so the CLI resolves the hub's error.db even from a worker's worktree). Reads are lean
//! (a compact TSV) by default; `--json`/`--pretty` for machine-readable JSON.
//!
//! Help is per-command (#1762): `bsc errors help` (menu) · `bsc errors <cmd> help` (one command).

use crate::{Fault, FaultInput, Filter, Store};
use bsc_cli_util::CmdDoc;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the project runtime-fault store — fingerprinted errors + alerts (#2258)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "add",
        summary: "record a fault occurrence; prints its fingerprint",
        usage: "\
USAGE:
  bsc errors add <level> <title> [--stage S] [--stack -] [--source X] [--release R]

Records one runtime fault. <level> is one of: warn | error | fatal. Upserts by a stable fingerprint
(a repeat bumps the count, keeps the highest level, and re-opens a resolved fault). `--stack -` reads
the stack/detail from stdin (used for the fingerprint + kept as the sample). --stage defaults to
`runtime` (the only stage with a producer today). Prints the fingerprint id.",
    },
    CmdDoc {
        name: "list",
        summary: "the fault table (lean TSV; newest-seen first)",
        usage: "\
USAGE:
  bsc errors list [--stage S] [--unresolved] [--since EPOCH] [--limit N] [--json|--pretty]

The fault table, newest-seen first. Lean TSV by default (fingerprint, level, stage, count, last_seen,
resolved?, title); --json emits the full rows. Filters:
  --unresolved     only faults not yet resolved
  --stage S        only one lifecycle stage (runtime | test | build | …)
  --since EPOCH    only faults with last_seen >= EPOCH (the resume-delta the fix loop polls with)
  --limit N        cap to N rows",
    },
    CmdDoc {
        name: "tail",
        summary: "the most-recently-seen faults (list, limited)",
        usage: "\
USAGE:
  bsc errors tail [--limit N] [--unresolved] [--json|--pretty]

The most-recently-seen faults — `list` ordered by last_seen with a small default limit (20).",
    },
    CmdDoc {
        name: "get",
        summary: "one fault's full record",
        usage: "\
USAGE:
  bsc errors get <fingerprint> [--json|--pretty]

One fault's full record — the sample stack/source/release the lean list omits.",
    },
    CmdDoc {
        name: "resolve",
        summary: "mark a fault resolved by fingerprint",
        usage: "\
USAGE:
  bsc errors resolve <fingerprint>

Stamps the fault resolved (drops it from `list --unresolved`). A no-op (reported) for an unknown or
already-resolved fingerprint. A later recurrence re-opens it.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    stage: Option<String>,
    stack: Option<String>,
    source: Option<String>,
    release: Option<String>,
    unresolved: bool,
    since: Option<i64>,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        pretty: false,
        db: None,
        stage: None,
        stack: None,
        source: None,
        release: None,
        unresolved: false,
        since: None,
        limit: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        // A value-flag reads the next token; a missing value is an error.
        let mut val = |flag: &str| -> Result<String, String> {
            it.next().ok_or_else(|| format!("flag {flag} needs a value"))
        };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--unresolved" => a.unresolved = true,
            "--db" => a.db = Some(val("--db")?),
            "--stage" => a.stage = Some(val("--stage")?),
            "--stack" => a.stack = Some(val("--stack")?),
            "--source" => a.source = Some(val("--source")?),
            "--release" => a.release = Some(val("--release")?),
            "--since" => a.since = Some(val("--since")?.parse().map_err(|_| "--since needs an integer epoch")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `errors` subcommand entrypoint: `args` is everything after `bsc errors`; `prog` is the display
/// name for help/errors. Help is resolved before any handler opens the DB.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "add" => cmd_add(&args),
        "list" => cmd_list(&args, &args.filter()),
        "tail" => cmd_list(&args, &Filter { limit: Some(args.limit.unwrap_or(20)), unresolved: args.unresolved, ..Default::default() }),
        "get" => cmd_get(&args),
        "resolve" => cmd_resolve(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

impl Args {
    fn filter(&self) -> Filter {
        Filter { stage: self.stage.clone(), unresolved: self.unresolved, since: self.since, limit: self.limit }
    }
}

/// `add <level> <title>` — record one fault occurrence; prints the fingerprint.
fn cmd_add(args: &Args) -> Result<(), String> {
    let level = args.positional.get(1).ok_or("usage: bsc errors add <level> <title>")?;
    let title = args.positional.get(2).ok_or("usage: bsc errors add <level> <title>")?;
    if !crate::is_valid_level(level) {
        return Err(format!("invalid level '{level}' (one of: {})", crate::LEVELS.join(" | ")));
    }
    if let Some(stage) = &args.stage {
        if !crate::is_valid_stage(stage) {
            return Err(format!("invalid stage '{stage}' (one of: {})", crate::STAGES.join(" | ")));
        }
    }
    // `--stack -` reads the stack/detail from stdin; a literal value is taken verbatim.
    let stack = match args.stack.as_deref() {
        Some("-") => Some(read_stdin()?),
        Some(s) => Some(s.to_string()),
        None => None,
    };
    let input = FaultInput {
        stage: args.stage.clone().unwrap_or_default(),
        level: level.clone(),
        title: title.clone(),
        stack,
        source_hint: args.source.clone(),
        release: args.release.clone(),
        context: None,
        ts: now_ms(),
    };
    let fault = open_store(&args.db)?.record(&input).map_err(|e| format!("recording fault: {e}"))?;
    println!("{}", fault.fingerprint);
    Ok(())
}

/// `list` / `tail` — the fault table under `filter`.
fn cmd_list(args: &Args, filter: &Filter) -> Result<(), String> {
    let faults = open_store(&args.db)?.list(filter).map_err(|e| format!("listing faults: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &faults, || {
        if faults.is_empty() {
            "(no faults)".to_string()
        } else {
            faults.iter().map(fault_line).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

/// `get <fingerprint>` — one fault's full record.
fn cmd_get(args: &Args) -> Result<(), String> {
    let fp = args.positional.get(1).ok_or("usage: bsc errors get <fingerprint>")?;
    let fault = open_store(&args.db)?
        .get(fp)
        .map_err(|e| format!("reading fault: {e}"))?
        .ok_or_else(|| format!("no fault {fp}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &fault, || fault_block(&fault));
    Ok(())
}

/// `resolve <fingerprint>` — mark a fault resolved.
fn cmd_resolve(args: &Args) -> Result<(), String> {
    let fp = args.positional.get(1).ok_or("usage: bsc errors resolve <fingerprint>")?;
    let matched = open_store(&args.db)?.resolve(fp, now_ms()).map_err(|e| format!("resolving fault: {e}"))?;
    println!("{}", if matched { format!("resolved {fp}") } else { format!("no unresolved fault {fp}") });
    Ok(())
}

/// One lean TSV row: fingerprint, level, stage, count, last_seen, resolved?, title.
fn fault_line(f: &Fault) -> String {
    format!(
        "{}\t{}\t{}\t{}x\t{}\t{}\t{}",
        f.fingerprint,
        f.level,
        f.stage,
        f.count,
        f.last_seen,
        if f.resolved_at.is_some() { "resolved" } else { "open" },
        f.title,
    )
}

/// The full one-fault block for `get` (human form).
fn fault_block(f: &Fault) -> String {
    let mut s = format!(
        "{}  [{}/{}]  x{}  {}\n{}",
        f.fingerprint,
        f.level,
        f.stage,
        f.count,
        if f.resolved_at.is_some() { "resolved" } else { "open" },
        f.title,
    );
    if let Some(src) = &f.source_hint {
        s.push_str(&format!("\nsource: {src}"));
    }
    if let Some(rel) = &f.release {
        s.push_str(&format!("\nrelease: {rel}"));
    }
    if let Some(stack) = &f.sample_stack {
        s.push_str(&format!("\n\n{stack}"));
    }
    s
}

/// Open the project's error.db (resolved from `--db` / `$BSC_ERROR_DB`). Opened lazily so a pure error
/// path (bad usage, unknown sub) never touches the disk.
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the error.db path via `--db` → `$BSC_ERROR_DB` → (no default → hard error), like plan.db.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_ERROR_DB", || {
        Err("no error.db: pass --db <path> or set BSC_ERROR_DB".to_string())
    })
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("reading stdin: {e}"))?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(vec![
            "list".into(),
            "--unresolved".into(),
            "--stage".into(),
            "runtime".into(),
            "--since".into(),
            "500".into(),
            "--json".into(),
        ])
        .unwrap();
        assert!(a.unresolved && a.json);
        assert_eq!(a.stage.as_deref(), Some("runtime"));
        assert_eq!(a.since, Some(500));
        assert_eq!(a.positional, vec!["list"]);
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_value() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--since".into()]).is_err(), "value-flag with no value");
        assert!(parse_args(vec!["--since".into(), "abc".into()]).is_err(), "non-integer epoch");
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn help_overview_and_per_command_help() {
        let ov = bsc_cli_util::help_overview("bsc errors", TAGLINE, COMMANDS);
        for name in ["add", "list", "tail", "get", "resolve"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        let add = bsc_cli_util::help_for("bsc errors", TAGLINE, COMMANDS, "add");
        assert!(add.contains("bsc errors add"));
        assert!(add.contains("--stack -"));
        // A single command's detail shows only that command.
        let one = bsc_cli_util::help_for("bsc errors", TAGLINE, COMMANDS, "resolve");
        assert!(one.contains("bsc errors resolve") && !one.contains("--stack"));
    }

    #[test]
    fn end_to_end_add_list_get_resolve_over_a_temp_db() {
        // Drive the CLI through $BSC_ERROR_DB against a temp file (the same resolution a session uses).
        let dir = std::env::temp_dir().join(format!("errordb-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("error.db");
        let _ = std::fs::remove_file(&path);
        // Seed two faults via the lib (the CLI's now_ms would be nondeterministic).
        {
            let s = Store::open(&path).unwrap();
            s.record(&FaultInput { level: "error".into(), title: "boom".into(), ts: 10, ..Default::default() }).unwrap();
            s.record(&FaultInput { level: "warn".into(), title: "meh".into(), ts: 20, ..Default::default() }).unwrap();
        }
        std::env::set_var("BSC_ERROR_DB", &path);
        // list --unresolved --json returns both, newest-first.
        let faults = open_store(&None).unwrap().list(&Filter { unresolved: true, ..Default::default() }).unwrap();
        assert_eq!(faults.len(), 2);
        assert_eq!(faults[0].title, "meh");
        // resolve one, then --unresolved returns one.
        let fp = faults[1].fingerprint.clone();
        assert!(open_store(&None).unwrap().resolve(&fp, 99).unwrap());
        assert_eq!(open_store(&None).unwrap().list(&Filter { unresolved: true, ..Default::default() }).unwrap().len(), 1);
        std::env::remove_var("BSC_ERROR_DB");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
