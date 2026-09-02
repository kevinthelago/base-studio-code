//! `bsc perf` (#bsc-perf-makes-the-measure-change-remeasure-loop-reachable) — the FRONTEND
//! instrumentation, aggregated into answers.
//!
//! # Why this exists
//! Across a long performance push the only thing that kept the work honest was a loop: measure, change,
//! re-measure. It killed a 5× estimate that turned out to be 1.28×, found a scan storm (770 jank events,
//! 111.8 seconds of blocked main thread), found an edge-batch rebuilding 326 times for nothing, and found
//! a 402-spawn regression introduced by the previous fix. Every one of those came from splitting one log
//! at a boundary and diffing the halves.
//!
//! That loop was only available to someone who could write throwaway scripts against a text file. A
//! worker's surface is `bsc`, and there was nothing on it — so the fleet could change performance but
//! never measure it.
//!
//! # NOT `bsc logs perf`
//! `bsc logs perf` reads perf.db **process** samples — rss, cpu, threads. This reads the **frontend
//! instrumentation** the app writes into its rotating log: render commits, named render phases, jank
//! windows, and `bsc` child-process spawns. Two different axes; the shared word is unfortunate, so both
//! helps say so.
//!
//! # Phase one is a parser, deliberately
//! The verbs are the valuable part and their shape does not change when the source does. A structured
//! event store can replace this parser later behind the same surface. Shipping the parser gets the fleet a
//! working loop in one slice rather than blocking it on the bigger change — but it does mean a message
//! format drift breaks the reader, which is why every line shape is pinned by a test against a real
//! captured sample.

use std::path::PathBuf;

/// Seconds-of-day, the only resolution the log stamps carry (`HH:MM:SS`, no date). Everything here is
/// therefore WITHIN one log; comparing across days is not something the source supports, and pretending
/// otherwise would silently mix yesterday's numbers into today's.
pub type Clock = u32;

/// One parsed instrumentation record.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// `[render] <surface> update <n>ms` — one React commit of a profiled region.
    Commit { at: Clock, surface: String, ms: f64 },
    /// `[perf] <label> took <n>ms` — one named derivation inside a render.
    Phase { at: Clock, label: String, ms: u64 },
    /// `[perf] … jank N× (worst Ams, total Bms) … store X×n, Y×n …` — a main-thread stall window.
    Jank { at: Clock, count: u32, worst: u64, total: u64, stores: Vec<String> },
    /// `[bsc] child <cmd> took <n>ms` — one `bsc` CHILD PROCESS spawn.
    Spawn { at: Clock, cmd: String, ms: u64 },
}

impl Event {
    /// When it happened, for windowing.
    pub fn at(&self) -> Clock {
        match self {
            Event::Commit { at, .. } | Event::Phase { at, .. } | Event::Jank { at, .. } | Event::Spawn { at, .. } => *at,
        }
    }
}

/// Parse `HH:MM:SS` from the head of a log line into seconds-of-day.
pub fn parse_clock(line: &str) -> Option<Clock> {
    let b = line.as_bytes();
    if b.len() < 8 || b[2] != b':' || b[5] != b':' {
        return None;
    }
    let n = |i: usize| -> Option<u32> { line.get(i..i + 2)?.parse().ok() };
    Some(n(0)? * 3600 + n(3)? * 60 + n(6)?)
}

/// The substring between `open` and the next `close`, if both are present in order.
fn between<'a>(hay: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let s = hay.find(open)? + open.len();
    let rest = &hay[s..];
    let e = rest.find(close)?;
    Some(&rest[..e])
}

/// Parse ONE log line into an [`Event`], or `None` for the vast majority that carry no instrumentation.
///
/// Deliberately tolerant: a line that ALMOST matches yields `None` rather than a zeroed record, because a
/// fabricated sample is worse than a missing one — it would move a median without anyone knowing.
pub fn parse_line(line: &str) -> Option<Event> {
    let at = parse_clock(line)?;

    // `[render] <surface> update 22.9ms`
    if let Some(rest) = line.split("[render] ").nth(1) {
        let mut it = rest.split_whitespace();
        let surface = it.next()?.to_string();
        let _update = it.next()?;                       // the phase word ("update"/"mount")
        let ms: f64 = it.next()?.trim_end_matches("ms").parse().ok()?;
        return Some(Event::Commit { at, surface, ms });
    }

    // `[bsc] child plan list --full --json took 571ms`
    if let Some(rest) = line.split("[bsc] child ").nth(1) {
        let cmd = between(rest, "", " took ")?.trim().to_string();
        let ms: u64 = rest.split(" took ").nth(1)?.trim().trim_end_matches("ms").parse().ok()?;
        return Some(Event::Spawn { at, cmd, ms });
    }

    // The two `[perf] …` shapes.
    if let Some(rest) = line.split("[perf] ").nth(1) {
        // `jank 2× (worst 110ms, total 217ms)` — the × is multi-byte, so match on the ASCII around it.
        if let Some(j) = rest.find("jank ") {
            let after = &rest[j + 5..];
            let count: u32 = after.split(|c: char| !c.is_ascii_digit()).next()?.parse().ok()?;
            let worst: u64 = between(after, "worst ", "ms")?.parse().ok()?;
            let total: u64 = between(after, "total ", "ms")?.parse().ok()?;
            // `store liveAgents×3, componentBuildStatus×1 · …` — the writers that drove the stall, which
            // is what turns "something blocked" into "THIS blocked".
            let stores = match between(after, "store ", "·") {
                Some(s) => s
                    .split(',')
                    .filter_map(|p| p.trim().split(['×', 'x']).next())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                None => Vec::new(),
            };
            return Some(Event::Jank { at, count, worst, total, stores });
        }
        // `designs:health took 158ms` — a NAMED phase. Requires the label to carry no space, which is
        // what separates it from the jank line's prose.
        if let Some((label, tail)) = rest.split_once(" took ") {
            if !label.contains(' ') {
                let ms: u64 = tail.trim().trim_end_matches("ms").parse().ok()?;
                return Some(Event::Phase { at, label: label.to_string(), ms });
            }
        }
    }
    None
}

/// Parse a whole log into events, dropping every uninstrumented line.
pub fn parse_log(text: &str) -> Vec<Event> {
    text.lines().filter_map(parse_line).collect()
}

/// The app's rotating log — `$BSC_APP_LOG`, else the per-platform Tauri `app_log_dir` default.
///
/// Resolved WITHOUT Tauri on purpose: this reader runs from a session's shell, not inside the app, so it
/// cannot ask the runtime where its own log went.
pub fn app_log_path() -> Option<PathBuf> {
    if let Some(p) = std::env::var_os("BSC_APP_LOG") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    const ID: &str = "com.basestudio.code";
    const FILE: &str = "base-studio-code.log";
    #[cfg(target_os = "windows")]
    {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join(ID).join("logs").join(FILE))
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Logs").join(ID).join(FILE))
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".local").join("share").join(ID).join("logs").join(FILE))
    }
}

// ── Aggregation ─────────────────────────────────────────────────────────────────────────────────────

/// A distribution, reported the way a decision needs it. The TAIL is what a user feels, so p90 and max are
/// first-class rather than derived on demand.
#[derive(Debug, Clone, PartialEq)]
pub struct Stats {
    pub n: usize,
    pub median: f64,
    pub mean: f64,
    pub p90: f64,
    pub max: f64,
    /// Share of samples over one 60fps frame — the number that says "is this felt".
    pub over_frame_pct: f64,
}

/// Summarize samples. `None` for an EMPTY set — absence must stay distinguishable from zero, or a window
/// with no data reads as a window with perfect performance.
pub fn stats(samples: &[f64]) -> Option<Stats> {
    if samples.is_empty() {
        return None;
    }
    let mut v = samples.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let pick = |q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)];
    Some(Stats {
        n: v.len(),
        median: pick(0.5),
        mean: v.iter().sum::<f64>() / v.len() as f64,
        p90: pick(0.9),
        max: v[v.len() - 1],
        over_frame_pct: v.iter().filter(|x| **x > 16.0).count() as f64 * 100.0 / v.len() as f64,
    })
}

/// One command's spawn cost, or one label's phase cost — the same shape answers both, because the
/// question ("what does this thing cost me in aggregate, and how often does it happen") is the same.
#[derive(Debug, Clone, PartialEq)]
pub struct Rollup {
    pub name: String,
    pub calls: usize,
    pub total_ms: u64,
    pub worst_ms: u64,
    pub mean_ms: u64,
}

/// Roll up `(name, ms)` pairs, heaviest TOTAL first — total rather than worst, because a 5ms cost paid on
/// every commit outranks a 30ms one paid once, and ranking by worst hides exactly that.
pub fn rollup(items: impl IntoIterator<Item = (String, u64)>) -> Vec<Rollup> {
    let mut by: std::collections::BTreeMap<String, (usize, u64, u64)> = Default::default();
    for (name, ms) in items {
        let e = by.entry(name).or_insert((0, 0, 0));
        e.0 += 1;
        e.1 += ms;
        e.2 = e.2.max(ms);
    }
    let mut out: Vec<Rollup> = by
        .into_iter()
        .map(|(name, (calls, total_ms, worst_ms))| Rollup {
            name,
            calls,
            total_ms,
            worst_ms,
            mean_ms: total_ms / calls.max(1) as u64,
        })
        .collect();
    out.sort_by(|a, b| b.total_ms.cmp(&a.total_ms).then(a.name.cmp(&b.name)));
    out
}

/// Every jank window in a set, rolled into the shape a reader acts on.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct JankRollup {
    pub windows: usize,
    pub events: u32,
    pub worst_ms: u64,
    pub blocked_ms: u64,
    /// Which store writes appeared in those windows, most frequent first — the "who did this" column.
    pub drivers: Vec<(String, usize)>,
}

/// Roll up jank windows, counting which store writes drove them.
pub fn jank_rollup(events: &[Event]) -> JankRollup {
    let mut r = JankRollup::default();
    let mut drivers: std::collections::BTreeMap<String, usize> = Default::default();
    for e in events {
        if let Event::Jank { count, worst, total, stores, .. } = e {
            r.windows += 1;
            r.events += count;
            r.worst_ms = r.worst_ms.max(*worst);
            r.blocked_ms += total;
            for s in stores {
                *drivers.entry(s.clone()).or_insert(0) += 1;
            }
        }
    }
    r.drivers = drivers.into_iter().collect();
    r.drivers.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    r
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────────────────────

use bsc_cli_util::CmdDoc;

const TAGLINE: &str =
    "the FRONTEND instrumentation — render commits, named phases, jank windows, bsc spawns (read-only)";

/// `bsc perf`'s own verb catalog — NOT `logs::cli::COMMANDS`. The `logs` crate serves three
/// nouns (`logs`, `perf`, `metrics`) from three different `run` fns, so the catalog belongs to the
/// NOUN. `pub` so `bsc surface verbs` projects the right one.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "summary",
        summary: "all four readings at once — the default",
        usage: "USAGE:
  bsc perf [summary] [--since HH:MM:SS] [--log <path>] [--json]

Commits, phases, jank and spawns in one read. Start here; the other verbs drill in.

NOT `bsc logs perf`, which reads perf.db PROCESS samples (rss/cpu/threads). This reads what the APP
writes into its rotating log: React commit times, named render phases, main-thread jank windows, and
`bsc` child-process spawns. Two different axes that unfortunately share a word.",
    },
    CmdDoc {
        name: "commits",
        summary: "render commit distribution per surface (n · median · p90 · max · % over a frame)",
        usage: "USAGE:
  bsc perf commits [--surface <name>] [--since HH:MM:SS] [--json]

One row per profiled surface. The TAIL is the number that matters — a median under a frame with a p90
of 70ms is felt as a stutter, not as smooth.",
    },
    CmdDoc {
        name: "phases",
        summary: "named derivations inside a render — runs · total · worst",
        usage: "USAGE:
  bsc perf phases [--since HH:MM:SS] [--json]

Ranked by TOTAL, not worst: a 5ms derivation on every commit costs more than a 30ms one that runs once,
and ranking by worst hides exactly that. RUNS is half the reading — a phase that recomputes when nothing
changed is the common bug.",
    },
    CmdDoc {
        name: "jank",
        summary: "main-thread stall windows + the store writes that drove them",
        usage: "USAGE:
  bsc perf jank [--since HH:MM:SS] [--json]

Windows, worst single block, total blocked, and WHICH store writes appeared in them. The drivers column
is what turns a bare stall into a named cause.",
    },
    CmdDoc {
        name: "spawns",
        summary: "bsc child-process spawns — calls · total · worst · mean, per command",
        usage: "USAGE:
  bsc perf spawns [--since HH:MM:SS] [--json]

Every `bsc` call the app makes is a PROCESS SPAWN. Only spawns slow enough to warn are logged, so this
is the tail rather than every call — a command with many entries is issuing many processes.

The binary matters and is not knowable from here: the app spawns the BUNDLED sidecar (a release build,
~50-70ms floor), not a debug build (~300ms). Reading these numbers against the wrong binary produced a
5x error once already.",
    },
    CmdDoc {
        name: "compare",
        summary: "split the log at a boundary and report both halves — did the change help?",
        usage: "USAGE:
  bsc perf compare --at HH:MM:SS [--log <path>] [--json]

The verb the rest exist for. Every real finding comes from diffing two halves of one log around a
change: a culling slice estimated at 5x and measured at 1.28x, a scan storm of 770 jank events, an edge
batch rebuilding 326 times for nothing.

Reports commits, jank and spawn totals BEFORE and AFTER `--at`. A half with no samples is reported as
absent, never as zero — an empty window is not a fast one.",
    },
];

struct Args {
    json: bool,
    since: Option<Clock>,
    at: Option<Clock>,
    surface: Option<String>,
    log: Option<PathBuf>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args { json: false, since: None, at: None, surface: None, log: None, positional: Vec::new() };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        // The refusal wording is the one this CLI already produced — `--since needs a value`.
        let mut take = |f: &str| v.value(&format!("{f} needs a value"));
        match flag {
            "--json" => a.json = true,
            "--since" => a.since = Some(parse_hms(&take("--since")?)?),
            "--at" => a.at = Some(parse_hms(&take("--at")?)?),
            "--surface" => a.surface = Some(take("--surface")?),
            "--log" => a.log = Some(PathBuf::from(take("--log")?)),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

fn parse_hms(s: &str) -> Result<Clock, String> {
    parse_clock(&format!("{s} ")).ok_or_else(|| {
        format!("'{s}' is not HH:MM:SS (the log stamps carry no date, so times are within one log)")
    })
}

fn load(args: &Args) -> Result<Vec<Event>, String> {
    let path = args
        .log
        .clone()
        .or_else(app_log_path)
        .ok_or("could not resolve the app log — pass --log <path> or set $BSC_APP_LOG")?;
    let text = std::fs::read_to_string(&path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut ev = parse_log(&text);
    if let Some(since) = args.since {
        ev.retain(|e| e.at() >= since);
    }
    Ok(ev)
}

fn commit_samples(ev: &[Event], surface: Option<&str>) -> Vec<(String, f64)> {
    ev.iter()
        .filter_map(|e| match e {
            Event::Commit { surface: s, ms, .. } if surface.is_none_or(|w| w == s) => Some((s.clone(), *ms)),
            _ => None,
        })
        .collect()
}

fn stats_json(s: &Stats) -> serde_json::Value {
    serde_json::json!({
        "n": s.n,
        "median": s.median,
        "mean": (s.mean * 10.0).round() / 10.0,
        "p90": s.p90,
        "max": s.max,
        "overFramePct": s.over_frame_pct.round(),
    })
}

/// The `perf` entrypoint: `args` is everything after `bsc perf`.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    let cmd = args.positional.first().cloned().unwrap_or_else(|| "summary".into());
    match cmd.as_str() {
        "summary" => cmd_summary(&args),
        "commits" => cmd_commits(&args),
        "phases" => cmd_phases(&args),
        "jank" => cmd_jank(&args),
        "spawns" => cmd_spawns(&args),
        "compare" => cmd_compare(&args, prog),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_commits(args: &Args) -> Result<(), String> {
    let ev = load(args)?;
    let mut by: std::collections::BTreeMap<String, Vec<f64>> = Default::default();
    for (s, ms) in commit_samples(&ev, args.surface.as_deref()) {
        by.entry(s).or_default().push(ms);
    }
    if args.json {
        let o: serde_json::Map<String, serde_json::Value> = by
            .iter()
            .filter_map(|(k, v)| stats(v).map(|s| (k.clone(), stats_json(&s))))
            .collect();
        println!("{}", serde_json::to_string(&serde_json::Value::Object(o)).unwrap_or_else(|_| "{}".into()));
    } else if by.is_empty() {
        println!("(no render commits in this window)");
    } else {
        println!("{:<16} {:>5} {:>9} {:>9} {:>9} {:>8}", "surface", "n", "median", "p90", "max", ">frame");
        for (k, v) in &by {
            if let Some(s) = stats(v) {
                println!(
                    "{k:<16} {:>5} {:>7.1}ms {:>7.1}ms {:>7.1}ms {:>7.0}%",
                    s.n, s.median, s.p90, s.max, s.over_frame_pct
                );
            }
        }
    }
    Ok(())
}

fn cmd_phases(args: &Args) -> Result<(), String> {
    let ev = load(args)?;
    let rows = rollup(ev.iter().filter_map(|e| match e {
        Event::Phase { label, ms, .. } => Some((label.clone(), *ms)),
        _ => None,
    }));
    print_rollup(args.json, &rows, "phase", "(no timed phases in this window)")
}

fn cmd_spawns(args: &Args) -> Result<(), String> {
    let ev = load(args)?;
    // Collapse variable arguments so `plan get <ref>` groups with itself rather than fragmenting into
    // one row per argument.
    let rows = rollup(ev.iter().filter_map(|e| match e {
        Event::Spawn { cmd, ms, .. } => {
            Some((cmd.split_whitespace().take(3).collect::<Vec<_>>().join(" "), *ms))
        }
        _ => None,
    }));
    print_rollup(args.json, &rows, "command", "(no bsc spawns in this window)")
}

fn print_rollup(json: bool, rows: &[Rollup], label: &str, empty: &str) -> Result<(), String> {
    if json {
        let arr: Vec<serde_json::Value> = rows
            .iter()
            .map(|r| {
                serde_json::json!({
                    "name": r.name, "calls": r.calls, "totalMs": r.total_ms,
                    "worstMs": r.worst_ms, "meanMs": r.mean_ms,
                })
            })
            .collect();
        println!("{}", serde_json::to_string(&arr).unwrap_or_else(|_| "[]".into()));
    } else if rows.is_empty() {
        println!("{empty}");
    } else {
        println!("{label:<34} {:>6} {:>9} {:>8} {:>7}", "calls", "total", "worst", "mean");
        for r in rows {
            let n = if r.name.chars().count() > 33 {
                format!("{}…", r.name.chars().take(32).collect::<String>())
            } else {
                r.name.clone()
            };
            println!(
                "{n:<34} {:>6} {:>8.1}s {:>7}ms {:>6}ms",
                r.calls,
                r.total_ms as f64 / 1000.0,
                r.worst_ms,
                r.mean_ms
            );
        }
    }
    Ok(())
}

fn cmd_jank(args: &Args) -> Result<(), String> {
    let ev = load(args)?;
    let r = jank_rollup(&ev);
    if args.json {
        let drivers: Vec<serde_json::Value> = r
            .drivers
            .iter()
            .map(|(n, c)| serde_json::json!({ "store": n, "windows": c }))
            .collect();
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "windows": r.windows, "events": r.events, "worstMs": r.worst_ms,
                "blockedMs": r.blocked_ms, "drivers": drivers,
            }))
            .unwrap_or_else(|_| "{}".into())
        );
    } else if r.windows == 0 {
        println!("(no jank windows in this window)");
    } else {
        println!(
            "windows {}  ·  events {}  ·  worst {}ms  ·  blocked {:.1}s",
            r.windows,
            r.events,
            r.worst_ms,
            r.blocked_ms as f64 / 1000.0
        );
        for (store, n) in r.drivers.iter().take(8) {
            println!("  store {store:<28} {n} window(s)");
        }
    }
    Ok(())
}

fn cmd_summary(args: &Args) -> Result<(), String> {
    if args.json {
        let ev = load(args)?;
        let all: Vec<f64> = commit_samples(&ev, args.surface.as_deref()).into_iter().map(|(_, ms)| ms).collect();
        let r = jank_rollup(&ev);
        let phases: Vec<serde_json::Value> = rollup(ev.iter().filter_map(|e| match e {
            Event::Phase { label, ms, .. } => Some((label.clone(), *ms)),
            _ => None,
        }))
        .iter()
        .take(5)
        .map(|r| serde_json::json!({ "name": r.name, "calls": r.calls, "totalMs": r.total_ms }))
        .collect();
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "commits": stats(&all).as_ref().map(stats_json),
                "jank": { "windows": r.windows, "worstMs": r.worst_ms, "blockedMs": r.blocked_ms },
                "phases": phases,
            }))
            .unwrap_or_else(|_| "{}".into())
        );
        return Ok(());
    }
    println!("── commits ──");
    cmd_commits(args)?;
    println!();
    println!("── phases ──");
    cmd_phases(args)?;
    println!();
    println!("── jank ──");
    cmd_jank(args)?;
    println!();
    println!("── spawns ──");
    cmd_spawns(args)?;
    Ok(())
}

fn cmd_compare(args: &Args, prog: &str) -> Result<(), String> {
    let at = args.at.ok_or_else(|| format!("usage: {prog} compare --at HH:MM:SS"))?;
    let ev = load(args)?;
    let (before, after): (Vec<Event>, Vec<Event>) = ev.into_iter().partition(|e| e.at() < at);

    let side = |set: &[Event]| {
        let commits: Vec<f64> = set
            .iter()
            .filter_map(|e| match e {
                Event::Commit { ms, .. } => Some(*ms),
                _ => None,
            })
            .collect();
        let spawn_ms: u64 = set
            .iter()
            .filter_map(|e| match e {
                Event::Spawn { ms, .. } => Some(*ms),
                _ => None,
            })
            .sum();
        (stats(&commits), jank_rollup(set), spawn_ms)
    };
    let (bs, bj, bsp) = side(&before);
    let (as_, aj, asp) = side(&after);

    if args.json {
        let half = |s: &Option<Stats>, j: &JankRollup, sp: u64| {
            serde_json::json!({
                "commits": s.as_ref().map(stats_json),
                "jank": { "windows": j.windows, "worstMs": j.worst_ms, "blockedMs": j.blocked_ms },
                "spawnMs": sp,
            })
        };
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "before": half(&bs, &bj, bsp), "after": half(&as_, &aj, asp),
            }))
            .unwrap_or_else(|_| "{}".into())
        );
        return Ok(());
    }

    // An absent half is STATED, never rendered as zeros — an empty window is not a fast one, and a
    // 22-sample window has already been mis-read as a trend once.
    let show = |name: &str, s: &Option<Stats>, j: &JankRollup, sp: u64| match s {
        None => println!("{name:<7} (no commits in this half)"),
        Some(s) => println!(
            "{name:<7} n={:<5} median={:>6.1}ms  p90={:>6.1}ms  max={:>6.1}ms  ·  jank {} win / {:.1}s  ·  spawns {:.1}s",
            s.n,
            s.median,
            s.p90,
            s.max,
            j.windows,
            j.blocked_ms as f64 / 1000.0,
            sp as f64 / 1000.0
        ),
    };
    show("before", &bs, &bj, bsp);
    show("after", &as_, &aj, asp);
    if let (Some(b), Some(a)) = (&bs, &as_) {
        if b.median > 0.0 {
            println!(
                "\nmedian {:.1}ms → {:.1}ms ({:+.0}%)   ·   p90 {:.1}ms → {:.1}ms",
                b.median,
                a.median,
                (a.median / b.median - 1.0) * 100.0,
                b.p90,
                a.p90
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REAL lines, copied verbatim from the app log this reader was written against. The parser is a
    /// regex-over-prose by design (phase one), so a message-format drift must fail a test rather than
    /// silently reporting nothing — which is the one failure mode that would make this tool lie.
    const REAL: &str = concat!(
        "20:44:58 WARN  base_studio_code_lib::frontend::perf [render] designs update 22.9ms\n",
        "20:45:00 WARN  base_studio_code_lib::frontend::perf [render] designs update 40.3ms\n",
        "20:45:15 WARN  base_studio_code_lib::frontend::perf [render] designs update 45.5ms\n",
        "20:45:00 WARN  base_studio_code_lib::frontend::perf [perf] designs:health took 158ms\n",
        "20:45:01 WARN  base_studio_code_lib::frontend::perf [perf] designs:edgeBatch took 5ms\n",
        "20:45:00 WARN  base_studio_code_lib::frontend::core [perf] 1.7s \u{b7} jank 2\u{d7} (worst 110ms, total 217ms) \u{b7} pty 1 evt, 0KB, 0ms write \u{b7} store liveAgents\u{d7}3, componentBuildStatus\u{d7}1 \u{b7} 1 terms \u{b7} heap 401/4192MB\n",
        "20:44:15 WARN  base_studio_code_lib::console::bsc [bsc] child plan list --full --json took 571ms\n",
        "20:44:15 WARN  base_studio_code_lib::console::bsc [bsc] child ui scan-cache put took 390ms\n",
        "20:45:00 WARN  base_studio_code_lib::frontend::perf [perf] graph cull: 434/465 nodes mounted (93%) at 28% zoom\n",
        "20:45:02 INFO  base_studio_code_lib::frontend::graph-loader graph-loader: mounted \"glancepage\" in 138ms\n",
    );

    #[test]
    fn parses_every_shape_the_app_actually_writes() {
        let ev = parse_log(REAL);
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Commit { .. })).count(), 3);
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Phase { .. })).count(), 2);
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Jank { .. })).count(), 1);
        assert_eq!(ev.iter().filter(|e| matches!(e, Event::Spawn { .. })).count(), 2);
    }

    #[test]
    fn a_commit_carries_its_surface_and_a_fractional_ms() {
        let e = parse_line("20:44:58 WARN  x [render] designs update 22.9ms").unwrap();
        assert_eq!(e, Event::Commit { at: 20 * 3600 + 44 * 60 + 58, surface: "designs".into(), ms: 22.9 });
    }

    #[test]
    fn a_jank_window_carries_the_stores_that_drove_it() {
        // The drivers are the whole point: they are what turned "something blocked" into a named cause
        // during the scan-storm investigation.
        let line = REAL.lines().find(|l| l.contains("jank")).unwrap();
        match parse_line(line).unwrap() {
            Event::Jank { count, worst, total, stores, .. } => {
                assert_eq!((count, worst, total), (2, 110, 217));
                assert_eq!(stores, vec!["liveAgents", "componentBuildStatus"]);
            }
            other => panic!("expected Jank, got {other:?}"),
        }
    }

    #[test]
    fn a_spawn_keeps_its_whole_command_line() {
        match parse_line("20:44:15 WARN  x [bsc] child plan list --full --json took 571ms").unwrap() {
            Event::Spawn { cmd, ms, .. } => {
                assert_eq!(cmd, "plan list --full --json");
                assert_eq!(ms, 571);
            }
            other => panic!("expected Spawn, got {other:?}"),
        }
    }

    #[test]
    fn ignores_lines_that_are_not_instrumentation() {
        // Including the two near-misses that share a prefix with something we DO parse: the cull line is
        // a `[perf]` that is not a phase, and graph-loader has a `in NNNms` that is not a spawn.
        for line in [
            "20:45:00 WARN  x [perf] graph cull: 434/465 nodes mounted (93%) at 28% zoom",
            "20:45:02 INFO  x graph-loader: mounted \"glancepage\" in 138ms",
            "not a log line at all",
            "",
        ] {
            assert_eq!(parse_line(line), None, "should not parse: {line:?}");
        }
    }

    #[test]
    fn a_malformed_number_yields_nothing_rather_than_a_zero() {
        // A fabricated sample is worse than a missing one: a zero would drag a median down and nobody
        // would know the line was junk.
        assert_eq!(parse_line("20:44:58 WARN  x [render] designs update abcms"), None);
        assert_eq!(parse_line("20:44:58 WARN  x [bsc] child plan list took ???ms"), None);
    }

    #[test]
    fn stats_report_the_tail_not_just_the_middle() {
        // The tail is what a user feels — a median under a frame with a p90 of 70ms reads as a stutter.
        let s = stats(&[10.0, 12.0, 14.0, 18.0, 70.0]).unwrap();
        assert_eq!(s.n, 5);
        assert_eq!(s.median, 14.0);
        assert_eq!(s.max, 70.0);
        assert_eq!(s.over_frame_pct.round(), 40.0);
    }

    #[test]
    fn stats_of_an_empty_set_is_none_not_zero() {
        // The load-bearing distinction: an empty window is not a fast one. A 22-sample window was nearly
        // mis-read as a trend during the session this tool came out of.
        assert!(stats(&[]).is_none());
    }

    #[test]
    fn rollup_ranks_by_total_so_a_cheap_frequent_cost_outranks_a_rare_expensive_one() {
        // The ranking that found `edgeBatch`: 326 runs at ~5ms beat a 158ms phase that ran twice.
        let rows = rollup(vec![
            ("edgeBatch".to_string(), 5),
            ("edgeBatch".to_string(), 5),
            ("edgeBatch".to_string(), 5),
            ("health".to_string(), 12),
        ]);
        assert_eq!(rows[0].name, "edgeBatch");
        assert_eq!((rows[0].calls, rows[0].total_ms, rows[0].worst_ms, rows[0].mean_ms), (3, 15, 5, 5));
        assert_eq!(rows[1].name, "health");
    }

    #[test]
    fn jank_rollup_counts_windows_and_ranks_the_drivers() {
        let ev = parse_log(REAL);
        let r = jank_rollup(&ev);
        assert_eq!((r.windows, r.events, r.worst_ms, r.blocked_ms), (1, 2, 110, 217));
        assert!(r.drivers.iter().any(|(s, _)| s == "componentBuildStatus"));
    }

    #[test]
    fn windowing_by_clock_splits_the_log() {
        // The comparison this tool exists for: everything before a boundary vs everything after.
        let ev = parse_log(REAL);
        let at = 20 * 3600 + 45 * 60; // 20:45:00
        let before = ev.iter().filter(|e| e.at() < at).count();
        let after = ev.iter().filter(|e| e.at() >= at).count();
        assert!(before > 0 && after > 0, "the fixture must straddle the boundary to prove anything");
        assert_eq!(before + after, ev.len());
    }

    #[test]
    fn the_log_path_honours_its_env_override() {
        // The reader runs from a session's shell, not inside the app, so it cannot ask Tauri where the
        // log went — the override is how a caller points it anywhere (a copy, a test fixture, a CI dump).
        std::env::set_var("BSC_APP_LOG", "/tmp/somewhere.log");
        assert_eq!(app_log_path(), Some(PathBuf::from("/tmp/somewhere.log")));
        std::env::remove_var("BSC_APP_LOG");
    }

    #[test]
    fn help_names_the_verbs_and_disambiguates_from_bsc_logs_perf() {
        // Two commands with "perf" in the name reading different things is a trap; the help has to say so.
        let ov = bsc_cli_util::help_overview("bsc perf", TAGLINE, COMMANDS);
        for v in ["commits", "phases", "jank", "spawns", "compare"] {
            assert!(ov.contains(v), "overview lists {v}");
        }
        let s = bsc_cli_util::help_for("bsc perf", TAGLINE, COMMANDS, "summary");
        assert!(s.contains("bsc logs perf"), "says what it is NOT");
    }
}
