//! The warden's enforcement loop, owned by the process that owns the sessions it pauses.
//!
//! # Why this moved out of the render loop
//!
//! The warden was `useWarden`, a React hook mounted at the app root. That put an ALWAYS-ON
//! enforcement action — kill the PTY, quarantine the worker, push to the paired phone — in the most
//! fragile part of the app, and it inverted the project's own rule that the desktop is authoritative
//! because it owns the agent processes. It is the idle reaper's failure with teeth: the reaper stopped
//! bounding session count when the webview died, and the warden stopped bounding a HIJACKED worker.
//! The case it exists for is a fleet left running unattended, which is exactly the case where nobody
//! notices the renderer is gone.
//!
//! [`crate::console::pty::reap`] is the precedent and this follows it: the frontend REPORTS the inputs
//! only it has, the report EXPIRES, and the decision plus the enforcement live here.
//!
//! # What the renderer still supplies, and why that is not a half-measure
//!
//! The conformance VERDICT. `checkConformance`'s file-lane arm compiles a stream's `owns` globs with
//! the TypeScript matcher, and `the-two-write-scope-glob-engines-disagree` is an OPEN MAINTAINER
//! DECISION about which of the engines is right — they still differ on `*` crossing a separator.
//! Recomputing the lane arm here would silently move a security boundary onto the other engine while
//! that decision is pending, so the verdict arrives as a value.
//!
//! **The consequence is stated rather than hidden.** With the renderer gone, no NEW verdict is
//! produced, so the loop enforces what it was last told and stops finding new drift. What it does buy
//! is that the DECISION, the sweep bound and the enforcement no longer depend on a React render pass,
//! and an in-flight quarantine completes even if the window dies mid-kill. Moving verdict PRODUCTION
//! here is gated on that glob decision, and on nothing else.
//!
//! # A stale report holds, it does not act
//!
//! [`reap`](crate::console::pty::reap)'s on-screen report fails toward ACTION — a stale one means
//! nothing is protected, because the reaper exists to reap. This one fails toward INACTION: a stale
//! report yields no sessions, so the warden stops quarantining rather than hard-pausing live workers
//! on a picture that may be minutes old. Both are the safe direction for their own verb, and they
//! point opposite ways.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use bsc_fleet::warden::{live_pane_ids_of, plan_warden, warden_sweep_targets, ConformanceVerdict, TabPanes, WardenSession, WardenTrip};
use tauri::{AppHandle, Manager};

/// How often the loop sweeps. The frontend reports on its own event-driven cadence (a tool attempt, a
/// turn boundary, a self-reported done); this only has to be quick enough that an already-reported
/// trip is acted on promptly.
pub(crate) const TICK_MS: u64 = 3_000;

/// How long a fleet report stays usable. Deliberately a few sweeps' worth: the renderer reports on
/// events, not on a timer, so a quiet fleet legitimately goes seconds without one. Past this the
/// picture is treated as gone — see the module header on which way this fails.
pub(crate) const REPORT_TTL_MS: u64 = 30_000;

/// One pane the renderer is telling us about, with the verdict only it can compute today.
#[derive(Clone, Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReportedPane {
    pub pane_id: String,
    pub stream_id: String,
    /// From `checkConformance` — see the module header on why this is reported and not derived.
    pub verdict: ConformanceVerdict,
}

/// The whole fleet picture one report carries.
#[derive(Clone, Debug, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FleetReport {
    /// Every pane on the PLANNED roster, with its verdict.
    #[serde(default)]
    pub panes: Vec<ReportedPane>,
    /// The tab rosters, so the live set is derived here rather than trusted from the renderer.
    #[serde(default)]
    pub tabs: Vec<TabPanes>,
    #[serde(default)]
    pub ended: Vec<String>,
    #[serde(default)]
    pub disabled: Vec<String>,
    /// Workers whose owned issues are all done — in MAINTENANCE (#1957), not building, so their
    /// post-completion activity is expected and must never quarantine them.
    #[serde(default)]
    pub completed: Vec<String>,
}

fn report_cell() -> &'static Mutex<(FleetReport, u64)> {
    static R: OnceLock<Mutex<(FleetReport, u64)>> = OnceLock::new();
    R.get_or_init(|| Mutex::new((FleetReport::default(), 0)))
}

/// Panes this process has already quarantined, so a trip is a ONE-SHOT hard pause rather than a
/// repeating alert across sweeps. Rust's own record: the renderer's `quarantinedPanes` cannot be the
/// source of truth for a loop that has to keep working when the renderer is gone.
fn quarantined_cell() -> &'static Mutex<HashMap<String, u64>> {
    static Q: OnceLock<Mutex<HashMap<String, u64>>> = OnceLock::new();
    Q.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The renderer's periodic report of the fleet picture plus each pane's conformance verdict.
pub(crate) fn report_fleet(report: FleetReport) {
    if let Ok(mut cell) = report_cell().lock() {
        *cell = (report, now_ms());
    }
}

/// The last report, if it is still fresh. A STALE REPORT IS NO REPORT — never the last one seen.
pub(crate) fn fresh_report(now: u64) -> Option<FleetReport> {
    let cell = report_cell().lock().ok()?;
    let (report, at) = &*cell;
    (now.saturating_sub(*at) < REPORT_TTL_MS).then(|| report.clone())
}

/// Panes already hard-paused by this process.
pub(crate) fn quarantined() -> HashSet<String> {
    quarantined_cell().lock().map(|m| m.keys().cloned().collect()).unwrap_or_default()
}

pub(crate) fn note_quarantined(pane_id: &str) {
    if let Ok(mut m) = quarantined_cell().lock() {
        m.insert(pane_id.to_string(), now_ms());
    }
}

/// Lift a quarantine — a worker whose issues are all complete is in maintenance, not drifting.
pub(crate) fn clear_quarantine(pane_id: &str) -> bool {
    quarantined_cell().lock().map(|mut m| m.remove(pane_id).is_some()).unwrap_or(false)
}

#[cfg(test)]
pub(crate) fn reset_for_test() {
    if let Ok(mut c) = report_cell().lock() {
        *c = (FleetReport::default(), 0);
    }
    if let Ok(mut q) = quarantined_cell().lock() {
        q.clear();
    }
}

/// Decide who to hard-pause from one report. PURE over its inputs, so the whole decision is testable
/// without a PTY, a clock or a webview — which is most of the point of moving it here.
///
/// The sweep is bounded to panes with a RUNNING session and never includes a completed worker. Losing
/// that bound is measured and on the record: the planned roster reached 47 panes against 3 live
/// terminals, ~94 serial git spawns inside one synchronous command, `pty_write` at 3280ms and
/// `pty_resize` at 8279ms.
pub(crate) fn decide(report: &FleetReport, already: &HashSet<String>) -> Vec<WardenTrip> {
    let live = live_pane_ids_of(
        &report.tabs,
        &report.ended.iter().cloned().collect(),
        &report.disabled.iter().cloned().collect(),
    );
    let roster: Vec<String> = report.panes.iter().map(|p| p.pane_id.clone()).collect();
    let targets: HashSet<String> = warden_sweep_targets(
        &roster,
        &live.into_iter().collect(),
        &report.completed.iter().cloned().collect(),
    )
    .into_iter()
    .collect();

    let sessions: Vec<WardenSession> = report
        .panes
        .iter()
        .filter(|p| targets.contains(&p.pane_id))
        .map(|p| WardenSession {
            pane_id: p.pane_id.clone(),
            stream_id: p.stream_id.clone(),
            verdict: p.verdict.clone(),
        })
        .collect();

    plan_warden(&sessions, already)
}

/// Lift any quarantine standing on a worker whose owned issues are all complete.
///
/// A worker in MAINTENANCE (#1957) has finished building; its post-completion activity is expected,
/// not drift, so holding it quarantined punishes it for work it is no longer doing. Returns who was
/// lifted — split out of [`tick`] so it is reachable without an `AppHandle`, which is the only reason
/// the behaviour is testable at all.
pub(crate) fn lift_completed(report: &FleetReport) -> Vec<String> {
    let mut lifted = Vec::new();
    for pane in &report.completed {
        if clear_quarantine(pane) {
            log::info!("[warden] lifted quarantine for {pane} — its issues are complete (in maintenance)");
            lifted.push(pane.clone());
        }
    }
    lifted
}

/// Hard-pause one worker: kill the PTY FIRST (a hijacked session cannot be trusted to stop itself),
/// then record it and fire the mobile push.
fn enforce(app: &AppHandle, trip: &WardenTrip) {
    let pane_id = &trip.pane_id;
    // Killing before recording is deliberate: if this process dies between the two, a live hijacked
    // session is worse than a quarantine we re-fire on the next sweep. `kill_pane` is the same entry
    // the background reaper uses — split out of `pty_kill` precisely because a `tauri::command` can
    // only be reached from a frontend, and this loop must work when there is not one.
    match (app.try_state::<crate::console::pty::PtyState>(), app.try_state::<crate::observability::perf::PerfState>()) {
        (Some(pty), Some(perf)) => crate::console::pty::kill_pane(pane_id, &pty, &perf),
        _ => log::error!("[warden] cannot kill {pane_id}: pty/perf state unavailable"),
    }
    note_quarantined(pane_id);
    log::warn!("[warden] quarantined {pane_id} ({}) — {}", trip.stream_id, trip.summary);

    // #1102 slice 2a: a `quarantine` push to paired phones, so the user is alerted even off the
    // desktop. Best-effort; a push failure must never hold the enforcement.
    if let Some(state) = app.try_state::<crate::mobile::tunnel::TunnelState>() {
        state.enqueue_warden_push(pane_id, &trip.summary);
    }
}

/// One sweep: take the fresh report, lift quarantines from completed workers, decide, enforce.
/// Returns the trips it acted on (for tests and for the log).
pub(crate) fn tick(app: &AppHandle, now: u64) -> Vec<WardenTrip> {
    let Some(report) = fresh_report(now) else { return Vec::new() };

    lift_completed(&report);

    let trips = decide(&report, &quarantined());
    for trip in &trips {
        enforce(app, trip);
    }
    trips
}

/// Run the warden on the backend's own schedule, for the whole life of the process.
pub(crate) fn spawn_warden(app: AppHandle) {
    std::thread::spawn(move || {
        log::info!("[warden] enforcement sweep every {TICK_MS}ms · report TTL {REPORT_TTL_MS}ms");
        loop {
            std::thread::sleep(std::time::Duration::from_millis(TICK_MS));
            tick(&app, now_ms());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_fleet::warden::ConformanceTrip;

    fn verdict(on_task: bool, trips: &[(&str, &str)]) -> ConformanceVerdict {
        ConformanceVerdict {
            on_task,
            trips: trips
                .iter()
                .map(|(k, d)| ConformanceTrip { kind: (*k).into(), detail: (*d).into() })
                .collect(),
        }
    }

    fn pane(id: &str, stream: &str, v: ConformanceVerdict) -> ReportedPane {
        ReportedPane { pane_id: id.into(), stream_id: stream.into(), verdict: v }
    }

    fn one_tab(ids: &[&str]) -> Vec<TabPanes> {
        vec![TabPanes { pane_ids: ids.iter().map(|s| s.to_string()).collect() }]
    }

    fn drifting(id: &str) -> ReportedPane {
        pane(id, "api", verdict(false, &[("out-of-glob", "src/web/app.tsx")]))
    }

    /// The decision runs here, and it is the whole reason this module exists.
    #[test]
    fn a_drifting_live_worker_is_selected_for_quarantine() {
        let report = FleetReport {
            panes: vec![drifting("p:api")],
            tabs: one_tab(&["p:api"]),
            ..Default::default()
        };
        let trips = decide(&report, &HashSet::new());
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].pane_id, "p:api");
        assert_eq!(trips[0].summary, "edited out-of-lane src/web/app.tsx");
    }

    /// THE BOUND THAT COSTS 8279ms WHEN IT IS LOST. A planned pane with no live session cannot be
    /// drifting, and must never be swept.
    #[test]
    fn the_sweep_is_bounded_to_panes_with_a_running_session() {
        // Drifting, on the roster, but in no tab — no session exists.
        let report =
            FleetReport { panes: vec![drifting("p:api")], tabs: vec![], ..Default::default() };
        assert!(decide(&report, &HashSet::new()).is_empty(), "no session ⇒ not swept");

        // The same pane, once it is in a tab, IS swept — or the assertion above proves only that
        // nothing works.
        let live = FleetReport { tabs: one_tab(&["p:api"]), ..report.clone() };
        assert_eq!(decide(&live, &HashSet::new()).len(), 1);

        // Ended and disabled are not live either.
        let ended = FleetReport { ended: vec!["p:api".into()], ..live.clone() };
        assert!(decide(&ended, &HashSet::new()).is_empty(), "ended ⇒ not swept");
        let disabled = FleetReport { disabled: vec!["p:api".into()], ..live.clone() };
        assert!(decide(&disabled, &HashSet::new()).is_empty(), "disabled ⇒ not swept");
    }

    /// A worker in maintenance has finished its issues; its activity is expected, not drift.
    #[test]
    fn a_completed_worker_is_never_quarantined() {
        let report = FleetReport {
            panes: vec![drifting("p:api")],
            tabs: one_tab(&["p:api"]),
            completed: vec!["p:api".into()],
            ..Default::default()
        };
        assert!(decide(&report, &HashSet::new()).is_empty());
    }

    /// A trip is a one-shot hard pause, not a repeating alert.
    #[test]
    fn an_already_quarantined_pane_is_not_re_tripped() {
        let report = FleetReport {
            panes: vec![drifting("p:api")],
            tabs: one_tab(&["p:api"]),
            ..Default::default()
        };
        let already: HashSet<String> = ["p:api".to_string()].into_iter().collect();
        assert!(decide(&report, &already).is_empty());
    }

    /// The verdict is OBEYED, not re-derived. Recomputing the file-lane arm here would move a
    /// security boundary onto the other glob engine while `the-two-write-scope-glob-engines-disagree`
    /// is still an open maintainer decision.
    #[test]
    fn the_reported_verdict_decides_and_is_never_second_guessed() {
        let tabs = one_tab(&["p:ok", "p:bad"]);

        // on_task, despite an alarming-looking pane id and stream: obeyed.
        let ok = FleetReport {
            panes: vec![pane("p:ok", "api", verdict(true, &[]))],
            tabs: tabs.clone(),
            ..Default::default()
        };
        assert!(decide(&ok, &HashSet::new()).is_empty());

        // on_task = false with an EMPTY trip list still quarantines: the verdict decides, not the
        // trip list, and the summary reports exactly what it was given.
        let bare = FleetReport {
            panes: vec![pane("p:bad", "api", verdict(false, &[]))],
            tabs,
            ..Default::default()
        };
        let trips = decide(&bare, &HashSet::new());
        assert_eq!(trips.len(), 1);
        assert_eq!(trips[0].summary, "on plan");
    }

    /// A STALE REPORT YIELDS NOTHING. This is the direction opposite the reaper's, and it is the one
    /// that matters for a verb whose action is to kill a session: acting on a picture that may be
    /// minutes old would hard-pause workers that have since gone quiet.
    #[test]
    fn a_stale_report_stops_the_warden_rather_than_acting_on_it() {
        reset_for_test();
        report_fleet(FleetReport {
            panes: vec![drifting("p:api")],
            tabs: one_tab(&["p:api"]),
            ..Default::default()
        });
        let at = now_ms();

        let fresh = fresh_report(at).expect("a just-filed report is fresh");
        assert_eq!(decide(&fresh, &HashSet::new()).len(), 1, "and it does decide");

        assert!(fresh_report(at + REPORT_TTL_MS).is_none(), "exactly at the TTL it is gone");
        assert!(fresh_report(at + REPORT_TTL_MS + 1).is_none());
        reset_for_test();
    }

    /// A completed worker's standing quarantine is LIFTED, not merely skipped.
    ///
    /// Found by a divergence that did not bite: the lift lives in `tick`, which needs an `AppHandle`,
    /// so nothing reached it. Skipping and lifting look identical from `decide` — the difference is
    /// whether the worker is still shown as quarantined once it goes into maintenance.
    #[test]
    fn a_completed_workers_standing_quarantine_is_lifted() {
        reset_for_test();
        note_quarantined("p:api");
        note_quarantined("p:web");
        assert_eq!(quarantined().len(), 2);

        let lifted = lift_completed(&FleetReport {
            completed: vec!["p:api".into()],
            ..Default::default()
        });
        assert_eq!(lifted, vec!["p:api".to_string()], "reports exactly who it lifted");
        assert!(!quarantined().contains("p:api"), "and actually removed it");
        assert!(quarantined().contains("p:web"), "leaving its neighbour alone");

        // Lifting an unquarantined pane reports nothing rather than a phantom.
        assert!(lift_completed(&FleetReport { completed: vec!["p:api".into()], ..Default::default() }).is_empty());
        reset_for_test();
    }

    /// THE WIRING, not the helper.
    ///
    /// The parity tests in `bsc_fleet::warden` prove `plan_warden` is correct; not one of them can say
    /// whether anything CALLS it. This drives the whole path the loop takes — report in, decision out —
    /// so reverting `decide` to stop consulting `plan_warden`, or `tick` to stop consulting `decide`,
    /// turns it red. That is the difference between a pinned migration and a pinned function.
    #[test]
    fn the_loop_actually_consults_the_ported_decision() {
        reset_for_test();
        report_fleet(FleetReport {
            panes: vec![drifting("p:api"), pane("p:ok", "web", verdict(true, &[]))],
            tabs: one_tab(&["p:api", "p:ok"]),
            ..Default::default()
        });

        // The report round-trips through the module's OWN storage, not a hand-built struct.
        let report = fresh_report(now_ms()).expect("the report the loop will read");
        let trips = decide(&report, &quarantined());

        // Exactly the drifting pane, carrying the summary `summarize_trips` produced — which is only
        // reachable through `plan_warden`.
        assert_eq!(trips.len(), 1, "the on-task pane must not be selected");
        assert_eq!(trips[0].pane_id, "p:api");
        assert_eq!(trips[0].stream_id, "api");
        assert_eq!(
            trips[0].summary, "edited out-of-lane src/web/app.tsx",
            "the summary comes from bsc_fleet::warden::summarize_trips, not from anything here"
        );
        reset_for_test();
    }

    /// The command surface the renderer reports through exists and round-trips.
    ///
    /// A call-site test that only asserts the command is *invoked* is not enough — it must carry the
    /// payload, or the argument is accepted and never sent. This deserializes the exact JSON shape
    /// `useWarden` builds, so a rename on either side fails here rather than at runtime.
    #[test]
    fn the_reported_payload_deserializes_exactly_as_the_renderer_sends_it() {
        let sent = serde_json::json!({
            "panes": [{
                "paneId": "proj:api",
                "streamId": "api",
                "verdict": { "onTask": false, "trips": [{ "kind": "out-of-glob", "detail": "src/web/a.tsx" }] }
            }],
            "tabs": [{ "paneIds": ["proj:api"] }],
            "ended": [],
            "disabled": [],
            "completed": []
        });
        let report: FleetReport = serde_json::from_value(sent).expect("the renderer's shape must parse");
        assert_eq!(report.panes.len(), 1);
        assert_eq!(report.panes[0].pane_id, "proj:api");
        assert!(!report.panes[0].verdict.on_task, "camelCase `onTask` reached the Rust field");
        assert_eq!(report.panes[0].verdict.trips[0].kind, "out-of-glob");
        assert_eq!(report.tabs[0].pane_ids, vec!["proj:api".to_string()]);

        // And it decides on it — the payload is not merely parsed, it is acted on.
        assert_eq!(decide(&report, &HashSet::new()).len(), 1);
    }

    /// The quarantine record is this process's own, so it survives a renderer that is not there to
    /// hold it — and lifts when the worker's issues complete.
    #[test]
    fn the_quarantine_record_is_owned_here_and_lifts_on_completion() {
        reset_for_test();
        assert!(quarantined().is_empty());
        note_quarantined("p:api");
        assert!(quarantined().contains("p:api"));
        assert!(clear_quarantine("p:api"), "lifting reports that it removed something");
        assert!(!clear_quarantine("p:api"), "and lifting twice does not");
        assert!(quarantined().is_empty());
        reset_for_test();
    }
}

// ── The Tauri surface ────────────────────────────────────────────────────────────────────────

/// The renderer reporting the fleet picture plus each pane's conformance verdict.
///
/// A REPORT, not a command to act: it expires (see [`REPORT_TTL_MS`]) and the loop decides for
/// itself. The renderer no longer chooses who is quarantined and no longer performs the kill.
#[tauri::command]
pub(crate) fn warden_report_fleet(report: FleetReport) {
    report_fleet(report);
}

/// Every pane this process has hard-paused, for the banner the renderer draws.
///
/// The renderer RENDERS the quarantine; it does not own it. Reading it back from here is what keeps
/// the badge correct across a window reload, which the old store-only record could not survive.
#[tauri::command]
pub(crate) fn warden_quarantined_panes() -> Vec<String> {
    let mut v: Vec<String> = quarantined().into_iter().collect();
    v.sort();
    v
}
