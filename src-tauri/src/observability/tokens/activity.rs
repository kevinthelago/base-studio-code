// Turn activity (#1184) + worker self-close (#1379) — per-pane state from append-only logs.
//
// Turn activity (#1184): the console status dot can't tell "done" from "working but silent" — its
// only per-turn signal is a 1.5s silence timer, which false-idles a worker that's thinking, running
// a long silent tool call, or backing off. The fix drives turn boundaries from authoritative Claude
// Code hooks: `bsc-activity run` on UserPromptSubmit (turn opens), `bsc-activity idle` on
// Stop/SubagentStop (turn closes), each appending `ts \t pane \t run|idle` to `activity.log`.
// `read_pane_activity` returns the latest state per pane; the frontend treats `run` as
// "turn open" and gates the silence timer so an open turn never false-idles.
//
// Worker self-close (#1379): a finished worker calls `bsc-done`, appending `ts \t pane` to
// `done.log`. The frontend polls the set of self-reported panes and reaps each (classify the
// resting state from plan.db, `markPaneEnded`, `pty_kill`) — the worker says "I'm done"; the
// verdict + the resting card still come from plan.db.

use crate::bsc_base_dir;

use super::cost::latest_per_key;

/// One pane's latest turn-boundary state (#1184). `state` is `"run"` (a turn is open — the agent
/// is working) or `"idle"` (the turn closed at an authoritative Stop). Serialized to the frontend
/// poller, which gates the status dot's silence timer on it.
#[derive(serde::Serialize, Debug, PartialEq)]
pub(crate) struct PaneActivity {
    pane: String,
    state: String,
    /// Epoch-ms timestamp of the event (as the `bsc-activity` helper wrote it).
    at: u64,
}

/// The latest `(pane, state, at)` per pane from an `activity.log` body, newest pane first. The log
/// is append-only oldest-first, so a later line for a pane supersedes earlier ones. Only `run` /
/// `idle` states are kept; malformed/short lines and unknown states are dropped. Pure (no fs) so
/// it's unit-testable.
fn latest_activity_per_pane(log_text: &str) -> Vec<(String, String, u64)> {
    latest_per_key(log_text, 3, |f| {
        let (at, pane, state) = (f[0], f[1].to_string(), f[2].trim().to_string());
        if pane.is_empty() || (state != "run" && state != "idle") {
            return None;
        }
        let at: u64 = at.trim().parse().ok()?;
        Some((pane.clone(), (pane, state, at)))
    })
}

/// Read the latest turn-boundary state per pane (#1184). Reads `activity.log` and returns one
/// record per pane (newest pane first). Missing log ⇒ empty (no panes have taken a turn yet),
/// so the frontend cleanly falls back to its silence-timer behavior.
#[tauri::command]
pub(crate) fn read_pane_activity() -> Vec<PaneActivity> {
    let path = bsc_base_dir().join("activity.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    latest_activity_per_pane(&text)
        .into_iter()
        .map(|(pane, state, at)| PaneActivity { pane, state, at })
        .collect()
}

/// The deduped set of panes that have self-reported `done` (via `bsc-done`), newest first. The log
/// is `ts \t pane` per line; blank/short lines and empty pane fields are dropped. Pure (no fs).
fn done_panes(log_text: &str) -> Vec<String> {
    latest_per_key(log_text, 2, |f| {
        let pane = f[1].trim().to_string();
        if pane.is_empty() {
            return None;
        }
        Some((pane.clone(), pane))
    })
}

/// The panes a finished worker self-reported via `bsc-done` (#1379). Missing log ⇒ empty (no worker
/// has asked to close yet), so the frontend simply reaps nothing.
#[tauri::command]
pub(crate) fn read_done_panes() -> Vec<String> {
    let path = bsc_base_dir().join("done.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    done_panes(&text)
}

#[cfg(test)]
mod tests {
    #[test]
    fn latest_activity_per_pane_keeps_newest_run_idle_state() {
        // activity.log is append-only oldest-first; a later line for a pane supersedes earlier
        // ones, and the result is newest-pane-first. `ts \t pane \t state` lines; only run/idle
        // states survive, and malformed/short/unknown-state lines are dropped (#1184).
        let log = concat!(
            "100\tp1\trun\n",          // p1 opens a turn
            "150\tp2\trun\n",          // p2 opens a turn
            "bad line with no tabs\n", // dropped: too few fields
            "200\tp1\tidle\n",         // p1's turn closes — supersedes its run
            "250\tp3\tbogus\n",        // dropped: unknown state
            "260\t\trun\n",            // dropped: empty pane
            "notanumber\tp4\trun\n",   // dropped: non-numeric ts
            "300\tp1\trun\n",          // p1 reopens — newest line for p1
        );
        let rows = super::latest_activity_per_pane(log);
        // p1 (latest, ts300, run) first; then p2. p3/p4 dropped.
        let states: Vec<(&str, &str, u64)> =
            rows.iter().map(|(p, s, at)| (p.as_str(), s.as_str(), *at)).collect();
        assert_eq!(states, vec![("p1", "run", 300), ("p2", "run", 150)], "newest line first; bad lines dropped");
    }

    /// The status-dot gating contract (#1184): a pane whose latest event is `run` has its turn
    /// OPEN, so the silence timer must NOT idle it. `idle`, or no activity at all, leaves the
    /// silence timer authoritative (no regression for non-bash / never-launched panes).
    #[test]
    fn read_pane_activity_serializes_run_as_turn_open() {
        // Round-trip the parser → struct mapping the command performs, so the frontend keys it right.
        let log = "100\tt0p1\trun\n200\tt0p2\tidle\n";
        let rows: Vec<super::PaneActivity> = super::latest_activity_per_pane(log)
            .into_iter()
            .map(|(pane, state, at)| super::PaneActivity { pane, state, at })
            .collect();
        let p1 = rows.iter().find(|r| r.pane == "t0p1").unwrap();
        assert_eq!(p1.state, "run", "an open turn reads as run (gates the silence timer)");
        let p2 = rows.iter().find(|r| r.pane == "t0p2").unwrap();
        assert_eq!(p2.state, "idle", "a closed turn reads as idle (silence timer stays authoritative)");
    }

    #[test]
    fn done_panes_dedupes_and_drops_malformed() {
        // done.log is `ts \t pane` per line; the result is the deduped pane set, newest line first.
        // Short/blank lines and empty pane fields are dropped (#1379).
        let log = concat!(
            "100\tproj:api\n",
            "150\tproj:web\n",
            "noTabHere\n",      // dropped: too few fields
            "200\tproj:api\n",  // p:api seen again — newer line wins for ordering
            "250\t\n",          // dropped: empty pane
        );
        let panes = super::done_panes(log);
        assert_eq!(panes, vec!["proj:api".to_string(), "proj:web".to_string()], "newest first; bad lines dropped");
        assert_eq!(super::done_panes(""), Vec::<String>::new(), "empty log ⇒ no panes");
    }
}
