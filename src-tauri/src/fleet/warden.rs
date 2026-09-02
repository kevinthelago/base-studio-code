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

// The report SHAPE and the DECISION both live in the crate now — see the module header. Re-exported
// so the Tauri command signature and the renderer's payload keep one definition between them.
pub(crate) use bsc_fleet::warden::FleetReport;
use bsc_fleet::warden::WardenTrip;
use tauri::{AppHandle, Manager};

/// How often the loop sweeps. The frontend reports on its own event-driven cadence (a tool attempt, a
/// turn boundary, a self-reported done); this only has to be quick enough that an already-reported
/// trip is acted on promptly.
pub(crate) const TICK_MS: u64 = 3_000;

/// How long a fleet report stays usable. Deliberately a few sweeps' worth: the renderer reports on
/// events, not on a timer, so a quiet fleet legitimately goes seconds without one. Past this the
/// picture is treated as gone — see the module header on which way this fails.
pub(crate) const REPORT_TTL_MS: u64 = 30_000;

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

/// Who to hard-pause from one report — DISPATCHED to the sidecar, not decided here.
///
/// Builds an argv, spawns `bsc`, and checks the reply. It applies no rule, reads no glob and derives
/// no verdict; `bsc_fleet::warden::decide` owns all of it, so there is ONE implementation and tuning a
/// warden rule no longer needs a new app binary.
///
/// EVERY FAILURE DEGRADES TO "QUARANTINE NOBODY". That is the same direction the stale-report rule
/// takes, and it is the safe one for this verb: a false positive hard-pauses a working agent, while a
/// false negative loses one sweep of a loop that runs every few seconds.
pub(crate) fn decide(report: &FleetReport, already: &HashSet<String>) -> Vec<WardenTrip> {
    if report.panes.is_empty() {
        return Vec::new();
    }
    let payload = match serde_json::to_string(report) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[warden] could not serialize the report, quarantining nobody: {e}");
            return Vec::new();
        }
    };
    let mut args = vec!["fleet".to_string(), "warden-decide".to_string(), "--json".to_string()];
    if !already.is_empty() {
        // Sorted so the argv is stable across sweeps — an unstable one makes the child's own logs
        // impossible to diff when a decision changes.
        let mut ids: Vec<&str> = already.iter().map(String::as_str).collect();
        ids.sort_unstable();
        args.push("--quarantined".to_string());
        args.push(ids.join(","));
    }
    let out = match crate::console::bsc::bsc_blocking(None, args, Some(payload)) {
        Ok(o) => o,
        Err(e) => {
            log::warn!("[warden] sidecar call failed, quarantining nobody: {e}");
            return Vec::new();
        }
    };
    parse_trips(&out, report)
}

/// Check the sidecar's reply against the report it was asked about.
///
/// Pure, so the failure directions are testable without a spawn — and there is one that hot-swapping
/// newly makes possible. A DESYNCHRONISED SIDECAR (a stale staged binary answering a newer request)
/// returns a WELL-FORMED list that names panes this report never mentioned. Acting on it would
/// hard-pause a session the warden was not asked about, which is the same misattribution
/// `zip_worktree_changes` is carefully guarded against on the warden's file side.
///
/// There is no index to align against here — the reply is a subset, not a row per input — so the
/// check is MEMBERSHIP: every trip must name a pane on the report's roster. Anything else is refused
/// WHOLESALE rather than filtered, because a reply that names an unknown pane is evidence the two
/// sides disagree about the request, and the trips it does recognise are no more trustworthy than the
/// one it does not.
fn parse_trips(out: &str, report: &FleetReport) -> Vec<WardenTrip> {
    let trips: Vec<WardenTrip> = match serde_json::from_str(out.trim()) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[warden] could not parse the sidecar reply, quarantining nobody: {e}");
            return Vec::new();
        }
    };
    let roster: HashSet<&str> = report.panes.iter().map(|p| p.pane_id.as_str()).collect();
    if let Some(stray) = trips.iter().find(|t| !roster.contains(t.pane_id.as_str())) {
        log::warn!(
            "[warden] sidecar named {} which is not on this report's roster — refusing the whole reply",
            stray.pane_id
        );
        return Vec::new();
    }
    trips
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
    use bsc_fleet::warden::{ConformanceTrip, ConformanceVerdict, ReportedPane, TabPanes};

    fn verdict(on_task: bool, trips: &[(&str, &str)]) -> ConformanceVerdict {
        ConformanceVerdict {
            on_task,
            trips: trips.iter().map(|(k, d)| ConformanceTrip { kind: (*k).into(), detail: (*d).into() }).collect(),
        }
    }
    fn drifting(id: &str) -> ReportedPane {
        ReportedPane {
            pane_id: id.into(),
            stream_id: "api".into(),
            verdict: verdict(false, &[("out-of-glob", "src/web/app.tsx")]),
        }
    }
    fn one_tab(ids: &[&str]) -> Vec<TabPanes> {
        vec![TabPanes { pane_ids: ids.iter().map(|s| s.to_string()).collect() }]
    }
    fn trip(pane: &str) -> WardenTrip {
        WardenTrip { pane_id: pane.into(), stream_id: "api".into(), trips: vec![], summary: "s".into() }
    }
    fn report(panes: &[&str]) -> FleetReport {
        FleetReport {
            panes: panes.iter().map(|p| drifting(p)).collect(),
            tabs: one_tab(panes),
            ..Default::default()
        }
    }

    /// The happy path: a reply about panes this report actually named is passed through.
    #[test]
    fn a_reply_about_panes_we_asked_about_is_passed_through() {
        let r = report(&["p:api", "p:web"]);
        let wire = serde_json::to_string(&vec![trip("p:api")]).unwrap();
        let got = parse_trips(&wire, &r);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].pane_id, "p:api");
    }

    /// A DESYNCHRONISED SIDECAR is the failure hot-swapping newly makes possible: a stale staged
    /// binary answering a newer request names a pane this report never mentioned. Acting on it would
    /// hard-pause a session the warden was not asked about.
    ///
    /// Refused WHOLESALE, not filtered: a reply naming an unknown pane is evidence the two sides
    /// disagree about the request, so the trips it does recognise are no more trustworthy than the one
    /// it does not.
    #[test]
    fn a_reply_naming_a_pane_we_never_asked_about_is_refused_wholesale() {
        let r = report(&["p:api"]);
        let stray = serde_json::to_string(&vec![trip("p:api"), trip("p:ghost")]).unwrap();
        let got = parse_trips(&stray, &r);
        assert!(got.is_empty(), "the recognised trip goes with the stray one: {got:?}");

        // And the same reply MINUS the stray is accepted — or the assertion above proves only that
        // nothing ever passes.
        let clean = serde_json::to_string(&vec![trip("p:api")]).unwrap();
        assert_eq!(parse_trips(&clean, &r).len(), 1);
    }

    /// A missing, stale or broken sidecar must QUARANTINE NOBODY. That is the same direction the
    /// stale-report rule takes, and the safe one here: a false positive hard-pauses a working agent.
    #[test]
    fn an_unusable_reply_quarantines_nobody() {
        let r = report(&["p:api"]);
        for junk in ["", "not json", "{}", "null", "[1,2,3]", "bsc: command not found"] {
            assert!(parse_trips(junk, &r).is_empty(), "{junk:?} must not quarantine anyone");
        }
        // An empty list is a legitimate answer and means the same thing.
        assert!(parse_trips("[]", &r).is_empty());
    }

    /// A report with no panes never spawns — the idle fleet is the common case, and a sweep every
    /// 3s must not pay a process for it.
    #[test]
    fn an_empty_report_costs_no_spawn() {
        assert!(decide(&FleetReport::default(), &HashSet::new()).is_empty());
    }

    /// A STALE REPORT YIELDS NOTHING, and the direction is the opposite of the reaper's.
    ///
    /// [`crate::console::pty::reap`]'s on-screen report fails toward ACTION: a stale one means nothing
    /// is protected, because the reaper exists to reap. This one fails toward INACTION, because its
    /// action is to KILL a session — acting on a picture that may be minutes old would hard-pause
    /// workers that have since gone quiet. Copying the reaper's semantics here would make a dead
    /// renderer start killing sessions.
    #[test]
    fn a_stale_report_stops_the_warden_and_that_is_the_opposite_of_the_reaper() {
        reset_for_test();
        report_fleet(report(&["p:api"]));
        let at = now_ms();

        let fresh = fresh_report(at).expect("a just-filed report is fresh");
        assert_eq!(fresh.panes.len(), 1, "and it carries the pane");

        assert!(fresh_report(at + REPORT_TTL_MS).is_none(), "exactly at the TTL it is gone");
        assert!(fresh_report(at + REPORT_TTL_MS + 1).is_none());

        // The asymmetry, named: the reaper's TTL gates a REAP, so its expiry frees a session; this
        // TTL gates a KILL, so its expiry protects one. Same mechanism, opposite safe direction.
        const { assert!(REPORT_TTL_MS > TICK_MS, "the TTL must outlast a sweep, or a quiet fleet expires mid-loop") };
        reset_for_test();
    }

    /// A completed worker's standing quarantine is LIFTED, not merely skipped.
    #[test]
    fn a_completed_workers_standing_quarantine_is_lifted() {
        reset_for_test();
        note_quarantined("p:api");
        note_quarantined("p:web");
        assert_eq!(quarantined().len(), 2);

        let lifted = lift_completed(&FleetReport { completed: vec!["p:api".into()], ..Default::default() });
        assert_eq!(lifted, vec!["p:api".to_string()], "reports exactly who it lifted");
        assert!(!quarantined().contains("p:api"), "and actually removed it");
        assert!(quarantined().contains("p:web"), "leaving its neighbour alone");

        assert!(lift_completed(&FleetReport { completed: vec!["p:api".into()], ..Default::default() }).is_empty());
        reset_for_test();
    }

    /// The quarantine record is this process's own, so it survives a renderer that is not there to
    /// hold it — and it stays here even though the DECISION moved, because it is live state.
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

    /// The command surface the renderer reports through round-trips exactly as `useWarden` builds it,
    /// so a rename on either side fails here rather than at runtime.
    #[test]
    fn the_reported_payload_deserializes_exactly_as_the_renderer_sends_it() {
        let sent = serde_json::json!({
            "panes": [{
                "paneId": "proj:api",
                "streamId": "api",
                "verdict": { "onTask": false, "trips": [{ "kind": "out-of-glob", "detail": "src/web/a.tsx" }] }
            }],
            "tabs": [{ "paneIds": ["proj:api"] }],
            "ended": [], "disabled": [], "completed": []
        });
        let report: FleetReport = serde_json::from_value(sent).expect("the renderer's shape must parse");
        assert_eq!(report.panes[0].pane_id, "proj:api");
        assert!(!report.panes[0].verdict.on_task, "camelCase `onTask` reached the Rust field");
        assert_eq!(report.tabs[0].pane_ids, vec!["proj:api".to_string()]);

        // And it re-serializes for the sidecar without losing the shape it arrived in — the app is a
        // pass-through for this payload, and a lossy hop would silently drop a rule.
        let onward: FleetReport = serde_json::from_str(&serde_json::to_string(&report).unwrap()).unwrap();
        assert_eq!(onward.panes[0].pane_id, "proj:api");
        assert!(!onward.panes[0].verdict.on_task);
        assert_eq!(onward.tabs[0].pane_ids, vec!["proj:api".to_string()]);
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
