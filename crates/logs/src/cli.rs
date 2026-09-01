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
  bsc logs waiting [--all] [--json]

Every session waiting on a person, oldest first — the queue, not a feed. Four kinds:
  wait        parked by `bsc-wait`               → answer with `bsc-answer <pane>`
  ask         an unanswered `bsc-ask` question   → answer with `bsc-answer <pane>`
  request     an open change request (#4001)     → `bsc plan request resolve <id> --note ...`
  permission  stopped at a permission prompt     → needs the USER, not the director

YOUR project only. coord.log is one app-wide file, so an unscoped queue hands you workers you have
no authority over; the scope comes from your own pane id. --all shows every project (for a human
asking who is blocked anywhere), and outside a session there is no pane id, so --all is the default.

Re-derived from the whole log each call, so it is correct across an app restart. Empty output means
nothing is blocked.",
    },
    CmdDoc {
        name: "pending",
        summary: "captured work awaiting YOUR routing (issues to assign, briefs to reconcile)",
        usage: "\nUSAGE:
  bsc logs pending [--all] [--json]

Everything captured that still needs the DIRECTOR, oldest first — a queue, not a feed. Two kinds:
  issue   captured by `bsc-issue`, not yet routed  -> `bsc-assign <pane> --issue <id>`
  brief   an upstream plan update, not yet handled -> reconcile, then `bsc-brief-done <id>`

The ID COLUMN IS WHAT CLOSES THE ROW. Pass it back verbatim: an issue is closed by the assign that
carries `--issue <id>`, a brief by `bsc-brief-done <id>`. An assign with no --issue routes the work
but closes nothing, so the row keeps coming back.

SIBLING OF `bsc logs waiting`, not part of it. That queue is about a SESSION that is stopped and
needs something to resume it — every one of its kinds is a parked pane. Nothing here is parked:
this is work that has been captured and needs routing. Sweep both; they are the same discipline.

YOUR project only, from your own pane id — an issue is placed by its emitter, a brief by its target
(a brief comes from an upstream tier that sits outside your project). --all shows every project, and
outside a session there is no pane id, so --all is the default.

Re-derived from the whole log each call, so it is correct across an app restart. Empty output means
nothing is awaiting you.",
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
  bsc logs perf growth --session <id> [--since <epochMs>] [--json|--pretty]

Recent process metrics sampled into perf.db (the one binary-SQLite stream): rss, cpu%, threads.

`growth` answers 'is rss growing, and how fast' for ONE session over the window: the first and last
rss-bearing sample, the delta, and the rate in MB/min — so a leak hunt stops hand-rolling a
sleep+sqlite3 polling loop to compute the same thing. Fewer than two rss-bearing samples in the
window reports absence (an explicit 'not enough data' line, or `null` under --json), never a
fabricated zero rate.",
    },
    CmdDoc {
        name: "pss",
        summary: "system-wide memory by process category (PSS, not RSS) — the fleet-load sampler",
        usage: "\
USAGE:
  bsc logs pss [--json|--pretty]
  bsc logs pss --watch [--interval N] [--duration N] [--json|--pretty]

Sums `Pss` (proportional set size — shared pages divided by their sharer count, so the categories
add up honestly instead of double-counting shared libraries) out of every `/proc/<pid>/smaps_rollup`,
bucketed by what the process actually IS: vitest workers, vitest runner, rustc, sccache, cargo,
C++ (libduckdb), claude sessions, the app, node (other), other. Categorized by argv[0] — never by a
free-text search of the whole cmdline, since a claude session's own prompt routinely contains words
like \"cargo\" or \"vitest\" as PROSE, not as the process it names.

A bare call takes ONE sample: category table + system memory-in-use + swap resident.

`--watch` samples repeatedly (`--interval` seconds apart, default 9, for `--duration` seconds total,
default 60 — the BEFORE measurement's own cadence) and reports the climb in memory-in-use from the
first sample to the last, the swap resident at the start, and each category's OWN peak across the
whole window (independently — a category's peak sample need not be the same sample another
category's peak came from), plus their sum. This is the repeatable replacement for the ad-hoc python
PSS sampler used to produce the BEFORE figures on `a-scoped-gate-runs-the-whole-vitest-suite-and-
takes-no-slot` (#182).

Linux-only: `smaps_rollup` does not exist on macOS or Windows. `--json` on an unsupported platform
reports an explicit error rather than a fabricated empty table.",
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
    /// `waiting`: every project's rows, not just the caller's
    /// (#coord-log-is-app-wide-answers-cross-projects).
    all: bool,
    dir: Option<PathBuf>,
    /// `pss`: repeated sampling instead of one shot.
    watch: bool,
    /// `pss --watch`: seconds between samples (default 9, the BEFORE measurement's own cadence).
    interval: Option<u64>,
    /// `pss --watch`: total seconds to sample for (default 60).
    duration: Option<u64>,
    /// `pss`: override `/proc` — a test seam, not something a real run needs to pass.
    proc_dir: Option<PathBuf>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        positional: vec![],
        session: None,
        stream: None,
        since: None,
        limit: None,
        json: false,
        pretty: false,
        oldest: false,
        full: false,
        all: false,
        dir: None,
        watch: false,
        interval: None,
        duration: None,
        proc_dir: None,
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => { a.json = true; a.pretty = true; }
            "--oldest" => a.oldest = true,
            "--full" => a.full = true,
            "--all" => a.all = true,
            "--watch" => a.watch = true,
            "--interval" => a.interval = Some(v.value("--interval needs a value")?.parse().map_err(|_| "--interval must be seconds")?),
            "--duration" => a.duration = Some(v.value("--duration needs a value")?.parse().map_err(|_| "--duration must be seconds")?),
            "--proc" => a.proc_dir = Some(PathBuf::from(v.value("--proc needs a value")?)),
            "--session" => a.session = Some(v.value("--session needs a value")?),
            "--stream" => a.stream = Some(v.value("--stream needs a value")?),
            "--since" => a.since = Some(v.value("--since needs a value")?.parse().map_err(|_| "--since must be epoch ms")?),
            "--limit" => a.limit = Some(v.value("--limit needs a value")?.parse().map_err(|_| "--limit must be a number")?),
            "--dir" => a.dir = Some(PathBuf::from(v.value("--dir needs a value")?)),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
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
            // Scoped to the CALLER's project unless --all. `coord.log` is one app-wide file, so an
            // unscoped queue hands a director workers it has no authority over
            // (#coord-log-is-app-wide-answers-cross-projects). `BSC_AUDIT_PANE` is the session's own
            // pane id, set by `pty_create` — absent (a plain shell), the scope is None and the whole
            // queue prints, which is what a human asking "who is blocked anywhere?" wants.
            let me = std::env::var("BSC_AUDIT_PANE").ok().filter(|s| !s.is_empty() && s != "?");
            let scope = if a.all { None } else { me.as_deref() };
            let rows = crate::waiting::waiting_in(&dir, scope);
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["pane	kind	id	detail".to_string()];
                for w in &rows {
                    lines.push(format!("{}	{}	{}	{}", w.pane, w.kind, w.id, w.detail));
                }
                lines.join("
")
            });
        }
        // Captured work awaiting the DIRECTOR (#captured-issues-and-briefs-have-no-queue-to-pull-from)
        // — the routing queue, sibling to `waiting`'s parked-session queue.
        "pending" => {
            // Same scoping rule and the same reason as `waiting`: `coord.log` is one app-wide file,
            // so an unscoped queue hands a director captured work it has no authority to route.
            let me = std::env::var("BSC_AUDIT_PANE").ok().filter(|s| !s.is_empty() && s != "?");
            let scope = if a.all { None } else { me.as_deref() };
            let rows = crate::pending::pending_in(&dir, scope);
            emit(a.pretty, a.json, &rows, || {
                let mut lines = vec!["kind\tid\tfrom\ttarget\ttitle\tdetail".to_string()];
                for p in &rows {
                    lines.push(format!(
                        "{}\t{}\t{}\t{}\t{}\t{}",
                        p.kind, p.id, p.from, p.target, p.title, p.detail
                    ));
                }
                lines.join("\n")
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
        // `bsc logs perf growth --session <id>` — one session's RSS growth rate over the window
        // (#request-159): first/last rss-bearing sample, delta, duration, MB/min. Absence (fewer
        // than two rss-bearing samples) is reported explicitly, never a fabricated zero rate.
        "perf" if a.positional.get(1).map(String::as_str) == Some("growth") => {
            let id = a.session.clone()
                .ok_or("usage: bsc logs perf growth --session <id> [--since <epochMs>]")?;
            let growth = perf::perf_growth(&dir.join("perf.db"), &id, a.since);
            emit(a.pretty, a.json, &growth, || match &growth {
                Some(g) => format!(
                    "session\tn\tfrom_mb\tto_mb\tdelta_mb\tduration_s\tmb_per_min\n{}\t{}\t{:.1}\t{:.1}\t{:.1}\t{:.1}\t{:.2}",
                    g.session, g.n,
                    g.from_bytes as f64 / 1_048_576.0,
                    g.to_bytes as f64 / 1_048_576.0,
                    g.delta_bytes as f64 / 1_048_576.0,
                    g.duration_secs,
                    g.mb_per_min,
                ),
                None => format!("no rate for '{id}': fewer than two rss-bearing samples in this window"),
            });
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
        // System-wide memory by process category (#182) — the repeatable replacement for the ad-hoc
        // python PSS sampler.
        "pss" => {
            if !cfg!(target_os = "linux") {
                return Err("bsc logs pss needs /proc/*/smaps_rollup, which only exists on Linux".to_string());
            }
            let proc_dir = a.proc_dir.clone().unwrap_or_else(|| PathBuf::from("/proc"));
            let gb = |b: u64| format!("{:.2} GB", b as f64 / 1_073_741_824.0);
            let dash_gb = |b: Option<u64>| b.map(gb).unwrap_or_else(|| "-".into());

            if !a.watch {
                let s = crate::pss::sample(&proc_dir, bsc_util::now_ms());
                let totals = crate::pss::aggregate(&s.procs);
                emit(a.pretty, a.json, &s, || {
                    let mut lines = vec!["category\tpss\tprocs".to_string()];
                    lines.extend(totals.iter().map(|c| format!("{}\t{}\t{}", c.category, gb(c.pss_bytes), c.procs)));
                    if let Some(mem) = s.mem {
                        lines.push(format!("--\tmemory in use\t{}", gb(mem.used_bytes)));
                        lines.push(format!("--\tswap resident\t{}", gb(mem.swap_used_bytes)));
                    }
                    lines.join("\n")
                });
                return Ok(());
            }

            let interval = std::time::Duration::from_secs(a.interval.unwrap_or(9).max(1));
            let duration = std::time::Duration::from_secs(a.duration.unwrap_or(60));
            let start = std::time::Instant::now();
            let mut samples = Vec::new();
            loop {
                samples.push(crate::pss::sample(&proc_dir, bsc_util::now_ms()));
                if start.elapsed() + interval > duration {
                    break;
                }
                std::thread::sleep(interval);
            }
            let w = crate::pss::summarize_watch(&samples);
            emit(a.pretty, a.json, &w, || {
                let mut lines = vec![format!(
                    "{} sample(s) · memory in use {} -> {} · swap resident {}",
                    w.samples,
                    dash_gb(w.used_from_bytes),
                    dash_gb(w.used_to_bytes),
                    dash_gb(w.swap_used_bytes),
                )];
                lines.push("category (peak, independent)\tpss\tprocs".to_string());
                lines.extend(w.peak_by_category.iter().map(|c| format!("{}\t{}\t{}", c.category, gb(c.pss_bytes), c.procs)));
                lines.push(format!("--\tpeak sum\t{}", gb(w.peak_sum_bytes)));
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
    fn perf_growth_dispatches_and_requires_a_session() {
        // `bsc logs perf growth` is a sub-verb of `perf`, not its own top-level command — this guards
        // the `a.positional.get(1) == Some("growth")` dispatch rather than falling through to the
        // plain `perf` sample listing (#request-159).
        let d = std::env::temp_dir().join(format!("bsc-logs-cli-growth-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let conn = rusqlite::Connection::open(d.join("perf.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE perf_samples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL, session_id TEXT NOT NULL,
                pid INTEGER, rss_bytes INTEGER, cpu_pct REAL, threads INTEGER);
            INSERT INTO perf_samples (ts, session_id, pid, rss_bytes, cpu_pct, threads)
                VALUES (0, 'app:webview', 1, 104857600, 1.0, 8),
                       (60000, 'app:webview', 1, 209715200, 1.0, 8);",
        )
        .unwrap();
        drop(conn);
        let dir = d.to_string_lossy().into_owned();
        let go = |v: Vec<&str>| {
            let mut args: Vec<String> = v.into_iter().map(String::from).collect();
            args.extend(["--dir".into(), dir.clone()]);
            run(args, "bsc logs")
        };
        // No --session is a usage error, not a panic or a silent empty result.
        assert!(go(vec!["perf", "growth"]).is_err());
        // A real window dispatches fine in both lean and --json form.
        assert!(go(vec!["perf", "growth", "--session", "app:webview"]).is_ok());
        assert!(go(vec!["perf", "growth", "--session", "app:webview", "--json"]).is_ok());
        // A session with no (or one) rss-bearing sample dispatches fine too — absence, not an error.
        assert!(go(vec!["perf", "growth", "--session", "does-not-exist"]).is_ok());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pss_dispatches_single_shot_and_watch_against_a_fake_proc_tree() {
        let root = std::env::temp_dir().join(format!("bsc-logs-cli-pss-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("meminfo"),
            "MemTotal:       32000000 kB\nMemAvailable:   12000000 kB\nSwapTotal:      16000000 kB\nSwapFree:        8000000 kB\n",
        )
        .unwrap();
        let pid_dir = root.join("4242");
        std::fs::create_dir_all(&pid_dir).unwrap();
        std::fs::write(pid_dir.join("cmdline"), b"/usr/bin/rustc\0").unwrap();
        std::fs::write(pid_dir.join("comm"), "rustc\n").unwrap();
        std::fs::write(pid_dir.join("smaps_rollup"), "Rss:              100000 kB\nPss:              100000 kB\n").unwrap();
        let proc = root.to_string_lossy().into_owned();

        let go = |v: Vec<&str>| {
            let mut args: Vec<String> = v.into_iter().map(String::from).collect();
            args.extend(["--proc".into(), proc.clone(), "--json".into()]);
            run(args, "bsc logs")
        };
        assert!(go(vec!["pss"]).is_ok());
        // duration 0 takes exactly one sample and returns immediately — no real sleeping in a test.
        assert!(go(vec!["pss", "--watch", "--interval", "1", "--duration", "0"]).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc logs", TAGLINE, COMMANDS);
        for c in ["sessions", "session", "cost", "perf", "pss", "summary", "<stream>"] {
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
