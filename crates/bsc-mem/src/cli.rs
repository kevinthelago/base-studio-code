//! The `bsc mem` subcommand — see the crate doc for why this noun exists at all.

use crate::stats::{self, Half};
use bsc_cli_util::CmdDoc;
use errordb::{RunFilter, RunRow, Store};
use std::path::PathBuf;

const TAGLINE: &str = "the MEMORY + COST surface — app heap, build time and build memory (read-only)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "build",
        summary: "what builds COST — count, median, worst, latest (time and peak memory)",
        usage: "\
USAGE:
  bsc mem build [--stage <s>] [--source <t>] [--since <epochMs>] [--limit N] [--db <p>|--project <k>] [--json|--pretty]

Reads the `runs` rows `bsc errors run` writes — every wrapped build and launch, CLEAN as well as
failed. That is the point: a store holding only failures can say what is broken but not whether the
build is getting slower, which is the question this verb exists for.

Reports TIME and PEAK MEMORY separately, each as count / median / worst / latest.

MEDIAN, not mean: build times are dominated by whether the cache was warm, and one cold run is minutes
against seconds — a single one drags a mean far enough to hide a real regression in every run after it.
The worst is reported alongside, so the cold run is visible rather than hidden.

An UNMEASURED run is counted and reported as unmeasured, never as zero. `n` and `measured` are both
printed for the same reason: a median resting on 2 readings out of 40 rows is a different claim from
one resting on 40, and collapsing them would let a confident number stand on almost nothing.",
    },
    CmdDoc {
        name: "compare",
        summary: "split at a boundary and report both halves — did the change help?",
        usage: "\
USAGE:
  bsc mem compare --at <epochMs> [--stage <s>] [--source <t>] [--db <p>|--project <k>] [--json|--pretty]

The verb the rest exist for, and the same shape `bsc perf compare` has. Everything before `--at`
against everything from `--at` onward; a reading taken exactly at the boundary belongs to the AFTER
half, because it is the change's.

A HALF WITH NO ROWS IS REPORTED ABSENT, NEVER AS ZERO. An empty window is not a fast one — it is a
window nothing was measured in, and a change with no measurement after it has not been shown to help.

Get the boundary from the moment you made the change: `date +%s%3N` before you start.",
    },
    CmdDoc {
        name: "growth",
        summary: "is a live session's RSS climbing? — the leak question",
        usage: "\
USAGE:
  bsc mem growth --session <id> [--since <epochMs>] [--json|--pretty]

The RSS slope of one running session, from the app's perf.db samples. Answers the leak question that a
single reading cannot: 400 MB is only worrying if it was 200 MB an hour ago.

DELEGATES to the same reader `bsc logs perf growth` uses rather than restating the arithmetic — one
slope with two front doors, not two implementations free to disagree.",
    },
    CmdDoc {
        name: "app",
        summary: "what the RUNNING app holds — JS heap, DOM nodes, listeners (needs the browser harness)",
        usage: "\
USAGE:
  bsc mem app [--seconds N] [--json|--pretty]

Drives the app in headless Chromium and reports JS heap, DOM node count and listener count.

WHY A BROWSER AND NOT THE APP ITSELF: the app ships on WebKitGTK, which exposes nothing usable —
its remote inspector speaks a proprietary protocol with no installed client, `performance.memory` is
Chromium-only, and `measureUserAgentSpecificMemory` is unimplemented. Chromium over CDP is the only
place these numbers can be read at all.

READ THE LIMIT BEFORE YOU TRUST THE NUMBER: Chromium is not WebKitGTK, so an engine-level WebKit leak
will NOT reproduce here. What does carry over is anything application-level — accumulating listeners,
retained JS, a runaway render loop. A clean run is evidence about the APP, never about the renderer
that dies.

Requires the browser, which `npm install` does NOT imply: `npx playwright install chromium`. When it is
absent this says so and exits non-zero, rather than reporting a zero that reads like a measurement.",
    },
];

struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    project: Option<String>,
    stage: Option<String>,
    source: Option<String>,
    session: Option<String>,
    since: Option<i64>,
    at: Option<i64>,
    limit: Option<i64>,
    seconds: Option<u32>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        json: false, pretty: false, db: None, project: None, stage: None, source: None,
        session: None, since: None, at: None, limit: None, seconds: None, positional: Vec::new(),
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        let num = |raw: &str, flag: &str| -> Result<i64, String> {
            raw.parse::<i64>().map_err(|_| format!("{flag}: not a number: {raw}"))
        };
        match flag {
            "--json" => a.json = true,
            "--pretty" => { a.json = true; a.pretty = true }
            // These four took the next argument whatever it was and stayed None at end-of-line, with
            // no refusal at all. Preserved: `value` is the only thing that refuses, so `ok()` keeps
            // `bsc mem --db` behaving exactly as it did rather than growing an error here.
            "--db" => a.db = v.value("--db needs a path").ok(),
            "--project" => a.project = v.value("--project needs a value").ok(),
            "--stage" => a.stage = v.value("--stage needs a value").ok(),
            "--source" => a.source = v.value("--source needs a value").ok(),
            "--session" => a.session = v.value("--session needs a value").ok(),
            "--since" => a.since = Some(num(&v.value("--since needs a value")?, "--since")?),
            "--at" => a.at = Some(num(&v.value("--at needs a value")?, "--at")?),
            "--limit" => a.limit = Some(num(&v.value("--limit needs a value")?, "--limit")?),
            "--seconds" => {
                let raw = v.value("--seconds needs a value")?;
                a.seconds = Some(raw.parse().map_err(|_| format!("--seconds: not a number: {raw}"))?);
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

/// Resolve the project's error.db exactly as `bsc errors` does — `--project` → hub path, else `--db` /
/// `$BSC_ERROR_DB`. Deliberately the SAME precedence: two surfaces reading one store must never
/// disagree about which store a key names.
fn resolve_db(a: &Args) -> Result<PathBuf, String> {
    let key = a.project.as_deref().map(str::trim).filter(|k| !k.is_empty());
    if key.is_some() && a.db.is_some() {
        return Err("--db and --project name two different stores; pass one".to_string());
    }
    if let Some(key) = key {
        let base = bsc_util::bsc_base_dir()
            .ok_or("could not resolve a home directory; set HOME/USERPROFILE")?;
        return Ok(base.join("projects").join(key).join("error.db"));
    }
    bsc_cli_util::resolve_store_path(&a.db, "BSC_ERROR_DB", || {
        Err("no error.db: pass --db <path>, --project <key>, or set BSC_ERROR_DB".to_string())
    })
}

fn rows(a: &Args) -> Result<Vec<RunRow>, String> {
    let path = resolve_db(a)?;
    let store = Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))?;
    store
        .runs(&RunFilter {
            stage: a.stage.clone(),
            source: a.source.clone(),
            since: a.since,
            limit: a.limit,
        })
        .map_err(|e| format!("reading runs: {e}"))
}

/// Human-readable megabytes, or `-` when the reading is absent. Never `0 MB` for an absent value.
fn mb(v: Option<i64>) -> String {
    v.map(|b| format!("{:.0} MB", b as f64 / 1_048_576.0)).unwrap_or_else(|| "-".into())
}

/// Human-readable seconds, or `-` when absent.
fn secs(v: Option<i64>) -> String {
    v.map(|ms| format!("{:.1}s", ms as f64 / 1000.0)).unwrap_or_else(|| "-".into())
}

fn render_summary(label: &str, s: &stats::Summary, unit: fn(Option<i64>) -> String) -> String {
    format!(
        "  {label:<7} n={} measured={}  median {}  worst {}  latest {}",
        s.n, s.measured, unit(s.median), unit(s.worst), unit(s.latest),
    )
}

fn cmd_build(a: &Args) -> Result<(), String> {
    let rows = rows(a)?;
    let time = stats::summarize(&rows.iter().map(|r| r.ms).collect::<Vec<_>>());
    let peak = stats::summarize(&rows.iter().map(|r| r.peak_rss_bytes).collect::<Vec<_>>());
    let out = serde_json::json!({ "runs": rows.len(), "time": time, "peakRss": peak });
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        if rows.is_empty() {
            // NOT an error and NOT a zero: an empty store is the ordinary state before the first
            // wrapped build, and saying how to fill it is more useful than reporting nothing.
            return "no runs recorded yet — wrap a build with `bsc errors run --stage build --source <tag> -- <cmd>`".to_string();
        }
        format!(
            "{} run(s)\n{}\n{}",
            rows.len(),
            render_summary("time", &time, secs),
            render_summary("memory", &peak, mb),
        )
    });
    Ok(())
}

fn cmd_compare(a: &Args) -> Result<(), String> {
    let at = a.at.ok_or("usage: bsc mem compare --at <epochMs>")?;
    let rows = rows(a)?;
    let split = |pick: fn(&RunRow) -> Option<i64>| {
        let pairs: Vec<(i64, Option<i64>)> = rows.iter().map(|r| (r.ts, pick(r))).collect();
        stats::compare(&pairs, at)
    };
    let (t_before, t_after) = split(|r| r.ms);
    let (m_before, m_after) = split(|r| r.peak_rss_bytes);
    let out = serde_json::json!({
        "at": at,
        "time": { "before": t_before, "after": t_after },
        "peakRss": { "before": m_before, "after": m_after },
    });
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        let line = |name: &str, h: &Half, unit: fn(Option<i64>) -> String| match h {
            // ABSENT is said in words. A reader skimming for a number must not be able to mistake an
            // unmeasured window for a fast one.
            Half::Absent => format!("  {name:<7} ABSENT — nothing was measured in this half"),
            Half::Present(s) => render_summary(name, s, unit),
        };
        format!(
            "before {at}\n{}\n{}\n\nfrom {at}\n{}\n{}",
            line("time", &t_before, secs),
            line("memory", &m_before, mb),
            line("time", &t_after, secs),
            line("memory", &m_after, mb),
        )
    });
    Ok(())
}

fn cmd_growth(a: &Args) -> Result<(), String> {
    let session = a.session.as_deref().ok_or("usage: bsc mem growth --session <id>")?;
    let dir = bsc_util::bsc_base_dir().ok_or("could not resolve a home directory")?;
    let growth = logs::perf::perf_growth(&dir.join("perf.db"), session, a.since);
    bsc_cli_util::emit(a.pretty, a.json, &growth, || match &growth {
        None => format!("no perf samples for session '{session}' — is it running?"),
        Some(g) => format!("{g:?}"),
    });
    Ok(())
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("build") => cmd_build(&a),
        Some("compare") => cmd_compare(&a),
        Some("growth") => cmd_growth(&a),
        Some("app") => crate::app::run(a.seconds, a.pretty, a.json),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}
