//! `bsc-logs` — drill into any console session's logs from its own shell (#1607, #1325).
//!
//! A read-only query over the app's per-session event streams (tools / skills / mcp / hooks /
//! cost / coord / activity) under `~/.base-studio-code/` (`$BSC_LOG_DIR` overrides). Mirrors
//! `bsc-plan`'s house style: lean TSV with a header by default, `--json` (compact) / `--pretty`,
//! `--session` / `--stream` / `--since` / `--limit`.
//!
//! Usage:
//!   bsc-logs sessions                       # every console session, one line each
//!   bsc-logs session <id>                   # one session's full, time-merged story
//!   bsc-logs <stream> [--session <id>]      # one category (audit|skill|mcp|hook|coord|activity|done)
//!   bsc-logs cost [--session <id>]          # token + cost rollup
//!   bsc-logs summary --session <id>         # a one-line recap
//!   flags: --session <id> --stream <name> --since <epochMs> --limit N --json --pretty --dir <path>

use std::path::PathBuf;
use std::process::ExitCode;

use logs::{canonical_stream, cost, query, role_of, sessions, LogEvent, SessionRow};

struct Args {
    positional: Vec<String>,
    session: Option<String>,
    stream: Option<String>,
    since: Option<i64>,
    limit: Option<usize>,
    json: bool,
    pretty: bool,
    dir: Option<PathBuf>,
}

fn parse_args() -> Result<Args, String> {
    let mut a = Args {
        positional: vec![],
        session: None,
        stream: None,
        since: None,
        limit: None,
        json: false,
        pretty: false,
        dir: None,
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => { a.json = true; a.pretty = true; }
            "--session" => a.session = Some(it.next().ok_or("--session needs a value")?),
            "--stream" => a.stream = Some(it.next().ok_or("--stream needs a value")?),
            "--since" => a.since = Some(it.next().ok_or("--since needs a value")?.parse().map_err(|_| "--since must be epoch ms")?),
            "--limit" => a.limit = Some(it.next().ok_or("--limit needs a value")?.parse().map_err(|_| "--limit must be a number")?),
            "--dir" => a.dir = Some(PathBuf::from(it.next().ok_or("--dir needs a value")?)),
            "-h" | "--help" => { print!("{USAGE}"); std::process::exit(0); }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

const USAGE: &str = "\
bsc-logs — query a console session's logs (#1607)

  sessions                  every console session, one line each
  session <id>              one session's full, time-merged story
  <stream> [--session <id>] one category: audit|skill|mcp|hook|coord|activity|done
  cost [--session <id>]     token + cost rollup
  summary --session <id>    a one-line recap

flags: --session <id> --stream <name> --since <epochMs> --limit N --json --pretty --dir <path>
";

/// `ts_ms` → `HH:MM:SS` (UTC), for the lean TSV timeline.
fn hms(ms: i64) -> String {
    let s = (ms / 1000).rem_euclid(86_400);
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

fn print_json<T: serde::Serialize>(v: &T, pretty: bool) {
    let s = if pretty {
        serde_json::to_string_pretty(v).unwrap_or_default()
    } else {
        serde_json::to_string(v).unwrap_or_default()
    };
    println!("{s}");
}

fn run() -> Result<(), String> {
    let a = parse_args()?;
    let dir = a.dir.clone().unwrap_or_else(logs::log_dir);
    let streams: Vec<&'static str> = match &a.stream {
        Some(s) => vec![canonical_stream(s).ok_or_else(|| format!("unknown stream '{s}'"))?],
        None => vec![],
    };
    let verb = a.positional.first().map(String::as_str).unwrap_or("sessions");

    match verb {
        // Every console session, one line each.
        "sessions" => {
            let rows = sessions(&dir);
            if a.json {
                print_json(&rows, a.pretty);
            } else {
                println!("session\trole\ttools\tskills\tmcp\tcoord\tcost\tactivity");
                for r in &rows {
                    println!("{}\t{}\t{}\t{}\t{}\t{}\t${:.2}\t{}", r.session, r.role, r.tools, r.skills, r.mcp, r.coord, r.cost_usd, r.activity);
                }
            }
        }
        // One session's full, time-merged story across every stream.
        "session" => {
            let id = a.positional.get(1).cloned().or(a.session.clone())
                .ok_or("usage: bsc-logs session <id>")?;
            let events = query(&dir, &streams, Some(&id), a.since, a.limit);
            let c = cost::cost_for_session(&dir, &id);
            if a.json {
                #[derive(serde::Serialize)]
                struct Out<'a> { session: &'a str, role: &'a str, events: &'a [LogEvent], cost: Option<cost::Cost> }
                print_json(&Out { session: &id, role: role_of(&id), events: &events, cost: c }, a.pretty);
            } else {
                println!("time\tstream\tdetail");
                for e in &events {
                    println!("{}\t{}\t{}", hms(e.ts_ms), e.stream, e.summary);
                }
                if let Some(c) = c {
                    println!("--\tcost\t{} · in {} out {} cache {} · ${:.4}", c.model, c.input, c.output, c.cache_creation + c.cache_read, c.cost_usd);
                }
            }
        }
        // Token + cost rollup.
        "cost" => {
            let all = cost::all_costs(&dir);
            let rows: Vec<cost::Cost> = match &a.session {
                Some(s) => all.into_iter().filter(|c| &c.session == s).collect(),
                None => all,
            };
            if a.json {
                print_json(&rows, a.pretty);
            } else {
                println!("session\tmodel\tin\tout\tcache\tcost");
                for c in &rows {
                    println!("{}\t{}\t{}\t{}\t{}\t${:.4}", c.session, c.model, c.input, c.output, c.cache_creation + c.cache_read, c.cost_usd);
                }
            }
        }
        // A one-line recap for a session.
        "summary" => {
            let id = a.session.clone().or_else(|| a.positional.get(1).cloned())
                .ok_or("usage: bsc-logs summary --session <id>")?;
            let r = sessions(&dir).into_iter().find(|r| r.session == id).unwrap_or(SessionRow {
                session: id.clone(), role: role_of(&id), tools: 0, skills: 0, mcp: 0, coord: 0, cost_usd: 0.0, activity: String::new(),
            });
            if a.json {
                print_json(&r, a.pretty);
            } else {
                println!("{} [{}] · tools {} skills {} coord {} · ${:.2} · {}", r.session, r.role, r.tools, r.skills, r.coord, r.cost_usd, if r.activity.is_empty() { "—" } else { &r.activity });
            }
        }
        // A single stream (the verb is the stream name).
        other => {
            let s = canonical_stream(other).ok_or_else(|| format!("unknown command/stream '{other}'\n\n{USAGE}"))?;
            let events = query(&dir, &[s], a.session.as_deref(), a.since, a.limit);
            if a.json {
                print_json(&events, a.pretty);
            } else {
                println!("time\tsession\tdetail");
                for e in &events {
                    println!("{}\t{}\t{}", hms(e.ts_ms), e.session, e.summary);
                }
            }
        }
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("bsc-logs: {e}");
            ExitCode::FAILURE
        }
    }
}
