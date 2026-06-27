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

use std::path::{Path, PathBuf};

pub mod cost;
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

/// The streams a `bsc-logs` query knows about, with their file + canonical name.
const STREAMS: &[(&str, &str)] = &[
    ("tool", "audit.log"),
    ("skill", "skills.log"),
    ("mcp", "mcp.log"),
    ("hook", "hooks.log"),
    ("activity", "activity.log"),
    ("done", "done.log"),
    ("coord", "coord.log"),
];

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
    let file = STREAMS.iter().find(|(s, _)| *s == stream).map(|(_, f)| *f);
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
        if streams.is_empty() { STREAMS.iter().map(|(s, _)| *s).collect() } else { streams.to_vec() };
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
}
