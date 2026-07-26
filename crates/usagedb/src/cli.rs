//! The `bsc usage` subcommand (#3812, epic #3809) — the session-facing CLI over the per-project usage
//! store. A running/generated app RECORDS events; an agent READS what users do. The store is located via
//! `--db` → `$BSC_USAGE_DB` → error (per-project, no global default), mirroring `bsc errors`. Output is
//! JSON to stdout (compact; `--pretty` indents).

use crate::{EventInput, Filter, Store};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::print_json;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the project usage-events store — record + query what users do (#3809)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "record",
        summary: "record one usage event",
        usage: "\
USAGE:
  bsc usage record --event <name> [--props <json|->] [--at <ts-ms>]

Records one occurrence of <name> (e.g. `click`, `item_selected`). `--props` is an optional JSON payload
(the event's fields); `-` reads it from stdin. `--at` is an epoch-ms timestamp (default: now). Bumps the
event's aggregate count and appends a capped raw occurrence. Prints the resulting aggregate.",
    },
    CmdDoc {
        name: "summary",
        summary: "per-event counts, most-fired first (the usage scoreboard)",
        usage: "\
USAGE:
  bsc usage summary [--limit <n>]      # alias: top

The aggregate an agent reads to see what users do: one row per event (count · first/last seen · last
props), most-fired first. `--limit` caps the rows.",
    },
    CmdDoc {
        name: "list",
        summary: "recent raw occurrences",
        usage: "\
USAGE:
  bsc usage list [--event <name>] [--since <ts-ms>] [--limit <n>]

Raw occurrences, newest first — filtered to one `--event`, to `--since` a timestamp, and capped by
`--limit`.",
    },
    CmdDoc {
        name: "clear",
        summary: "empty the store",
        usage: "\
USAGE:
  bsc usage clear

Deletes every event + occurrence.",
    },
];

/// Parsed flags + leftover positionals.
struct Args {
    db: Option<String>,
    pretty: bool,
    event: Option<String>,
    props: Option<String>,
    at: Option<i64>,
    since: Option<i64>,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_i64(v: &str, flag: &str) -> Result<i64, String> {
    v.parse::<i64>().map_err(|_| format!("{flag} needs an integer, got '{v}'"))
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { db: None, pretty: false, event: None, props: None, at: None, since: None, limit: None, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => a.db = Some(it.next().ok_or("--db needs a path")?),
            "--pretty" => a.pretty = true,
            "--json" => {} // output is always JSON; accepted so callers can be explicit
            "--event" => a.event = Some(it.next().ok_or("--event needs a name")?),
            "--props" => a.props = Some(it.next().ok_or("--props needs a value (or `-` for stdin)")?),
            "--at" => a.at = Some(parse_i64(&it.next().ok_or("--at needs a timestamp")?, "--at")?),
            "--since" => a.since = Some(parse_i64(&it.next().ok_or("--since needs a timestamp")?, "--since")?),
            "--limit" => a.limit = Some(parse_i64(&it.next().ok_or("--limit needs a number")?, "--limit")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `usage` subcommand entrypoint: `args` is everything after `bsc usage`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    let cmd = args.positional.first().cloned().unwrap_or_default();
    match cmd.as_str() {
        "record" => {
            let event = args.event.clone().ok_or("usage: bsc usage record --event <name> [--props <json|->] [--at <ts>]")?;
            let props = match args.props.as_deref() {
                Some("-") => Some(read_stdin()?),
                Some(p) => Some(p.to_string()),
                None => None,
            };
            if let Some(p) = &props {
                serde_json::from_str::<serde_json::Value>(p).map_err(|e| format!("--props must be JSON: {e}"))?;
            }
            let out = open_store(&args.db)?
                .record(&EventInput { event, props, ts: args.at.unwrap_or_else(now_ms) })
                .map_err(|e| format!("recording event: {e}"))?;
            print_json(&out, args.pretty);
            Ok(())
        }
        "summary" | "top" => {
            let sum = open_store(&args.db)?.summary(args.limit).map_err(|e| format!("summary: {e}"))?;
            print_json(&sum, args.pretty);
            Ok(())
        }
        "list" => {
            let list = open_store(&args.db)?
                .list(&Filter { event: args.event.clone(), since: args.since, limit: args.limit })
                .map_err(|e| format!("list: {e}"))?;
            print_json(&list, args.pretty);
            Ok(())
        }
        "clear" => {
            open_store(&args.db)?.clear().map_err(|e| format!("clear: {e}"))?;
            print_json(&true, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the store path via `--db` → `$BSC_USAGE_DB` → error (per-project only, like `bsc errors`).
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_USAGE_DB", || {
        Err("no usage.db: pass --db <path> or set BSC_USAGE_DB".to_string())
    })
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn read_stdin() -> Result<String, String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| format!("reading stdin: {e}"))?;
    Ok(s.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_reads_flags_and_positionals() {
        let a = parse_args(["record", "--event", "click", "--props", "{}", "--at", "5", "--pretty"].iter().map(|s| s.to_string()).collect()).unwrap();
        assert_eq!(a.positional, vec!["record".to_string()]);
        assert_eq!(a.event.as_deref(), Some("click"));
        assert_eq!(a.props.as_deref(), Some("{}"));
        assert_eq!(a.at, Some(5));
        assert!(a.pretty);
    }

    #[test]
    fn parse_args_rejects_bad_int_and_unknown_flag() {
        assert!(parse_args(vec!["list".into(), "--limit".into(), "nope".into()]).is_err());
        assert!(parse_args(vec!["list".into(), "--bogus".into()]).is_err());
    }

    #[test]
    fn parse_args_routes_help_flag() {
        assert_eq!(parse_args(vec!["--help".into()]).unwrap().positional.first().map(String::as_str), Some("help"));
    }

    #[test]
    fn record_requires_an_event_before_touching_the_store() {
        // No --event → a usage error, no store/db needed.
        let e = run(vec!["record".into()], "bsc usage").unwrap_err();
        assert!(e.contains("--event"), "{e}");
    }

    #[test]
    fn unknown_command_is_refused_with_the_overview() {
        let e = run(vec!["frobnicate".into()], "bsc usage").unwrap_err();
        assert!(e.contains("unknown command 'frobnicate'") && e.contains("COMMANDS:"));
    }

    #[test]
    fn help_overview_lists_the_verbs() {
        let ov = bsc_cli_util::help_overview("bsc usage", TAGLINE, COMMANDS);
        for c in ["record", "summary", "list", "clear"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
    }
}
