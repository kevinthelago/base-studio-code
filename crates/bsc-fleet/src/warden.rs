//! The warden's decision layer — who gets quarantined, decided beside the processes it quarantines.
//!
//! The always-on warden loop gathers each live worker's TRUSTED activity (`git diff --name-only` plus
//! the `bsc-audit` command log, never worker-ingested prose) and hard-pauses the ones that have
//! drifted off plan. Every resource in that sentence is Rust's: the PTY sessions, the worktrees, and
//! the audit log the pure-shell `bsc-*` helpers write. Only the decision ran in the renderer — and a
//! quarantine that stops happening when the webview dies is the exact failure the idle reaper taught
//! this project, with an enforcement action attached instead of a session count.
//!
//! # The conformance verdict is an INPUT, and that is deliberate
//!
//! `plan_warden` does not reimplement `checkConformance`. Its file-lane arm needs the glob engine that
//! `the-two-write-scope-glob-engines-disagree` has BLOCKED on a maintainer decision, and a second
//! implementation of a matcher two implementations already disagree about would make that worse. The
//! verdict enters as a value, the same treatment the file-glob matcher gets in `logs::deadlock`.
//!
//! # Three things here are load-bearing for a reason that is not obvious
//!
//! * [`zip_worktree_changes`] re-attaches a BATCHED worktree-diff result to the panes it was requested
//!   for, by INDEX. It is the one place a fleet-wide performance change could silently corrupt the
//!   warden's evidence: a short, long or misordered batch attributes one worker's changed files to
//!   another and quarantines the wrong session. A missing entry must degrade to "no signal" — never to
//!   a neighbour's files.
//! * [`parse_audit_commands`] carries a documented FAIL-OPEN. `since` drops rows logged before a
//!   relaunch, so a denied command from a prior run cannot re-quarantine a worker triage just
//!   restarted — but a row whose timestamp will not parse is KEPT. That choice is invisible to any
//!   corpus of well-formed ISO-8601, so it has its own case.
//! * [`warden_sweep_targets`] bounds the sweep to panes with a RUNNING session. The cost of getting it
//!   wrong is measured and on the record: the planned roster grew to 47 panes against 3 live
//!   terminals, ~94 serial git spawns inside one synchronous command, `pty_write` at 3280ms and
//!   `pty_resize` at 8279ms.
//!
//! Pinned against `warden.fixtures.json`, generated from the live TypeScript.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-warden-quarantines-from-rust-instead-of-the-render-loop`

use std::collections::{BTreeMap, HashSet};

/// Why a session tripped. `kind` is `out-of-glob` or `denied-command`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConformanceTrip {
    pub kind: String,
    pub detail: String,
}

/// The deterministic check's answer, supplied to [`plan_warden`] rather than recomputed here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConformanceVerdict {
    pub on_task: bool,
    pub trips: Vec<ConformanceTrip>,
}

/// One live worker the warden evaluates, with its verdict already computed.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardenSession {
    pub pane_id: String,
    pub stream_id: String,
    pub verdict: ConformanceVerdict,
}

/// A worker the warden decided to quarantine.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WardenTrip {
    pub pane_id: String,
    pub stream_id: String,
    pub trips: Vec<ConformanceTrip>,
    pub summary: String,
}

/// The wire shape of one worktree's diff. Kept SPLIT: the lane check reads `tracked` only, because an
/// untracked file has not entered the repo and cannot collide at integration — the only harm the lane
/// exists to prevent (#3983).
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct WorktreeChanges {
    #[serde(default)]
    pub tracked: Vec<String>,
    #[serde(default)]
    pub untracked: Vec<String>,
}

/// Condense trips into one human line for the quarantine banner and the mobile push body.
///
/// Derived only from trusted signals, so it is safe to surface and to send. The tail is a COUNT, not a
/// re-listing — a push body is not the place to enumerate a worker's every stray edit.
pub fn summarize_trips(trips: &[ConformanceTrip]) -> String {
    let Some(first) = trips.first() else { return "on plan".to_string() };
    let part = |t: &ConformanceTrip| -> String {
        if t.kind == "out-of-glob" {
            format!("edited out-of-lane {}", t.detail)
        } else {
            format!("ran denied `{}`", t.detail)
        }
    };
    let head = part(first);
    if trips.len() == 1 {
        head
    } else {
        format!("{head} (+{} more)", trips.len() - 1)
    }
}

/// Decide which sessions to quarantine this pass.
///
/// A trip is a ONE-SHOT hard pause, not a repeating alert, so an already-quarantined pane is skipped
/// rather than re-tripped.
pub fn plan_warden(sessions: &[WardenSession], already_quarantined: &HashSet<String>) -> Vec<WardenTrip> {
    sessions
        .iter()
        .filter(|s| !already_quarantined.contains(&s.pane_id))
        .filter(|s| !s.verdict.on_task)
        .map(|s| WardenTrip {
            pane_id: s.pane_id.clone(),
            stream_id: s.stream_id.clone(),
            trips: s.verdict.trips.clone(),
            summary: summarize_trips(&s.verdict.trips),
        })
        .collect()
}

/// Extract the shell commands a pane attempted from `bsc-audit` lines (`ts \t pane \t tool \t target`).
///
/// Only Bash-tool rows are commands. `since` (epoch ms, 0 = no floor) drops rows logged BEFORE it, so a
/// denied command from a prior run cannot re-quarantine a worker that triage just relaunched.
///
/// **An unparseable timestamp is KEPT.** That is the fail-open, and it is the safer direction for a
/// security filter: a row the floor cannot judge is treated as current rather than discarded.
pub fn parse_audit_commands(lines: &[String], pane_id: &str, since: i64) -> Vec<String> {
    lines
        .iter()
        .filter_map(|line| {
            let f: Vec<&str> = line.split('\t').collect();
            if f.len() < 4 {
                return None;
            }
            let (ts, pane, tool, target) = (f[0], f[1], f[2], f[3]);
            if pane != pane_id || tool.trim().to_lowercase() != "bash" || target.trim().is_empty() {
                return None;
            }
            if since > 0 {
                // Only a PARSEABLE timestamp can exclude a row; see the fail-open above.
                if let Some(at) = parse_iso8601_ms(ts) {
                    if at < since {
                        return None;
                    }
                }
            }
            Some(target.trim().to_string())
        })
        .collect()
}

/// Parse the `bsc-audit` timestamp — `date -u +%Y-%m-%dT%H:%M:%SZ`, always UTC, second precision.
///
/// Returns `None` for anything that does not match, which is what makes the fail-open above a fail-OPEN
/// rather than a silent drop. Deliberately narrow: this reads one writer's output, and accepting more
/// shapes than that writer emits would only widen what the floor silently accepts.
fn parse_iso8601_ms(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' || b[19] != b'Z' {
        return None;
    }
    let n = |a: usize, z: usize| ts.get(a..z)?.parse::<i64>().ok();
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (h, mi, s) = (n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    // Days from the civil calendar to the Unix epoch (Howard Hinnant's days_from_civil).
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 86_400) + h * 3600 + mi * 60 + s) * 1000)
}

/// Zip a batched worktree-diff result back onto the panes it was requested for.
///
/// **INDEX-ALIGNED, and that is the whole risk.** A short, long or misordered batch must never
/// attribute one worker's changed files to another — that quarantines the wrong session. A missing
/// entry degrades to "no file signal", exactly as a failed single-pane read did before batching.
///
/// Reads `tracked` only (#3983): merging in untracked paths made a `.agentscratch.txt`
/// indistinguishable from an out-of-lane source edit, and the warden killed four workers that had zero
/// tracked changes between them.
pub fn zip_worktree_changes(
    panes: &[String],
    changes: &[Option<WorktreeChanges>],
) -> BTreeMap<String, Vec<String>> {
    panes
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let files = changes
                .get(i)
                .and_then(|c| c.as_ref())
                .map(|c| c.tracked.clone())
                .unwrap_or_default();
            (p.clone(), files)
        })
        .collect()
}

/// The panes a warden sweep should actually probe: those with a RUNNING session, minus completed
/// streams.
///
/// A pane with no session cannot be drifting — the warden watches what a running worker does to its
/// worktree, and there is nothing to watch when nothing is running. See the module header for what the
/// unbounded version cost.
pub fn warden_sweep_targets(
    panes: &[String],
    live: &HashSet<String>,
    completed: &HashSet<String>,
) -> Vec<String> {
    panes
        .iter()
        .filter(|p| live.contains(*p) && !completed.contains(*p))
        .cloned()
        .collect()
}

/// One tab's pane roster.
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabPanes {
    #[serde(default)]
    pub pane_ids: Vec<String>,
}

/// The live pane set: present in a tab, neither ended nor disabled.
///
/// The same definition Glance and the launch pump use, so all three agree on whether a session exists.
/// Returned sorted — a SET has no order, and materialising one invites a caller to depend on it.
pub fn live_pane_ids_of(
    tabs: &[TabPanes],
    ended: &HashSet<String>,
    disabled: &HashSet<String>,
) -> Vec<String> {
    let mut out: Vec<String> = tabs
        .iter()
        .flat_map(|t| t.pane_ids.iter())
        .filter(|p| !p.is_empty() && !ended.contains(*p) && !disabled.contains(*p))
        .cloned()
        .collect();
    out.sort_unstable();
    out.dedup();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("warden.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one warden.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn set(v: &serde_json::Value) -> HashSet<String> {
        v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn the_trip_summary_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["summaries"].as_array().unwrap();
        assert!(cases.len() >= 6, "corpus shrank to {}", cases.len());
        let mut bad = Vec::new();
        for c in cases {
            let trips: Vec<ConformanceTrip> = serde_json::from_value(c["trips"].clone()).unwrap();
            let want = c["summary"].as_str().unwrap();
            let got = summarize_trips(&trips);
            if got != want {
                bad.push(format!("  {}\n    ts   {want:?}\n    rust {got:?}", c["label"].as_str().unwrap()));
            }
        }
        assert!(bad.is_empty(), "{} mismatch(es):\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn the_quarantine_set_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["plans"].as_array().unwrap();
        assert!(cases.len() >= 10, "corpus shrank to {}", cases.len());
        let mut bad = Vec::new();
        let (mut saw_none, mut saw_many) = (false, false);
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let sessions: Vec<WardenSession> = serde_json::from_value(c["sessions"].clone())
                .unwrap_or_else(|e| panic!("{label}: sessions did not deserialize: {e}"));
            let want: Vec<WardenTrip> = serde_json::from_value(c["trips"].clone()).unwrap();
            let got = plan_warden(&sessions, &set(&c["quarantined"]));
            if got.is_empty() {
                saw_none = true;
            }
            if got.len() > 1 {
                saw_many = true;
            }
            if got != want {
                bad.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(saw_none, "no case quarantines nobody");
        assert!(saw_many, "no case quarantines more than one — the ORDER is untested");
        assert!(bad.is_empty(), "{} mismatch(es):\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn the_audit_command_extraction_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["audits"].as_array().unwrap();
        assert!(cases.len() >= 14, "corpus shrank to {}", cases.len());
        let mut bad = Vec::new();
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let lines: Vec<String> = serde_json::from_value(c["lines"].clone()).unwrap();
            let want: Vec<String> = serde_json::from_value(c["commands"].clone()).unwrap();
            let got = parse_audit_commands(&lines, c["paneId"].as_str().unwrap(), c["since"].as_i64().unwrap());
            if got != want {
                bad.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(bad.is_empty(), "{} mismatch(es):\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn the_worktree_zip_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["zips"].as_array().unwrap();
        assert!(cases.len() >= 9, "corpus shrank to {}", cases.len());
        let mut bad = Vec::new();
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let panes: Vec<String> = serde_json::from_value(c["panes"].clone()).unwrap();
            let changes: Vec<Option<WorktreeChanges>> =
                serde_json::from_value(c["changes"].clone()).unwrap();
            // Compared as a MAPPING, not a list: the caller looks panes up by id, and a map has no
            // order to preserve. What must hold is which files reach which pane.
            let want: BTreeMap<String, Vec<String>> = c["zipped"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| {
                    (
                        e["paneId"].as_str().unwrap().to_string(),
                        serde_json::from_value(e["files"].clone()).unwrap(),
                    )
                })
                .collect();
            let got = zip_worktree_changes(&panes, &changes);
            if got != want {
                bad.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }
        assert!(bad.is_empty(), "{} mismatch(es):\n{}", bad.len(), bad.join("\n"));
    }

    #[test]
    fn the_sweep_targets_and_live_set_match_the_typescript() {
        let doc = fixture();
        let mut bad = Vec::new();
        for c in doc["sweeps"].as_array().unwrap() {
            let panes: Vec<String> = serde_json::from_value(c["panes"].clone()).unwrap();
            let want: Vec<String> = serde_json::from_value(c["targets"].clone()).unwrap();
            let got = warden_sweep_targets(&panes, &set(&c["live"]), &set(&c["completed"]));
            if got != want {
                bad.push(format!("  sweep {}\n    ts   {want:?}\n    rust {got:?}", c["label"].as_str().unwrap()));
            }
        }
        for c in doc["lives"].as_array().unwrap() {
            let tabs: Vec<TabPanes> = serde_json::from_value(c["tabs"].clone()).unwrap();
            // A SET has no order; both sides are sorted before comparison.
            let mut want: Vec<String> = serde_json::from_value(c["livePanes"].clone()).unwrap();
            want.sort();
            let got = live_pane_ids_of(&tabs, &set(&c["ended"]), &set(&c["disabled"]));
            if got != want {
                bad.push(format!("  live {}\n    ts   {want:?}\n    rust {got:?}", c["label"].as_str().unwrap()));
            }
        }
        assert!(bad.is_empty(), "{} mismatch(es):\n{}", bad.len(), bad.join("\n"));
    }

    // ── The invariants a parity corpus cannot state ─────────────────────────────

    fn wc(tracked: &[&str], untracked: &[&str]) -> Option<WorktreeChanges> {
        Some(WorktreeChanges {
            tracked: tracked.iter().map(|s| s.to_string()).collect(),
            untracked: untracked.iter().map(|s| s.to_string()).collect(),
        })
    }
    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// THE ONE THAT MATTERS. A misaligned batch must degrade to no signal, never to a neighbour's
    /// files — attributing one worker's changes to another quarantines the wrong session.
    #[test]
    fn a_malformed_batch_never_attributes_one_workers_files_to_another() {
        let panes = ids(&["p:a", "p:b", "p:c"]);

        // Short: b and c get nothing. NOT a's files shifted along.
        let short = zip_worktree_changes(&panes, &[wc(&["a.ts"], &[])]);
        assert_eq!(short["p:a"], vec!["a.ts".to_string()]);
        assert!(short["p:b"].is_empty() && short["p:c"].is_empty(), "a short batch degrades to no signal");

        // A hole: b gets nothing, and c is NOT pulled forward into b's slot.
        let holed = zip_worktree_changes(&panes, &[wc(&["a.ts"], &[]), None, wc(&["c.ts"], &[])]);
        assert!(holed["p:b"].is_empty(), "a hole is no signal");
        assert_eq!(holed["p:c"], vec!["c.ts".to_string()], "and does not shift its successor");

        // Long: the surplus entry belongs to nobody.
        let long = zip_worktree_changes(&ids(&["p:a"]), &[wc(&["a.ts"], &[]), wc(&["ghost.ts"], &[])]);
        assert_eq!(long.len(), 1);
        assert_eq!(long["p:a"], vec!["a.ts".to_string()]);

        // Every pane asked about is answered, exactly once, whatever the batch looked like.
        for case in [&short, &holed] {
            assert_eq!(case.len(), panes.len(), "every pane gets exactly one answer");
        }
    }

    /// #3983: an untracked file is not lane drift. Merging the lists made `.agentscratch.txt`
    /// indistinguishable from an out-of-lane source edit and killed four workers with zero tracked
    /// changes between them.
    #[test]
    fn untracked_paths_are_not_evidence() {
        let z = zip_worktree_changes(&ids(&["p:a"]), &[wc(&[], &[".agentscratch.txt", "out.log"])]);
        assert!(z["p:a"].is_empty(), "untracked alone is no evidence at all");

        let mixed = zip_worktree_changes(&ids(&["p:a"]), &[wc(&["real.ts"], &["scratch.txt"])]);
        assert_eq!(mixed["p:a"], vec!["real.ts".to_string()], "and never rides along with tracked");
    }

    /// The fail-open, stated as an invariant rather than left to one fixture row: only a timestamp
    /// that PARSES may exclude a row.
    #[test]
    fn only_a_parseable_timestamp_can_be_excluded_by_the_floor() {
        let since = parse_iso8601_ms("2026-09-01T12:30:00Z").expect("the floor itself must parse");
        let cmd = |ts: &str| vec![format!("{ts}\tp\tBash\tgh repo delete acme/x")];

        assert!(parse_audit_commands(&cmd("2026-09-01T12:00:00Z"), "p", since).is_empty(), "before the floor");
        assert_eq!(parse_audit_commands(&cmd("2026-09-01T13:00:00Z"), "p", since).len(), 1, "after it");
        assert_eq!(parse_audit_commands(&cmd("2026-09-01T12:30:00Z"), "p", since).len(), 1, "AT it — strictly before");

        for junk in ["not-a-date", "", "2026-09-01", "2026-13-01T00:00:00Z", "2026-09-01T25:00:00Z"] {
            assert_eq!(
                parse_audit_commands(&cmd(junk), "p", since).len(),
                1,
                "{junk:?}: an unjudgeable timestamp is KEPT — the filter fails open"
            );
        }
        // And with no floor at all, nothing is dropped for age.
        assert_eq!(parse_audit_commands(&cmd("1999-01-01T00:00:00Z"), "p", 0).len(), 1);
    }

    /// The pane match is EQUALITY, and it has to be.
    ///
    /// Found by a divergence that did NOT bite: switching to `starts_with` passed every test I had,
    /// because no pane id in the corpus was a prefix of another. A prefix match lets `p:api` collect
    /// `p:api-2`'s commands and be quarantined for a neighbour's behaviour — the same misattribution
    /// `zip_worktree_changes` is carefully guarded against on the file side, unwatched on the command
    /// side. Pane ids genuinely nest: `<key>:<stream>` sits beside `<key>:<stream>-2`, and the
    /// positional form `t0p1` beside `t0p10`.
    #[test]
    fn one_pane_never_collects_a_neighbours_commands() {
        let lines = vec![
            "2026-09-01T12:00:00Z\tp:api-2\tBash\tgh repo delete acme/x".to_string(),
            "2026-09-01T12:00:00Z\tp:api\tBash\tgit status".to_string(),
        ];
        assert_eq!(parse_audit_commands(&lines, "p:api", 0), vec!["git status".to_string()]);
        assert_eq!(parse_audit_commands(&lines, "p:api-2", 0), vec!["gh repo delete acme/x".to_string()]);

        // The positional form nests the same way.
        let pos = vec![
            "2026-09-01T12:00:00Z\tt0p10\tBash\tgh pr merge 9".to_string(),
            "2026-09-01T12:00:00Z\tt0p1\tBash\tgit diff".to_string(),
        ];
        assert_eq!(parse_audit_commands(&pos, "t0p1", 0), vec!["git diff".to_string()]);
    }

    /// The epoch conversion is the only arithmetic here, and a wrong one silently shifts the floor.
    #[test]
    fn the_timestamp_parser_agrees_with_known_epochs() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2000-01-01T00:00:00Z"), Some(946_684_800_000));
        assert_eq!(parse_iso8601_ms("2024-02-29T12:34:56Z"), Some(1_709_210_096_000), "a leap day");
        assert_eq!(parse_iso8601_ms("2026-09-01T12:00:00Z"), Some(1_788_264_000_000));
        assert!(parse_iso8601_ms("2026-09-01T12:00:00").is_none(), "no Z");
        assert!(parse_iso8601_ms("2026-09-01T12:00:00+01:00").is_none(), "an offset is not this writer");
    }

    /// A trip is a one-shot hard pause, not a repeating alert.
    #[test]
    fn an_already_quarantined_pane_is_never_re_tripped() {
        let drifted = WardenSession {
            pane_id: "p:a".into(),
            stream_id: "a".into(),
            verdict: ConformanceVerdict {
                on_task: false,
                trips: vec![ConformanceTrip { kind: "out-of-glob".into(), detail: "x.ts".into() }],
            },
        };
        assert_eq!(plan_warden(std::slice::from_ref(&drifted), &HashSet::new()).len(), 1);
        assert!(
            plan_warden(&[drifted], &HashSet::from(["p:a".to_string()])).is_empty(),
            "already quarantined — a trip does not repeat"
        );
    }

    /// The verdict is an INPUT. Nothing here may re-decide conformance, because the glob engine it
    /// would need is the one two implementations already disagree about
    /// (`the-two-write-scope-glob-engines-disagree`). This test is the guard on that boundary: an
    /// on-task verdict is honoured even when the activity looks alarming, and vice versa.
    #[test]
    fn the_conformance_verdict_is_obeyed_not_second_guessed() {
        let on_task = WardenSession {
            pane_id: "p:a".into(),
            stream_id: "a".into(),
            verdict: ConformanceVerdict { on_task: true, trips: vec![] },
        };
        assert!(plan_warden(&[on_task], &HashSet::new()).is_empty(), "on-task is on-task");

        // on_task=false with NO trips: the verdict, not the trip list, is what decides.
        let bare = WardenSession {
            pane_id: "p:b".into(),
            stream_id: "b".into(),
            verdict: ConformanceVerdict { on_task: false, trips: vec![] },
        };
        let got = plan_warden(&[bare], &HashSet::new());
        assert_eq!(got.len(), 1, "a false verdict quarantines even with an empty trip list");
        assert_eq!(got[0].summary, "on plan", "and the summary reports what it was actually given");
    }

    /// A pane with no session cannot be drifting — and the sweep is bounded by the ROSTER, so a live
    /// id that is not on it never becomes a target.
    #[test]
    fn the_sweep_is_bounded_by_both_the_roster_and_liveness() {
        let panes = ids(&["p:a", "p:b"]);
        let all = HashSet::from(["p:a".to_string(), "p:b".into(), "p:ghost".into()]);
        assert_eq!(warden_sweep_targets(&panes, &all, &HashSet::new()), panes, "the roster bounds it");
        assert_eq!(
            warden_sweep_targets(&panes, &HashSet::from(["p:a".to_string()]), &HashSet::new()),
            ids(&["p:a"]),
            "a planned pane with no session is not swept"
        );
        assert!(
            warden_sweep_targets(&panes, &all, &HashSet::from(["p:a".to_string(), "p:b".into()])).is_empty(),
            "a completed stream is not swept"
        );
    }
}
