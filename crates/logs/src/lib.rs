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

pub mod cli;
pub mod scope;

use std::path::{Path, PathBuf};

pub mod cost;
pub mod metrics;
pub use cost::Cost;

pub mod perf;
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
        "coord" => Some("coord"),
        "perm" | "perms" | "deny" | "denials" => Some("perm"),
        // UI-design activity (#2525): `bsc logs tail ui` — the designer session's `ui-touch` stream.
        "ui" => Some("ui"),
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
    let text = std::fs::read_to_string(dir.join(file)).unwrap_or_default();
    let mut lines: Vec<String> =
        text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if !oldest {
        lines.reverse();
        lines.truncate(limit);
    } else if lines.len() > limit {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir()
            .join(format!("bsc-logs-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn to_ms_handles_iso_and_epoch() {
        assert_eq!(to_ms("0"), Some(0));
        assert_eq!(to_ms("1782468293294"), Some(1782468293294));
        // 1970-01-01T00:00:01Z = 1000 ms; a known later date round-trips through both forms.
        assert_eq!(to_ms("1970-01-01T00:00:01Z"), Some(1000));
        assert_eq!(to_ms("2026-06-26T10:04:59Z"), Some(1782468299000));
        assert_eq!(to_ms("not-a-time"), None);
    }

    #[test]
    fn parses_each_stream_and_tags_pane() {
        let d = tmp();
        std::fs::write(d.join("audit.log"), "2026-06-26T10:00:00Z\tk:ui\tRead\tCLAUDE.local.md\n").unwrap();
        std::fs::write(d.join("skills.log"), "2026-06-26T10:00:01Z\tk:ui\tPreToolUse\tcompliance-docs\n").unwrap();
        std::fs::write(d.join("coord.log"), "2026-06-26T10:00:02Z\tk:ui\tlanded\t\t\n").unwrap();
        std::fs::write(d.join("activity.log"), "1782468001000\tk:ui\trun\n").unwrap();
        // #1743: a new pane-tagged mcp line + a legacy column-less one must BOTH parse.
        std::fs::write(
            d.join("mcp.log"),
            "1782468000000\tk:ui\tResearch\tsearch\tok\t240\t-\n1782468000001\tResearch\tsearch\tok\t99\t-\n",
        ).unwrap();

        let tool = &read_stream(&d, "tool")[0];
        assert_eq!((tool.session.as_str(), tool.stream), ("k:ui", "tool"));
        assert!(tool.summary.starts_with("Read"));
        let skill = &read_stream(&d, "skill")[0];
        assert_eq!(skill.summary, "compliance-docs (PreToolUse)");
        // New line: pane attributes to its session; the summary still renders server/tool/outcome/ms.
        let mcp = read_stream(&d, "mcp");
        assert_eq!(mcp[0].session, "k:ui");
        assert_eq!(mcp[0].summary, "Research/search ok 240ms");
        // Legacy line (no pane column): unattributed "?", still parsed without a panic.
        assert_eq!(mcp[1].session, "?");
        assert_eq!(mcp[1].summary, "Research/search ok 99ms");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parses_both_hook_line_shapes() {
        // #1743: hooks.log gained a leading pane column. A new pane-tagged line attributes to its
        // session; a legacy column-less line stays unattributed ("?"). Both must parse — neither panics.
        let d = tmp();
        std::fs::write(
            d.join("hooks.log"),
            // new: ts·pane·event·name·outcome  ·  legacy: ts·event·name·outcome
            "1782468000000\tk:web\tPreToolUse\tBlock PII\tblock\n1782468000001\tPostToolUse\tAuto-format\tok\n",
        ).unwrap();

        let hooks = read_stream(&d, "hook");
        assert_eq!(hooks[0].session, "k:web");
        assert_eq!(hooks[0].summary, "PreToolUse Block PII block");
        assert_eq!(hooks[0].fields, vec!["PreToolUse", "Block PII", "block"]);
        assert_eq!(hooks[1].session, "?");
        assert_eq!(hooks[1].summary, "PostToolUse Auto-format ok");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn parses_perm_denials_and_tags_pane() {
        // #1607 slice 2: perm.log is ts·pane·gate·verdict·target·reason — one row per deny-hook block.
        // The Rust bash-deny writes epoch-ms ts; the shell hooks write epoch-ms too — both parse.
        let d = tmp();
        std::fs::write(
            d.join("perm.log"),
            "1782468000000\tk:web\tscope\tblock\tsrc/App.tsx\toutside the write scope\n\
             1782468000001\tk:web\tdeny\tblock\tgit push --force\tthe built-in dangerous-command floor\n",
        ).unwrap();

        let perm = read_stream(&d, "perm");
        assert_eq!(perm.len(), 2);
        assert_eq!(perm[0].session, "k:web");
        assert_eq!(perm[0].stream, "perm");
        assert_eq!(perm[0].summary, "scope block src/App.tsx");
        assert_eq!(perm[0].fields, vec!["scope", "block", "src/App.tsx", "outside the write scope"]);
        assert_eq!(perm[1].summary, "deny block git push --force");
        // The alias resolves to the canonical stream.
        assert_eq!(canonical_stream("denials"), Some("perm"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn query_filters_by_session_since_and_limit() {
        let d = tmp();
        std::fs::write(d.join("audit.log"), concat!(
            "2026-06-26T10:00:00Z\tk:a\tRead\tx\n",
            "2026-06-26T10:00:05Z\tk:b\tRead\ty\n",
            "2026-06-26T10:00:10Z\tk:a\tBash\tls\n",
        )).unwrap();
        std::fs::write(d.join("mcp.log"), "1782468000000\tS\tt\tok\t1\t-\n").unwrap();

        // session filter drops k:b AND the unattributable mcp "?" event.
        let a = query(&d, &[], Some("k:a"), None, None);
        assert_eq!(a.len(), 2);
        assert!(a.iter().all(|e| e.session == "k:a"));
        // ascending order
        assert!(a[0].ts_ms < a[1].ts_ms);
        // since drops the first
        let since = query(&d, &["tool"], Some("k:a"), Some(to_ms("2026-06-26T10:00:06Z").unwrap()), None);
        assert_eq!(since.len(), 1);
        // limit keeps the newest
        let lim = query(&d, &["tool"], None, None, Some(1));
        assert_eq!(lim.len(), 1);
        assert_eq!(lim[0].session, "k:a"); // the 10:00:10 Bash line
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn tail_raw_returns_newest_or_oldest_raw_lines() {
        // `bsc logs tail` (#2144): the newest `limit` raw lines. Default newest-first (audit/skill/
        // hook/mcp); `oldest=true` keeps chronological order (coord). Blank lines dropped; an unknown
        // alias or missing file ⇒ empty.
        let d = tmp();
        std::fs::write(d.join("audit.log"), "2026-06-26T10:00:00Z\tk\tRead\ta\n\n2026-06-26T10:00:01Z\tk\tRead\tb\n2026-06-26T10:00:02Z\tk\tRead\tc\n").unwrap();
        // newest-first, limit 2 (the blank line is dropped).
        let newest = tail_raw(&d, "audit", 2, false);
        assert_eq!(newest.len(), 2);
        assert!(newest[0].ends_with("Read\tc") && newest[1].ends_with("Read\tb"));
        // oldest-first (coord convention): newest 2 in chronological order.
        std::fs::write(d.join("coord.log"), "2026-06-26T10:00:00Z\tk\tlanded\t\t\n2026-06-26T10:00:01Z\tk\tmerged\t\t\n2026-06-26T10:00:02Z\tk\tclosed\t\t\n").unwrap();
        let oldest = tail_raw(&d, "coord", 2, true);
        assert_eq!(oldest.len(), 2);
        assert!(oldest[0].contains("merged") && oldest[1].contains("closed"));
        // Unknown alias / missing file ⇒ empty, never a panic.
        assert!(tail_raw(&d, "nope", 5, false).is_empty());
        assert!(tail_raw(&d, "hooks", 5, false).is_empty()); // hooks.log absent
        // UI-activity stream (#2525): `bsc logs tail ui` reads ui-activity.log oldest-first (the
        // Design Studio replays it chronologically to find the most-recent touch).
        assert_eq!(canonical_stream("ui"), Some("ui"));
        std::fs::write(d.join("ui-activity.log"), "2026-06-26T10:00:00Z\tp\tui-touch\tcomponent\tbutton\n2026-06-26T10:00:01Z\tp\tui-touch\ttheme\tneon\n").unwrap();
        let ui = tail_raw(&d, "ui", 5, true);
        assert_eq!(ui.len(), 2);
        assert!(ui[0].ends_with("component\tbutton") && ui[1].ends_with("theme\tneon"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn pane_activity_keeps_newest_run_idle_state_per_pane() {
        let d = tmp();
        std::fs::write(d.join("activity.log"), concat!(
            "100\tp1\trun\n",
            "150\tp2\trun\n",
            "bad line with no tabs\n", // dropped by the stream parser
            "200\tp1\tidle\n",         // supersedes p1's run
            "250\tp3\tbogus\n",        // dropped: unknown state
            "260\t\trun\n",            // dropped: empty pane
            "300\tp1\trun\n",          // newest line for p1
        )).unwrap();
        let rows = pane_activity(&d);
        let got: Vec<(&str, &str, u64)> = rows.iter().map(|r| (r.pane.as_str(), r.state.as_str(), r.at)).collect();
        assert_eq!(got, vec![("p1", "run", 300), ("p2", "run", 150)], "newest line first; bad lines dropped");
        assert!(pane_activity(&tmp()).is_empty(), "missing log ⇒ empty");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn done_panes_dedupes_newest_first() {
        let d = tmp();
        std::fs::write(d.join("done.log"), concat!(
            "100\tproj:api\n",
            "150\tproj:web\n",
            "noTabHere\n",     // dropped
            "200\tproj:api\n", // proj:api seen again — newest line wins for ordering
            "250\t\n",         // dropped: empty pane
        )).unwrap();
        assert_eq!(done_panes(&d), vec!["proj:api".to_string(), "proj:web".to_string()]);
        assert!(done_panes(&tmp()).is_empty(), "missing log ⇒ empty");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn sessions_rollup_counts_and_roles() {
        let d = tmp();
        std::fs::write(d.join("audit.log"), "2026-06-26T10:00:00Z\tk:ui\tRead\tx\n2026-06-26T10:00:01Z\tk:ui\tBash\tls\n").unwrap();
        std::fs::write(d.join("skills.log"), "2026-06-26T10:00:02Z\tk:ui\tPreToolUse\tsk\n").unwrap();
        std::fs::write(d.join("activity.log"), "1782468000000\tk:director\tidle\n").unwrap();
        // #1743: a pane-tagged mcp call attributes to k:ui; a legacy column-less line stays
        // unattributed and must NOT count toward any session's mcp total.
        std::fs::write(
            d.join("mcp.log"),
            "1782468000000\tk:ui\tGitHub\tlist_issues\tok\t120\t-\n1782468000001\tGitHub\tlist_issues\tok\t80\t-\n",
        ).unwrap();
        let rows = sessions(&d);
        let ui = rows.iter().find(|r| r.session == "k:ui").unwrap();
        assert_eq!((ui.tools, ui.skills, ui.mcp, ui.role), (2, 1, 1, "worker"));
        // The legacy "?" mcp line is never rolled into a session row.
        assert!(rows.iter().all(|r| r.session != "?"), "unattributed mcp must not create a row");
        let dir = rows.iter().find(|r| r.session == "k:director").unwrap();
        assert_eq!((dir.role, dir.activity.as_str()), ("director", "idle"));
        assert_eq!(role_of("planning_demo"), "planner");
        assert_eq!(role_of("man:t1:p0"), "manual");
        assert_eq!(role_of("k:web/api:triage"), "triage");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn category_of_splits_build_from_run() {
        // #3814: the construction fleet is BUILD; triage/manual/unknown is RUN.
        assert_eq!(category_of("planning_demo"), "build"); // planner
        assert_eq!(category_of("shop:director"), "build");
        assert_eq!(category_of("shop:api"), "build"); // a worker (has a `:`, no director/triage suffix)
        assert_eq!(category_of("shop:web:triage"), "run"); // operates the built repo
        assert_eq!(category_of("man:t1:p0"), "run"); // a manual console
        assert_eq!(category_of("bare"), "run"); // unknown → not build
        assert!(is_valid_category("build") && is_valid_category("run") && !is_valid_category("nope"));
    }
}
