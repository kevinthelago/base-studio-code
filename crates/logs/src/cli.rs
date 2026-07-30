//! The `bsc logs` subcommand (#1877) — drill into any console session's logs from its own shell
//! (#1607, #1325).
//!
//! A read-only query over the app's per-session event streams (tools / skills / mcp / hooks /
//! cost / coord / activity / perm) under `~/.base-studio-code/` (`$BSC_LOG_DIR` overrides). Mirrors
//! `bsc plan`'s house style: lean TSV with a header by default, `--json` (compact) / `--pretty`,
//! `--session` / `--stream` / `--since` / `--limit`.
//!
//! Extracted from the old `bsc-logs` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the per-command help (#1762) is unchanged:
//!   bsc logs help            # compact menu (the small "what commands exist" prompt)
//!   bsc logs session help    # detailed help for ONE command
//!   bsc logs <cmd> help      # same, after any command
//! (no-arg `bsc logs` keeps its established default: list every session.)

use std::path::PathBuf;

use crate::{canonical_stream, cost, perf, query, role_of, sessions, LogEvent, SessionRow};
use bsc_cli_util::{emit, CmdDoc};

const TAGLINE: &str = "query a console session's logs — tools/skills/mcp/hooks/cost/coord/activity/perm + perf (read-only, #1607)";

/// The command catalog — drives the shared help system. One detailed `usage` block per command keeps
/// the overview tiny and the detail one-fetch-away. The event-category verbs (audit|skill|…) share
/// one `<stream>` entry since they dispatch identically.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "sessions",
        summary: "every console session, one line each (the default)",
        usage: "\
USAGE:
  bsc logs sessions [--json|--pretty]

One row per console session: role, per-stream event counts, cost, and last activity. This is also
the no-argument default.",
    },
    CmdDoc {
        name: "session",
        summary: "one session's full, time-merged story",
        usage: "\
USAGE:
  bsc logs session <id> [--since <epochMs>] [--limit N] [--json|--pretty]

Every event for <id> across all streams, merged into one timeline, plus its token/cost rollup.",
    },
    CmdDoc {
        name: "<stream>",
        summary: "one event category: audit|skill|mcp|hook|coord|activity|done|perm",
        usage: "\
USAGE:
  bsc logs <stream> [--session <id>] [--since <epochMs>] [--limit N] [--json|--pretty]

The verb is the category name itself — one of: audit, skill, mcp, hook, coord, activity, done, perm.
`perm` is the permission-denial stream (the deny hooks' blocks). Prints that stream's events
(optionally filtered to one --session).",
    },
    CmdDoc {
        name: "cost",
        summary: "token + cost rollup",
        usage: "\
USAGE:
  bsc logs cost [--session <id>] [--full] [--limit N] [--json|--pretty]

Per-session token usage (in/out/cache) and USD cost; filter to one --session. `--full` emits the
desktop per-pane token-usage shape (pane/session_id + `*_tokens` field names), newest pane first,
bounded by --limit — the app's token telemetry read (#2144).",
    },
    CmdDoc {
        name: "tail",
        summary: "the newest raw lines of one stream",
        usage: "\
USAGE:
  bsc logs tail <stream> [--limit N] [--oldest] [--json]

The newest --limit RAW (unparsed) lines of a stream's log file (audit|skills|hooks|mcp|coord).
Newest-first by default; --oldest keeps the file's chronological order (the coord convention). The
desktop's per-stream log readers (#2144).",
    },
    CmdDoc {
        name: "waiting",
        summary: "every session BLOCKED ON A HUMAN (the queue to clear)",
        usage: "\nUSAGE:
  bsc logs waiting [--json]

Every session waiting on a person, oldest first — the queue, not a feed. Four kinds:
  wait        parked by `bsc-wait`               → answer with `bsc-answer <pane>`
  ask         an unanswered `bsc-ask` question   → answer with `bsc-answer <pane>`
  request     an open change request (#4001)     → `bsc plan request resolve <id> --note ...`
  permission  stopped at a permission prompt     → needs the USER, not the director

Re-derived from the whole log each call, so it is correct across an app restart. Empty output means
nothing is blocked.",
    },
    CmdDoc {
        name: "pane-activity",
        summary: "each pane's latest run/idle turn state",
        usage: "\
USAGE:
  bsc logs pane-activity [--json]

One row per pane: its latest turn-boundary state (run|idle) and epoch-ms timestamp, newest pane
first (#1184).",
    },
    CmdDoc {
        name: "done-panes",
        summary: "panes that self-reported done",
        usage: "\
USAGE:
  bsc logs done-panes [--json]

The deduped set of panes that self-reported `done` via bsc-done, newest first (#1379).",
    },
    CmdDoc {
        name: "perf",
        summary: "recent perf.db samples (rss/cpu/threads)",
        usage: "\
USAGE:
  bsc logs perf [--session <id>] [--since <epochMs>] [--limit N] [--json|--pretty]

Recent process metrics sampled into perf.db (the one binary-SQLite stream): rss, cpu%, threads.",
    },
    CmdDoc {
        name: "summary",
        summary: "a one-line recap for a session",
        usage: "\
USAGE:
  bsc logs summary --session <id> [--json|--pretty]

A compact one-line recap of a session: role, event counts, cost, last activity.",
    },
    CmdDoc {
        name: "scope",
        summary: "toggle CONSOLE log scopes at runtime (the file/audit log is always kept)",
        usage: "\
USAGE:
  bsc logs scope set <scope> <off|error|warn|info|debug|trace>
  bsc logs scope list
  bsc logs scope reset

Controls the app's runtime log-scope graph (#1389): silence or raise a subsystem's CONSOLE output by
module scope (e.g. `bsc logs scope set fleet off`) — the file/audit log always keeps every record. A
longest-prefix match cascades to the subtree; `list` shows the graph; `reset` clears all overrides.",
    },
];

struct Args {
    positional: Vec<String>,
    session: Option<String>,
    stream: Option<String>,
    since: Option<i64>,
    limit: Option<usize>,
    json: bool,
    pretty: bool,
    /// `tail`: return the oldest-first (chronological) order instead of newest-first (#2144).
    oldest: bool,
    /// `cost`: emit the desktop per-pane token-usage shape (with session_id + `*_tokens`) (#2144).
    full: bool,
    dir: Option<PathBuf>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        positional: vec![],
        session: None,
        stream: None,
        since: None,
        limit: None,
        json: false,
        pretty: false,
        oldest: false,
        full: false,
        dir: None,
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => { a.json = true; a.pretty = true; }
            "--oldest" => a.oldest = true,
            "--full" => a.full = true,
            "--session" => a.session = Some(it.next().ok_or("--session needs a value")?),
            "--stream" => a.stream = Some(it.next().ok_or("--stream needs a value")?),
            "--since" => a.since = Some(it.next().ok_or("--since needs a value")?.parse().map_err(|_| "--since must be epoch ms")?),
            "--limit" => a.limit = Some(it.next().ok_or("--limit needs a value")?.parse().map_err(|_| "--limit must be a number")?),
            "--dir" => a.dir = Some(PathBuf::from(it.next().ok_or("--dir needs a value")?)),
            // `-h`/`--help` route to the help command (handled in run()).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

/// `ts_ms` → `HH:MM:SS` (UTC), for the lean TSV timeline.
fn hms(ms: i64) -> String {
    let s = (ms / 1000).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

/// The `logs` subcommand entrypoint: `args` is everything after `bsc logs`; `prog` is the display
/// name for help/errors (`"bsc logs"` from the umbrella, `"bsc-logs"` from the legacy shim).
///
/// Help (`help` / `help <cmd>` / `<cmd> help`) is resolved before touching the log dir. Unlike the
/// `handle_help`-driven CLIs, a BARE invocation does NOT print help — it keeps `bsc logs`'
/// established default of listing every session (the `sessions` verb).
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // `bsc logs scope …` — runtime console-scope control (#1389), folded UNDER `logs` so there's one
    // `logs` namespace (not a confusing `log` vs `logs` pair). Delegate before parsing so scope's own
    // args/flags don't run through the reader's parser.
    if args.first().map(String::as_str) == Some("scope") {
        return crate::scope::run_cli(args[1..].to_vec(), "bsc logs scope");
    }
    let a = parse_args(args)?;

    // Help surface — handled before touching the log dir (help must work anywhere). `help` /
    // `help <cmd>` and the trailing `<cmd> help` form; a bare `bsc logs` keeps its `sessions` default.
    if a.positional.first().map(String::as_str) == Some("help") {
        match a.positional.get(1) {
            Some(name) => print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, name)),
            None => print!("{}", bsc_cli_util::help_overview(prog, TAGLINE, COMMANDS)),
        }
        return Ok(());
    }
    if a.positional.get(1).map(String::as_str) == Some("help") {
        let name = a.positional[0].clone();
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, &name));
        return Ok(());
    }

    let dir = a.dir.clone().unwrap_or_else(crate::log_dir);
    let streams: Vec<&'static str> = match &a.stream {
        Some(s) => vec![canonical_stream(s).ok_or_else(|| format!("unknown stream '{s}'"))?],
        None => vec![],
    };
    let verb = a.positional.first().map(String::as_str).unwrap_or("sessions");

    match verb {
        // Every console session, one line each.
        "sessions" => {
            let rows = sessions(&dir);
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["session\trole\ttools\tskills\tmcp\tcoord\tcost\tactivity".to_string()];
                lines.extend(rows.iter().map(|r| {
                    format!("{}\t{}\t{}\t{}\t{}\t{}\t${:.2}\t{}", r.session, r.role, r.tools, r.skills, r.mcp, r.coord, r.cost_usd, r.activity)
                }));
                lines.join("\n")
            });
        }
        // One session's full, time-merged story across every stream.
        "session" => {
            let id = a.positional.get(1).cloned().or(a.session.clone())
                .ok_or("usage: bsc logs session <id>")?;
            let events = query(&dir, &streams, Some(&id), a.since, a.limit);
            let c = cost::cost_for_session(&dir, &id);
            #[derive(serde::Serialize)]
            struct Out<'a> { session: &'a str, role: &'a str, events: &'a [LogEvent], cost: Option<cost::Cost> }
            let value = Out { session: &id, role: role_of(&id), events: &events, cost: c.clone() };
            emit(a.pretty, a.json, &value, || {
                let mut lines = vec!["time\tstream\tdetail".to_string()];
                lines.extend(events.iter().map(|e| format!("{}\t{}\t{}", hms(e.ts_ms), e.stream, e.summary)));
                if let Some(c) = &c {
                    lines.push(format!("--\tcost\t{} · in {} out {} cache {} · ${:.4}", c.model, c.input, c.output, c.cache_creation + c.cache_read, c.cost_usd));
                }
                lines.join("\n")
            });
        }
        // Token + cost rollup. `--full` emits the desktop per-pane token-usage shape (#2144).
        "cost" if a.full => {
            let rows = cost::usage(&dir, a.limit.unwrap_or(usize::MAX));
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["pane\tsession\tmodel\tin\tout\tcache\tcost".to_string()];
                lines.extend(rows.iter().map(|u| {
                    format!("{}\t{}\t{}\t{}\t{}\t{}\t${:.4}", u.pane, u.session_id, u.model, u.input_tokens, u.output_tokens, u.cache_creation_tokens + u.cache_read_tokens, u.cost_usd)
                }));
                lines.join("\n")
            });
        }
        "cost" => {
            let all = cost::all_costs(&dir);
            let rows: Vec<cost::Cost> = match &a.session {
                Some(s) => all.into_iter().filter(|c| &c.session == s).collect(),
                None => all,
            };
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["session\tmodel\tin\tout\tcache\tcost".to_string()];
                lines.extend(rows.iter().map(|c| {
                    format!("{}\t{}\t{}\t{}\t{}\t${:.4}", c.session, c.model, c.input, c.output, c.cache_creation + c.cache_read, c.cost_usd)
                }));
                lines.join("\n")
            });
        }
        // The newest raw lines of one stream (audit|skills|hooks|mcp|coord) (#2144).
        "tail" => {
            let stream = a.positional.get(1).cloned()
                .ok_or("usage: bsc logs tail <stream> [--limit N] [--oldest]")?;
            let lines = crate::tail_raw(&dir, &stream, a.limit.unwrap_or(1000), a.oldest);
            emit(a.pretty, a.json, &lines, || lines.join("\n"));
        }
        // Every session blocked on a human (#4015) — the queue the director sweeps.
        "waiting" => {
            let rows = crate::waiting::waiting(&dir);
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["pane	kind	id	detail".to_string()];
                for w in &rows {
                    lines.push(format!("{}	{}	{}	{}", w.pane, w.kind, w.id, w.detail));
                }
                lines.join("
")
            });
        }
        // Each pane's latest run/idle turn state (#1184).
        "pane-activity" => {
            let rows = crate::pane_activity(&dir);
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["pane\tstate\tat".to_string()];
                lines.extend(rows.iter().map(|r| format!("{}\t{}\t{}", r.pane, r.state, r.at)));
                lines.join("\n")
            });
        }
        // Panes that self-reported done (#1379).
        "done-panes" => {
            let rows = crate::done_panes(&dir);
            emit(a.pretty, a.json, &rows, || rows.join("\n"));
        }
        // Recent perf.db samples (rss/cpu/threads), the one binary-SQLite stream (#1716). perf.db
        // sits in the same log dir; read-only. Honors --session / --since / --limit like every verb.
        "perf" => {
            let samples = perf::perf_samples(&dir.join("perf.db"), a.session.as_deref(), a.since, a.limit);
            emit(a.pretty, a.json, &samples, || {
                let dash = |v: Option<i64>| v.map(|n| n.to_string()).unwrap_or_else(|| "-".into());
                let mut lines = vec!["time\tsession\tpid\trss_mb\tcpu%\tthreads".to_string()];
                lines.extend(samples.iter().map(|s| {
                    let rss = s.rss_bytes.map(|b| format!("{:.1}", b as f64 / 1_048_576.0)).unwrap_or_else(|| "-".into());
                    let cpu = s.cpu_pct.map(|c| format!("{c:.1}")).unwrap_or_else(|| "-".into());
                    format!("{}\t{}\t{}\t{}\t{}\t{}", hms(s.ts), s.session, dash(s.pid), rss, cpu, dash(s.threads))
                }));
                lines.join("\n")
            });
        }
        // A one-line recap for a session.
        "summary" => {
            let id = a.session.clone().or_else(|| a.positional.get(1).cloned())
                .ok_or("usage: bsc logs summary --session <id>")?;
            let r = sessions(&dir).into_iter().find(|r| r.session == id).unwrap_or(SessionRow {
                session: id.clone(), role: role_of(&id), tools: 0, skills: 0, mcp: 0, coord: 0, cost_usd: 0.0, activity: String::new(),
            });
            emit(a.pretty, a.json, &r, || {
                format!("{} [{}] · tools {} skills {} coord {} · ${:.2} · {}", r.session, r.role, r.tools, r.skills, r.coord, r.cost_usd, if r.activity.is_empty() { "—" } else { &r.activity })
            });
        }
        // A single stream (the verb is the stream name).
        other => {
            let s = canonical_stream(other).ok_or_else(|| {
                format!(
                    "unknown command/stream '{other}'\n\n{}",
                    bsc_cli_util::help_overview(prog, TAGLINE, COMMANDS)
                )
            })?;
            let events = query(&dir, &[s], a.session.as_deref(), a.since, a.limit);
            emit(a.pretty, a.json, &events, || {
                let mut lines = vec!["time\tsession\tdetail".to_string()];
                lines.extend(events.iter().map(|e| format!("{}\t{}\t{}", hms(e.ts_ms), e.session, e.summary)));
                lines.join("\n")
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{run, COMMANDS, TAGLINE};

    #[test]
    fn new_read_verbs_dispatch_without_error() {
        // The #2144 verbs wire through `run` against a --dir: tail / pane-activity / done-panes /
        // cost --full. Missing files degrade to empty (no panic, Ok result). Pure shapes are tested
        // in lib.rs / cost.rs; this guards the arg parsing + dispatch.
        let d = std::env::temp_dir().join(format!("bsc-logs-cli-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("audit.log"), "2026-06-26T10:00:00Z\tk\tRead\ta\n").unwrap();
        std::fs::write(d.join("activity.log"), "100\tk\trun\n").unwrap();
        std::fs::write(d.join("done.log"), "100\tk\n").unwrap();
        let dir = d.to_string_lossy().into_owned();
        let go = |v: Vec<&str>| {
            let mut args: Vec<String> = v.into_iter().map(String::from).collect();
            args.extend(["--dir".into(), dir.clone(), "--json".into()]);
            run(args, "bsc logs")
        };
        assert!(go(vec!["tail", "audit", "--limit", "10"]).is_ok());
        assert!(go(vec!["tail", "coord", "--oldest"]).is_ok()); // missing coord.log ⇒ empty
        assert!(go(vec!["pane-activity"]).is_ok());
        assert!(go(vec!["done-panes"]).is_ok());
        assert!(go(vec!["cost", "--full", "--limit", "5"]).is_ok());
        // `tail` with no stream positional is a clear usage error, not a panic.
        assert!(go(vec!["tail"]).is_err());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc logs", TAGLINE, COMMANDS);
        for c in ["sessions", "session", "cost", "perf", "summary", "<stream>"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        // Per-command help shows that one command's detail only.
        let one = bsc_cli_util::help_for("bsc logs", TAGLINE, COMMANDS, "perf");
        assert!(one.contains("bsc logs perf"));
        assert!(one.contains("perf.db"));
        assert!(!one.contains("token + cost rollup"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc logs", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
