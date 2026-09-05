//! `logs` — the unified log-query engine for base-studio-code (#1607).
//!
//! The app writes ~13 append-only event streams to `~/.base-studio-code/*.log`, each a TSV
//! stamped (mostly) with the **pane id** (`$BSC_AUDIT_PANE`) that identifies a console session.
//! This crate parses every stream into one normalized [`LogEvent`] model and answers
//! per-session queries — the engine behind the `bsc-logs` CLI (and, later, the desktop
//! observability commands). Pure: reads files, no Tauri, no network.
//!
//! Every stream now carries a leading pane column (`$BSC_AUDIT_PANE`): slice 1 read audit / skills
//! / tokens-cost / activity / done / coord, and slice 2 (#1743) added it to `mcp.log` + `hooks.log`,
//! so their events attribute to a session too. The parser stays backward-compatible with the legacy
//! column-less `mcp.log`/`hooks.log` lines already on disk — detected by column count, those resolve
//! to the unattributed session `"?"` (excluded from a `--session` query and the `sessions` rollup).
//!
//! The agent-facing CLI lives in [`cli`] (`bsc logs …`), dispatched by the unified `bsc` binary
//! (#1877) and by the legacy `bsc-logs` shim.

// Re-exported so a consumer says `logs::waiting(..) -> logs::WaitingSession` without naming the
// module twice — matching `usage`/`Usage` and `PerfSample` below. The Tauri command's return type
// is part of the frontend contract, so it is worth being a short, stable path.
pub use waiting::{waiting, waiting_by_pane, waiting_in, WaitingSession};

use std::path::{Path, PathBuf};

pub use cost::{usage, Cost, Usage};

pub use perf::PerfSample;


/// One normalized event from any stream. `ts_ms` is epoch milliseconds (normalized from the
/// stream's native ISO-8601 or epoch-ms timestamp); `session` is the pane id (or `"?"` for a legacy
/// column-less mcp/hooks line written before #1743); `summary` is a one-line human rendering.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct LogEvent {
    pub ts_ms: i64,
    pub session: String,
    /// One of: tool · skill · mcp · hook · activity · done · coord.
    pub stream: &'static str,
    pub summary: String,
    pub fields: Vec<String>,
}

/// The directory holding the log files: `$BSC_LOG_DIR`, else `~/.base-studio-code`.
pub fn log_dir() -> PathBuf {
    if let Ok(d) = std::env::var("BSC_LOG_DIR") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    bsc_util::bsc_base_dir().unwrap_or_else(|| PathBuf::from(".base-studio-code"))
}

/// Normalize a timestamp to epoch-ms. All-digits ⇒ already epoch-ms (activity/done/hooks/mcp);
/// otherwise parse `YYYY-MM-DDTHH:MM:SSZ` (audit/skills/coord) via the shared civil-date helper
/// (#1646). `None` on a malformed value.
pub fn to_ms(ts: &str) -> Option<i64> {
    let ts = ts.trim();
    if ts.is_empty() {
        return None;
    }
    if ts.bytes().all(|b| b.is_ascii_digit()) {
        return ts.parse::<i64>().ok();
    }
    bsc_util::iso8601_to_epoch_ms(ts)
}

/// The streams a `bsc-logs` query knows about — `(canonical name, file)` — from the shared
/// `bsc_util::LOG_STREAMS` registry (#1847), the ONE list also read by the pty env-writer. The
/// token/cost stream is staged + written but read via the separate cost path, so it's excluded here.
fn streams() -> Vec<(&'static str, &'static str)> {
    bsc_util::log_streams::reader_streams()
}

/// Resolve a user-supplied stream alias to its canonical name (e.g. `audit`→`tool`, `skills`→`skill`).
pub fn canonical_stream(name: &str) -> Option<&'static str> {
    match name {
        "tool" | "audit" | "tools" => Some("tool"),
        "skill" | "skills" => Some("skill"),
        "mcp" => Some("mcp"),
        "hook" | "hooks" => Some("hook"),
        "activity" => Some("activity"),
        "done" => Some("done"),
        // Schedule fires (hooks-and-schedules-belong-to-the-persona): written by the DESKTOP
        // scheduler rather than a session shell, since a schedule has no shell to emit from.
        "automation" | "automations" | "schedule" | "schedules" => Some("automation"),
        "coord" => Some("coord"),
        "perm" | "perms" | "deny" | "denials" => Some("perm"),
        // UI-design activity (#2525): `bsc logs tail ui` — the designer session's `ui-touch` stream.
        "ui" => Some("ui"),
        // Migration divergence: the two implementations of one migrated policy disagreed. The
        // aliases are the words a reader reaches for when they do not recall the stream's name —
        // `bsc logs tail disagreement` should not be a dead end.
        "divergence" | "divergences" | "disagreement" | "disagreements" | "drift" => Some("divergence"),
        // Provider rate-limit headroom — what budget a fleet has left.
        "ratelimit" | "ratelimits" | "rate-limit" | "headroom" | "budget" => Some("ratelimit"),
        _ => None,
    }
}

fn parse_line(stream: &'static str, line: &str) -> Option<LogEvent> {
    let f: Vec<&str> = line.split('\t').collect();
    if f.len() < 2 {
        return None;
    }
    let ts_ms = to_ms(f[0])?;
    let mk = |session: String, summary: String, fields: Vec<&str>| LogEvent {
        ts_ms,
        session,
        stream,
        summary,
        fields: fields.into_iter().map(String::from).collect(),
    };
    Some(match stream {
        // ts·pane·tool·target
        "tool" => mk(f[1].into(), format!("{} {}", f.get(2).unwrap_or(&""), f.get(3).unwrap_or(&"")).trim().into(), vec![f.get(2).copied().unwrap_or(""), f.get(3).copied().unwrap_or("")]),
        // ts·pane·event·skill
        "skill" => mk(f[1].into(), format!("{} ({})", f.get(3).unwrap_or(&""), f.get(2).unwrap_or(&"")), vec![f.get(3).copied().unwrap_or(""), f.get(2).copied().unwrap_or("")]),
        // ts·pane·state
        "activity" => mk(f[1].into(), f.get(2).unwrap_or(&"").to_string(), vec![f.get(2).copied().unwrap_or("")]),
        // ts·pane
        "done" => mk(f[1].into(), "done".into(), vec![]),
        // ts·pane·kind·a·b
        "coord" => mk(f[1].into(), format!("{} {} {}", f.get(2).unwrap_or(&""), f.get(3).unwrap_or(&""), f.get(4).unwrap_or(&"")).trim().into(), f[2..].to_vec()),
        // ts·pane·surface·derived_only·caller_only — a migration's two implementations disagreed.
        // `derived_only` is the DEFECT direction (Rust derived it, the caller omitted it);
        // `caller_only` is what a union legitimately produces and is not a fault.
        "divergence" => mk(
            f[1].into(),
            format!("{} derived-only={} caller-only={}", f.get(2).unwrap_or(&""), f.get(3).unwrap_or(&"∅"), f.get(4).unwrap_or(&"∅")),
            f[2..].to_vec(),
        ),
        // ts·pane·gate·verdict·target·reason (#1607 slice 2) — a permission denial from a deny hook.
        "perm" => mk(
            f[1].into(),
            format!("{} {} {}", f.get(2).unwrap_or(&""), f.get(3).unwrap_or(&""), f.get(4).unwrap_or(&"")).trim().into(),
            f[2..].to_vec(),
        ),
        // #1743: new lines are ts·pane·server·tool·outcome·ms·detail (7 cols); legacy lines have no
        // pane (ts·server·tool·outcome·ms·detail, 6 cols → unattributed "?"). Detect by column count.
        "mcp" => {
            let (session, b) = if f.len() >= 7 { (f[1].to_string(), 2) } else { ("?".to_string(), 1) };
            mk(session, format!("{}/{} {} {}ms", f.get(b).unwrap_or(&""), f.get(b + 1).unwrap_or(&""), f.get(b + 2).unwrap_or(&""), f.get(b + 3).unwrap_or(&"")), f[b..].to_vec())
        }
        // #1743: new lines are ts·pane·event·name·outcome (5 cols); legacy lines have no pane
        // (ts·event·name·outcome, 4 cols → unattributed "?"). Detect by column count.
        "hook" => {
            let (session, b) = if f.len() >= 5 { (f[1].to_string(), 2) } else { ("?".to_string(), 1) };
            mk(session, format!("{} {} {}", f.get(b).unwrap_or(&""), f.get(b + 1).unwrap_or(&""), f.get(b + 2).unwrap_or(&"")).trim().into(), f[b..].to_vec())
        }
        _ => return None,
    })
}

/// Read + parse one stream's events from `dir` (unsorted). Missing file ⇒ empty; malformed lines skipped.
pub fn read_stream(dir: &Path, stream: &'static str) -> Vec<LogEvent> {
    let file = streams().into_iter().find(|(s, _)| *s == stream).map(|(_, f)| f);
    let Some(file) = file else { return vec![] };
    let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
    text.lines().filter(|l| !l.trim().is_empty()).filter_map(|l| parse_line(stream, l)).collect()
}

/// Merge the requested `streams` (default: all), filter by `session` (events with session `"?"`
/// are dropped when a session filter is set — they can't be attributed yet) and `since_ms`, sort
/// ascending by time, and keep the newest `limit`.
pub fn query(
    dir: &Path,
    streams: &[&'static str],
    session: Option<&str>,
    since_ms: Option<i64>,
    limit: Option<usize>,
) -> Vec<LogEvent> {
    let wanted: Vec<&'static str> =
        if streams.is_empty() { self::streams().into_iter().map(|(s, _)| s).collect() } else { streams.to_vec() };
    let mut out: Vec<LogEvent> = Vec::new();
    for s in wanted {
        for e in read_stream(dir, s) {
            if let Some(want) = session {
                if e.session != want {
                    continue;
                }
            }
            if let Some(since) = since_ms {
                if e.ts_ms < since {
                    continue;
                }
            }
            out.push(e);
        }
    }
    out.sort_by_key(|e| e.ts_ms);
    if let Some(n) = limit {
        if out.len() > n {
            out.drain(0..out.len() - n);
        }
    }
    out
}

/// The newest `limit` raw (unparsed) lines of a stream's log file — the `bsc logs tail` shape the
/// desktop's per-stream `read_*_log` / `read_log_tail` readers returned (#2144). `name` is any stream
/// alias (`audit`/`skills`/`hooks`/`mcp`/`coord`, resolved via [`canonical_stream`]); `oldest` selects
/// the order — `false` (the default) returns newest-first (the audit/skill/hook/mcp convention),
/// `true` keeps the file's chronological oldest-first order (the coord log). Blank lines are dropped;
/// an unknown alias or a missing/unreadable file yields an empty list. Pure (reads one file).
pub fn tail_raw(dir: &Path, name: &str, limit: usize, oldest: bool) -> Vec<String> {
    let Some(canon) = canonical_stream(name) else { return vec![] };
    let Some((_, file)) = streams().into_iter().find(|(s, _)| *s == canon) else { return vec![] };
    let lines = last_lines(&dir.join(file), limit); // oldest-first, already capped at `limit`
    if oldest { lines } else { lines.into_iter().rev().collect() }
}

/// How much is read per step when tailing backwards. Large enough that a normal tail finishes in one
/// seek, small enough that a pathological single-line file does not pull the whole thing in at once.
const TAIL_CHUNK: u64 = 64 * 1024;

/// The last `limit` non-blank lines of `path`, in file order (oldest-first), read from the END.
///
/// The whole point is that the cost is bounded by `limit`, not by file size. The previous
/// implementation read the entire file into a `String`, allocated a `String` per line, reversed the
/// vector and threw nearly all of it away — measured at 354 calls / 203.9s in one session, with a
/// single call taking 14.5s, because `audit.log` is 2 MB and these logs are append-only and grow all
/// session (#the-log-readers-re-read-whole-files-on-every-poll).
///
/// THE CHUNK BOUNDARY IS THE PART THAT GOES WRONG. Reading backwards lands mid-line, so the first
/// line of the buffer is usually a fragment. It is dropped whenever there is more file behind it
/// (`pos > 0`) and kept only when the read reached byte 0 and the "fragment" is genuinely the file's
/// first line. Dropping the bytes BEFORE decoding also disposes of any UTF-8 sequence split across
/// the boundary, so the lossy decode never sees a truncated character.
fn last_lines(path: &Path, limit: usize) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    if limit == 0 {
        return vec![];
    }
    let Ok(mut f) = std::fs::File::open(path) else { return vec![] };
    let Ok(len) = f.seek(SeekFrom::End(0)) else { return vec![] };
    let mut buf: Vec<u8> = Vec::new();
    let mut pos = len;
    // Read backwards until the buffer holds more line breaks than we need (so `limit` COMPLETE lines
    // are present even after the leading fragment is dropped), or we run out of file.
    while pos > 0 && buf.iter().filter(|b| **b == b'\n').count() <= limit {
        let take = TAIL_CHUNK.min(pos);
        pos -= take;
        let mut chunk = vec![0u8; take as usize];
        if f.seek(SeekFrom::Start(pos)).is_err() || f.read_exact(&mut chunk).is_err() {
            break;
        }
        chunk.extend_from_slice(&buf);
        buf = chunk;
    }
    // Drop the partial first line — but only when there is more file before it.
    let body = if pos > 0 {
        match buf.iter().position(|b| *b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &buf[..], // one line longer than everything read; keep what we have
        }
    } else {
        &buf[..]
    };
    let text = String::from_utf8_lossy(body);
    let mut lines: Vec<String> =
        text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// One pane's latest turn-boundary state (#1184) — the `bsc logs pane-activity` shape the desktop's
/// `read_pane_activity` command returned. `state` is `"run"` (a turn is open) or `"idle"`; `at` is the
/// event's epoch-ms timestamp.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct PaneActivity {
    pub pane: String,
    pub state: String,
    pub at: u64,
}

/// The latest turn-boundary state per pane from `activity.log`, newest pane first (#1184 / #2144). A
/// later line for a pane supersedes earlier ones; only `run`/`idle`/`attn` states are kept — `attn`
/// (#4005) is Claude Code's `Notification` hook: the session is STOPPED waiting on the user (a permission
/// prompt, or a long input idle), which is neither working nor done. (Malformed/short
/// lines and unknown states are already dropped by the stream parser or filtered here). Missing log ⇒
/// empty, so the frontend cleanly falls back to its silence-timer behavior.
pub fn pane_activity(dir: &Path) -> Vec<PaneActivity> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, (usize, String, u64)> = HashMap::new();
    for (i, e) in read_stream(dir, "activity").into_iter().enumerate() {
        let state = e.summary.trim().to_string();
        if e.session.is_empty() || (state != "run" && state != "idle" && state != "attn") {
            continue;
        }
        latest.insert(e.session.clone(), (i, state, e.ts_ms.max(0) as u64));
    }
    let mut rows: Vec<(usize, PaneActivity)> = latest
        .into_iter()
        .map(|(pane, (i, state, at))| (i, PaneActivity { pane, state, at }))
        .collect();
    rows.sort_by_key(|(i, _)| std::cmp::Reverse(*i)); // newest line first
    rows.into_iter().map(|(_, r)| r).collect()
}

/// The deduped set of panes that self-reported `done` via `bsc-done` (#1379) — the `bsc logs
/// done-panes` shape the desktop's `read_done_panes` command returned — newest line first. Missing
/// log ⇒ empty.
pub fn done_panes(dir: &Path) -> Vec<String> {
    use std::collections::HashMap;
    let mut latest: HashMap<String, usize> = HashMap::new();
    for (i, e) in read_stream(dir, "done").into_iter().enumerate() {
        if e.session.is_empty() {
            continue;
        }
        latest.insert(e.session, i);
    }
    let mut rows: Vec<(usize, String)> = latest.into_iter().map(|(p, i)| (i, p)).collect();
    rows.sort_by_key(|(i, _)| std::cmp::Reverse(*i)); // newest line first
    rows.into_iter().map(|(_, p)| p).collect()
}

/// The role implied by a pane-id (the `paneIdentity.ts` grammar).
pub fn role_of(session: &str) -> &'static str {
    if session.starts_with("planning_") {
        "planner"
    } else if session.starts_with("man:") {
        "manual"
    } else if session.ends_with(":director") {
        "director"
    } else if session.ends_with(":triage") {
        "triage"
    } else if session.contains(':') {
        "worker"
    } else {
        "session"
    }
}

/// The spend categories (#3814) — the `errordb` `STAGES`/`is_valid_stage` shape, so a future stamped
/// `category` column can validate against the same list.
pub const CATEGORIES: [&str; 2] = ["build", "run"];

/// Whether `c` is a valid spend category.
pub fn is_valid_category(c: &str) -> bool {
    CATEGORIES.contains(&c)
}

/// The spend CATEGORY a pane's session belongs to (#3814): `build` = the construction fleet — planner,
/// director, workers — constructing the project; `run` = everything else (triage operating the built
/// repo's issues, a manual/unknown console). Derived from the pane-id role, so no token-producer change
/// is needed. Mirrors `errordb`'s stage taxonomy (a validated category seam). Maintenance (a repurposed
/// worker pane) + a marketer launched as a `man:` pane don't yet have a distinct role and fall to
/// build/unattributed — a stamped-category refinement later.
pub fn category_of(session: &str) -> &'static str {
    match role_of(session) {
        "planner" | "director" | "worker" => "build",
        _ => "run",
    }
}

/// A one-line per-session rollup (the `bsc-logs sessions` entry point).
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SessionRow {
    pub session: String,
    pub role: &'static str,
    pub tools: usize,
    pub skills: usize,
    /// MCP calls attributed to this session (#1743 added the pane column to `mcp.log`). Legacy
    /// column-less lines stay unattributed (`"?"`) and don't count toward any session.
    pub mcp: usize,
    pub coord: usize,
    pub cost_usd: f64,
    /// Latest activity state (`run`/`idle`/`done`) for the session, or empty.
    pub activity: String,
}

/// Per-session rollup across every pane-tagged stream + cost, newest-active first.
pub fn sessions(dir: &Path) -> Vec<SessionRow> {
    use std::collections::BTreeMap;
    fn ensure<'a>(rows: &'a mut BTreeMap<String, SessionRow>, s: &str) -> &'a mut SessionRow {
        rows.entry(s.to_string()).or_insert_with(|| SessionRow {
            session: s.to_string(),
            role: role_of(s),
            tools: 0,
            skills: 0,
            mcp: 0,
            coord: 0,
            cost_usd: 0.0,
            activity: String::new(),
        })
    }
    let mut rows: BTreeMap<String, SessionRow> = BTreeMap::new();
    let mut last_act_ts: BTreeMap<String, i64> = BTreeMap::new();
    for e in read_stream(dir, "tool").into_iter().filter(|e| e.session != "?") {
        ensure(&mut rows, &e.session).tools += 1;
    }
    for e in read_stream(dir, "skill").into_iter().filter(|e| e.session != "?") {
        ensure(&mut rows, &e.session).skills += 1;
    }
    for e in read_stream(dir, "mcp").into_iter().filter(|e| e.session != "?") {
        ensure(&mut rows, &e.session).mcp += 1;
    }
    for e in read_stream(dir, "coord").into_iter().filter(|e| e.session != "?") {
        ensure(&mut rows, &e.session).coord += 1;
    }
    for e in read_stream(dir, "activity").into_iter().filter(|e| e.session != "?") {
        let last = last_act_ts.entry(e.session.clone()).or_insert(i64::MIN);
        if e.ts_ms >= *last {
            *last = e.ts_ms;
            ensure(&mut rows, &e.session).activity = e.summary.clone();
        } else {
            ensure(&mut rows, &e.session);
        }
    }
    for c in cost::all_costs(dir) {
        ensure(&mut rows, &c.session).cost_usd = c.cost_usd;
    }
    let mut out: Vec<SessionRow> = rows.into_values().collect();
    // Newest activity first, then heaviest, then id.
    out.sort_by(|a, b| {
        last_act_ts
            .get(&b.session)
            .cmp(&last_act_ts.get(&a.session))
            .then((b.tools + b.skills + b.mcp + b.coord).cmp(&(a.tools + a.skills + a.mcp + a.coord)))
            .then(a.session.cmp(&b.session))
    });
    out
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/divergence.rs, src/headroom.rs, src/instrument.rs, src/cli.rs, src/scope.rs, src/waiting.rs, src/coord.rs, src/deadlock.rs, src/wakes.rs, src/pending.rs, src/cost.rs, src/metrics.rs, src/perf.rs, src/pss.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get logs--<module>.rs
//     bsc graph impl set --id logs--<module>.rs --code-file <f>
//     bsc graph promote --id logs--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `logs--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
