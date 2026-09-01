//! The stop ledger — why each pane stopped, and whether that was a fault.
//!
//! # Rust supplied every fact and judged none of them
//!
//! [`super::pump`] emits `pty_exit_<pane>` already knowing the exit code, the signal, and whether the
//! cage launcher died before the agent ever ran; it phrases the `detail`; it sanitizes and bounds the
//! last output. What ran in the renderer was the JUDGEMENT on those facts, and the ledger holding them.
//!
//! # The routine/fault split is the whole feature
//!
//! Every session ends eventually, so a notice that fires on all of them is one the user learns to
//! ignore — and the real failures hide among them. Five reasons are routine and five are faults, and
//! `finished` in particular is a SUCCESS: an agent that completed its work must never read as a fault.
//!
//! # Two ledger rules, both from a measured incident
//!
//! * REPLACE PER PANE, never stack. The reported worker stopped NINE times in one run; nine notices
//!   for one pane is the same information nine times over while whatever else stopped scrolls out of
//!   reach. The newest answer for a pane is the one worth showing.
//! * BOUNDED and time-windowed. A fleet relaunch can stop a dozen panes at once, and this is transient
//!   state on a hot path.
//!
//! The clock is a PARAMETER, never read here, so expiry is testable without waiting.
//!
//! # The log line lives here because the log does
//!
//! `crates/logs` owns the app log, and this line is what answers the question after the five-second
//! banner is gone. For a fault it states `(printed nothing)` rather than leaving an absence — a session
//! that died silently is itself the finding, which is exactly the shape of an unexplained SIGKILL.
//!
//! # Not here
//!
//! The banner's TONE and its lead HEADLINE are not ported. They are colour and user-facing phrasing —
//! the one part of this module that legitimately belongs to the renderer.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it.
#![allow(dead_code)] // wired by `the-launch-records-its-own-stops-instead-of-reporting-them`

/// Why a pane stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    /// Exit 0 — the agent completed. NOT a fault.
    Finished,
    /// A non-zero exit from whatever ran.
    Failed,
    /// Killed by a fatal signal (the shell's 128+N).
    Signalled,
    /// bwrap / systemd-run died before the agent started.
    LauncherFailed,
    /// `pty_kill`, a project teardown, app exit.
    AppClosed,
    /// The pty closed and the status could not be read.
    Unknown,
    /// The idle reaper reclaimed it (#849).
    Reaped,
    /// The worker finished its lane and auto-ended (#920).
    AutoEnded,
    /// The warden hard-paused it (#1102).
    Quarantined,
    /// The pane was switched off — by the user, or the boot GC.
    Disabled,
}

/// Stops that are NORMAL — a session that finished, or one the app/user deliberately closed.
const ROUTINE: &[StopReason] = &[
    StopReason::Finished,
    StopReason::AppClosed,
    StopReason::AutoEnded,
    StopReason::Reaped,
    StopReason::Disabled,
];

/// Is this stop something that went WRONG, as opposed to a session ending normally?
pub fn is_fault_stop(reason: StopReason) -> bool {
    !ROUTINE.contains(&reason)
}

/// One stop, as the banner shows it and the log records it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneStop {
    pub pane_id: String,
    pub reason: StopReason,
    /// One sentence, already phrased for a human.
    pub detail: String,
    /// Epoch ms.
    pub at: i64,
    /// What the session last PRINTED, when it ended badly. Only ever set for a fault — quoting a clean
    /// session's output is how the notice becomes noise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_output: Option<String>,
}

/// How long a stop notice stays on screen. INFORMATIONAL, so it never waits for a click; the log line
/// is what makes the short life affordable.
pub const STOP_NOTICE_MS: i64 = 5_000;

/// How many stops the ledger keeps — a safety floor, well above what is legible in five seconds.
pub const MAX_STOPS: usize = 12;

/// Append a stop, REPLACING any earlier one for the same pane, and drop what has expired.
pub fn record_stop(list: &[PaneStop], stop: PaneStop, now: i64) -> Vec<PaneStop> {
    let mut out: Vec<PaneStop> = list
        .iter()
        .filter(|s| s.pane_id != stop.pane_id && now - s.at < STOP_NOTICE_MS)
        .cloned()
        .collect();
    out.push(stop);
    // Keep the LAST `MAX_STOPS`, matching `slice(-MAX_STOPS)`: the newest survive a flood.
    if out.len() > MAX_STOPS {
        out.drain(..out.len() - MAX_STOPS);
    }
    out
}

/// The stops still inside their notice window, newest first — what the banner renders.
pub fn active_stops(list: &[PaneStop], now: i64) -> Vec<PaneStop> {
    let mut out: Vec<PaneStop> =
        list.iter().filter(|s| now - s.at < STOP_NOTICE_MS).cloned().collect();
    // STABLE, so equal timestamps keep insertion order — the same guarantee the source's sort gives.
    // `sort_by_key` with `Reverse` rather than a comparator: clippy's preference, and it keeps the
    // stability the ordering rests on.
    out.sort_by_key(|s| std::cmp::Reverse(s.at));
    out
}

/// The single line written to the app log for a stop. Always written, whether or not a banner was on
/// screen.
pub fn stop_log_line(stop: &PaneStop) -> String {
    let reason = serde_json::to_value(stop.reason)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default();
    let base = format!("pane[{}] stopped · {} · {}", stop.pane_id, reason, stop.detail);
    if !is_fault_stop(stop.reason) {
        return base;
    }
    // "printed nothing" is STATED rather than left as an absence.
    let last = stop.last_output.as_deref().unwrap_or("(printed nothing)");
    format!("{base} · last output: {last}")
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
                } else if p.file_name().and_then(|n| n.to_str()) == Some("stopLedger.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one stopLedger.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn stops(v: &serde_json::Value) -> Vec<PaneStop> {
        serde_json::from_value(v.clone()).expect("stops")
    }

    /// Every reason's judgement AND its log line, plus every ledger scenario. Reports all mismatches
    /// at once — a wrong routine/fault split is wrong for a whole CLASS of stop.
    #[test]
    fn the_stop_ledger_matches_the_typescript_case_for_case() {
        let doc = fixture();
        assert_eq!(STOP_NOTICE_MS, doc["noticeMs"].as_i64().unwrap(), "the notice window drifted");
        assert_eq!(MAX_STOPS, doc["maxStops"].as_u64().unwrap() as usize, "the cap drifted");

        let reasons = doc["reasons"].as_array().expect("reasons");
        assert_eq!(reasons.len(), 10, "every StopReason must be covered, got {}", reasons.len());

        let (mut faults, mut routine) = (0usize, 0usize);
        let mut mismatches = Vec::new();
        for r in reasons {
            let reason: StopReason = serde_json::from_value(r["reason"].clone())
                .unwrap_or_else(|e| panic!("{} did not deserialize: {e}", r["reason"]));
            let want_fault = r["fault"].as_bool().unwrap();
            if want_fault {
                faults += 1;
            } else {
                routine += 1;
            }
            if is_fault_stop(reason) != want_fault {
                mismatches.push(format!("  {:?} [fault] ts={want_fault}", reason));
            }
            let with = PaneStop {
                pane_id: "p1".into(),
                reason,
                detail: format!("detail for {}", r["reason"].as_str().unwrap()),
                at: 1_000_000,
                last_output: Some("the last words".into()),
            };
            let without = PaneStop { last_output: None, ..with.clone() };
            for (label, got, want) in [
                ("logWithOutput", stop_log_line(&with), r["logWithOutput"].as_str().unwrap()),
                ("logWithoutOutput", stop_log_line(&without), r["logWithoutOutput"].as_str().unwrap()),
            ] {
                if got != want {
                    mismatches.push(format!("  {:?} [{label}]\n    ts   {want:?}\n    rust {got:?}", reason));
                }
            }
        }
        assert_eq!((faults, routine), (5, 5), "the split is no longer five and five");

        for case in doc["cases"].as_array().expect("cases") {
            let label = case["label"].as_str().unwrap();
            let now = case["now"].as_i64().unwrap();
            let incoming: PaneStop = serde_json::from_value(case["incoming"].clone())
                .unwrap_or_else(|e| panic!("{label}: incoming did not deserialize: {e}"));
            let got = record_stop(&stops(&case["existing"]), incoming, now);
            let want = stops(&case["after"]);
            if got != want {
                mismatches.push(format!(
                    "  {label} [after]\n    ts   {:?}\n    rust {:?}",
                    want.iter().map(|s| (&s.pane_id, s.at)).collect::<Vec<_>>(),
                    got.iter().map(|s| (&s.pane_id, s.at)).collect::<Vec<_>>()
                ));
            }
            let got_active = active_stops(&got, now);
            let want_active = stops(&case["active"]);
            if got_active != want_active {
                mismatches.push(format!("  {label} [active] ts={} rust={}", want_active.len(), got_active.len()));
            }
        }
        assert!(
            mismatches.is_empty(),
            "the Rust ledger disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn stop(pane: &str, reason: StopReason, at: i64) -> PaneStop {
        PaneStop { pane_id: pane.into(), reason, detail: "d".into(), at, last_output: None }
    }

    /// `finished` is a SUCCESS. A notice that fires on every ending is one the user learns to ignore.
    #[test]
    fn finished_is_a_success_and_the_split_is_five_and_five() {
        assert!(!is_fault_stop(StopReason::Finished), "a completed agent is not a fault");
        for r in [StopReason::AppClosed, StopReason::AutoEnded, StopReason::Reaped, StopReason::Disabled] {
            assert!(!is_fault_stop(r), "{r:?} is a normal ending");
        }
        for r in [
            StopReason::Failed,
            StopReason::Signalled,
            StopReason::LauncherFailed,
            StopReason::Quarantined,
            StopReason::Unknown,
        ] {
            assert!(is_fault_stop(r), "{r:?} is something going wrong");
        }
    }

    /// REPLACE, never stack — the nine-stops-in-one-run case that motivated the rule.
    #[test]
    fn nine_stops_for_one_pane_leave_one_notice() {
        let mut list: Vec<PaneStop> = Vec::new();
        for i in 0..9 {
            list = record_stop(&list, stop("p1", StopReason::Failed, 1_000 + i), 1_000 + i);
        }
        assert_eq!(list.iter().filter(|s| s.pane_id == "p1").count(), 1, "nine notices for one pane");
        assert_eq!(list.last().unwrap().at, 1_008, "the NEWEST answer is the one kept");
    }

    /// Expiry is exact at the edge, and the clock is a parameter so this needs no waiting.
    #[test]
    fn the_notice_window_is_half_open_at_the_edge() {
        let now = 1_000_000;
        let edge = stop("old", StopReason::Failed, now - STOP_NOTICE_MS);
        let inside = stop("old", StopReason::Failed, now - STOP_NOTICE_MS + 1);
        assert!(active_stops(std::slice::from_ref(&edge), now).is_empty(), "exactly at the window is OUT");
        assert_eq!(active_stops(std::slice::from_ref(&inside), now).len(), 1, "one ms inside is IN");
    }

    /// The cap keeps the NEWEST, which is what a fleet relaunch flood needs.
    #[test]
    fn the_cap_keeps_the_newest() {
        let existing: Vec<PaneStop> =
            (0..MAX_STOPS + 4).map(|i| stop(&format!("p{i}"), StopReason::Failed, 1_000)).collect();
        let after = record_stop(&existing, stop("newest", StopReason::Failed, 1_000), 1_000);
        assert_eq!(after.len(), MAX_STOPS);
        assert_eq!(after.last().unwrap().pane_id, "newest", "the incoming stop is never the one dropped");
    }

    /// Only a FAULT carries its output, and a silent fault SAYS it printed nothing.
    #[test]
    fn the_log_line_quotes_a_fault_and_names_a_silent_one() {
        let clean = PaneStop { last_output: Some("chatter".into()), ..stop("p1", StopReason::Finished, 1) };
        assert!(!stop_log_line(&clean).contains("last output"), "quoting a clean session is noise");

        let loud = PaneStop { last_output: Some("boom".into()), ..stop("p1", StopReason::Signalled, 1) };
        assert!(stop_log_line(&loud).ends_with("last output: boom"));

        let silent = stop("p1", StopReason::Signalled, 1);
        assert!(
            stop_log_line(&silent).contains("(printed nothing)"),
            "a session that died silently IS the finding — say so rather than leaving a gap"
        );
    }
}
