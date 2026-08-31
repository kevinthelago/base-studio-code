//! Idle-session reaping, owned by the process that owns the sessions.
//!
//! # Why this moved out of the frontend
//!
//! The reaper was `useIdleReaper`, a React hook mounted in `App.tsx`. That put the policy bounding
//! session count in the most fragile part of the app, and it inverted the project's own rule that the
//! desktop is authoritative because it owns the agent processes: Rust owns them, and the lifecycle
//! decision lived in the one process that does not.
//!
//! MEASURED 2026-08-31, and this is what a renderer death actually costs: the webview was OOM-killed
//! and the backend kept running headless for fifteen minutes with **17 sessions alive** — eleven
//! directors for projects nobody was working on, three positional panes, an architect, and the two the
//! maintainer actually wanted. Fifteen `bsc-agent` processes, all from one launch, all with **zero
//! seconds of CPU time**. Nothing could reap them, because the only thing that reaps was gone.
//!
//! # Two signals, and why `run` could not be an absolute veto
//!
//! The old policy refused `status == "run"` before consulting any threshold. `run` is emitted by the
//! harness wrapper when it INVOKES the agent, and `idle` only from `PROMPT_COMMAND` — which cannot
//! fire until the agent EXITS. So a launched agent that is doing nothing reads `run` forever and was
//! unreapable at any grace. That was flagged when the seconds-long grace landed and is what those
//! fifteen sessions are.
//!
//! The tempting fix is CPU time, and it is wrong. A session blocked on a slow local model burns no CPU
//! either — it is waiting on a socket — and with ollama granting a single slot, fifteen sessions queue
//! and every one of them looks exactly like a parked one by CPU.
//!
//! What separates them is OUTPUT. A queued session still printed `contacting the model` and
//! `thinking (step 1/20)`; a parked one printed nothing at all. So the policy keeps `run` as a veto for
//! a bounded grace and adds a SILENCE CEILING that applies whatever the status says. Both thresholds
//! are measured from the same clock — the last byte the PTY produced.
//!
//! # Where the signal comes from
//!
//! Rust already reads every byte of every session (it records scrollback), so it can stamp the last
//! output itself. The `run`/`idle` marker was parsed only in the frontend's `TerminalView`, which is
//! precisely why the backend could not have had this policy before — [`scan_state_marker`] moves that
//! parse to where the bytes already are.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// What the session's shell last said about itself, via the OSC-100 marker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    /// The harness wrapper invoked an agent. Bash is blocked for its whole lifetime, so this persists
    /// until the agent process exits — it does NOT mean the agent is doing anything.
    Run,
    /// Bash regained its prompt (`PROMPT_COMMAND`), so the agent has exited.
    Idle,
    /// No marker seen yet on this session — a shell that has not run the wrapper, or one whose first
    /// marker has not arrived. Treated as `Idle` by the policy: an unknown session that has produced
    /// no output for the grace is not doing work worth protecting.
    Unknown,
}

/// One session's liveness, as the backend observes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activity {
    /// Epoch-ms of the last byte this session produced. The single clock both thresholds read.
    pub last_output_ms: u64,
    pub status: RunState,
}

/// The two thresholds, and the focus report they are checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReapPolicy {
    /// Grace for a session whose agent has EXITED (`Idle`/`Unknown`). Seconds: there is nothing in
    /// flight to protect, and the maintainer's instruction was "I don't mind restarting sessions".
    pub idle_grace_ms: u64,
    /// Grace for a session that is still inside an agent (`Run`). Deliberately much longer, because
    /// this is the one that can interrupt real work — it must outlast the slowest plausible model
    /// turn, and a local first response after a cold model load is minutes, not seconds.
    pub silence_ceiling_ms: u64,
}

impl Default for ReapPolicy {
    fn default() -> Self {
        Self { idle_grace_ms: 10_000, silence_ceiling_ms: 5 * 60_000 }
    }
}

/// Whether this session should be reaped now.
///
/// `focused` is reported BY the frontend rather than inferred here — the backend cannot know which
/// pane a person is looking at. It is deliberately a report with an expiry (see [`focused_pane`]):
/// when the renderer dies, no pane is focused, everything becomes reapable, and that is exactly the
/// case this whole module exists for.
pub fn should_reap(a: &Activity, now_ms: u64, focused: bool, policy: &ReapPolicy) -> bool {
    if focused {
        return false; // the user is watching it
    }
    // Saturating: a clock that went backwards must read as "no silence yet", never as a huge one.
    let silent_ms = now_ms.saturating_sub(a.last_output_ms);
    match a.status {
        // Still inside an agent. Only total silence past the ceiling reaps it, so a session waiting on
        // a slow model — which keeps printing progress — is never taken.
        RunState::Run => silent_ms >= policy.silence_ceiling_ms,
        // The agent has exited (or never started). The short grace applies.
        RunState::Idle | RunState::Unknown => silent_ms >= policy.idle_grace_ms,
    }
}

/// The OSC-100 state marker the session's shell emits: `ESC ] 100 ; <state> BEL`.
///
/// Returns the LAST marker in the chunk, because a chunk can carry several and only the newest
/// describes the session now. Scans raw bytes rather than decoded text: the marker can straddle a
/// UTF-8 boundary split, and it is pure ASCII, so there is nothing to decode.
///
/// Unterminated is ignored rather than guessed at — a marker split across two reads is picked up when
/// its BEL arrives in a later chunk, and inventing a state from half a sequence would be worse than
/// waiting.
pub fn scan_state_marker(chunk: &[u8]) -> Option<RunState> {
    const OPEN: &[u8] = b"\x1b]100;";
    let mut found = None;
    let mut i = 0;
    while let Some(rel) = chunk[i..].windows(OPEN.len()).position(|w| w == OPEN) {
        let start = i + rel + OPEN.len();
        // BEL terminates it; ST (ESC \) is the other legal terminator and is accepted too.
        let end = chunk[start..].iter().position(|b| *b == 0x07 || *b == 0x1b).map(|p| start + p);
        match end {
            Some(e) => {
                found = match &chunk[start..e] {
                    b"run" => Some(RunState::Run),
                    b"idle" => Some(RunState::Idle),
                    _ => found, // an unknown state name is not a reason to forget the last good one
                };
                i = e;
            }
            None => break, // unterminated — wait for the rest
        }
    }
    found
}

// ── The live registry ────────────────────────────────────────────────────────

fn registry() -> &'static Mutex<HashMap<String, Activity>> {
    static R: OnceLock<Mutex<HashMap<String, Activity>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The focused pane as last REPORTED by the frontend, with the epoch-ms it was reported at.
fn focus_cell() -> &'static Mutex<Option<(String, u64)>> {
    static F: OnceLock<Mutex<Option<(String, u64)>>> = OnceLock::new();
    F.get_or_init(|| Mutex::new(None))
}

/// How long a focus report is trusted.
///
/// A REPORT WITH AN EXPIRY, not a latch. If the renderer dies while a pane is focused, a latched
/// report would protect that pane forever — the one session guaranteed to survive would be the one the
/// user was last looking at, in the exact situation where the UI is gone. The frontend re-reports on a
/// timer well inside this window, so a live UI never lapses.
pub const FOCUS_REPORT_TTL_MS: u64 = 30_000;

/// Milliseconds since the epoch.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Record that `pane_id` produced bytes, and fold in any state marker they carried.
///
/// Called from the reader loop with the RAW chunk, before anything interprets it.
pub fn note_output(pane_id: &str, chunk: &[u8]) {
    let state = scan_state_marker(chunk);
    let Ok(mut map) = registry().lock() else { return };
    let e = map
        .entry(pane_id.to_string())
        .or_insert(Activity { last_output_ms: now_ms(), status: RunState::Unknown });
    e.last_output_ms = now_ms();
    if let Some(s) = state {
        e.status = s;
    }
}

/// Drop a session's activity when its PTY goes away, so a dead pane cannot be reaped twice or hold a
/// name a later session reuses.
pub fn forget(pane_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(pane_id);
    }
}

/// The frontend reporting which pane the user is looking at. `None` clears it.
pub fn report_focus(pane_id: Option<String>) {
    if let Ok(mut cell) = focus_cell().lock() {
        *cell = pane_id.map(|p| (p, now_ms()));
    }
}

/// The focused pane, if the report is still fresh. See [`FOCUS_REPORT_TTL_MS`].
pub fn focused_pane(now_ms_: u64) -> Option<String> {
    let cell = focus_cell().lock().ok()?;
    let (id, at) = cell.as_ref()?;
    (now_ms_.saturating_sub(*at) < FOCUS_REPORT_TTL_MS).then(|| id.clone())
}

/// Every pane that should be reaped right now, given a snapshot and the focus report.
///
/// Pure over its inputs so the whole decision is testable without a PTY, a clock or a webview.
pub fn panes_to_reap(
    snapshot: &HashMap<String, Activity>,
    now_ms_: u64,
    focused: Option<&str>,
    policy: &ReapPolicy,
) -> Vec<String> {
    let mut out: Vec<String> = snapshot
        .iter()
        .filter(|(id, a)| should_reap(a, now_ms_, Some(id.as_str()) == focused, policy))
        .map(|(id, _)| id.clone())
        .collect();
    out.sort(); // deterministic, so logs and tests do not depend on hash order
    out
}

/// A copy of the live registry, for the ticker and for reporting.
pub fn snapshot() -> HashMap<String, Activity> {
    registry().lock().map(|m| m.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_788_000_000_000;

    fn act(status: RunState, silent_ms: u64) -> Activity {
        Activity { last_output_ms: NOW - silent_ms, status }
    }

    #[test]
    fn the_state_marker_is_read_from_the_raw_bytes() {
        assert_eq!(scan_state_marker(b"\x1b]100;run\x07"), Some(RunState::Run));
        assert_eq!(scan_state_marker(b"\x1b]100;idle\x07"), Some(RunState::Idle));
        assert_eq!(scan_state_marker(b"hello world"), None);
        // Embedded in ordinary output, which is how it actually arrives.
        assert_eq!(scan_state_marker(b"$ bsc-agent\r\n\x1b]100;run\x07thinking"), Some(RunState::Run));
    }

    /// A chunk can carry several markers; only the newest describes the session now.
    #[test]
    fn the_last_marker_in_a_chunk_wins() {
        assert_eq!(scan_state_marker(b"\x1b]100;run\x07x\x1b]100;idle\x07"), Some(RunState::Idle));
        assert_eq!(scan_state_marker(b"\x1b]100;idle\x07x\x1b]100;run\x07"), Some(RunState::Run));
    }

    /// Split across reads: waiting beats guessing, and the next chunk carries the terminator.
    #[test]
    fn an_unterminated_marker_is_ignored_rather_than_guessed() {
        assert_eq!(scan_state_marker(b"\x1b]100;ru"), None);
        assert_eq!(scan_state_marker(b"\x1b]100;"), None);
        // An unknown state name must not erase a good marker earlier in the same chunk.
        assert_eq!(scan_state_marker(b"\x1b]100;run\x07\x1b]100;wat\x07"), Some(RunState::Run));
        // ST is the other legal terminator.
        assert_eq!(scan_state_marker(b"\x1b]100;idle\x1b\\"), Some(RunState::Idle));
    }

    /// THE CASE THIS MODULE EXISTS FOR: a launched agent that has printed nothing.
    #[test]
    fn a_parked_agent_is_reaped_once_it_has_been_silent_past_the_ceiling() {
        let p = ReapPolicy::default();
        // Fifteen of these were alive for 909s having produced nothing.
        assert!(should_reap(&act(RunState::Run, 909_000), NOW, false, &p));
        // ...but not before the ceiling. `run` still buys real protection.
        assert!(!should_reap(&act(RunState::Run, 60_000), NOW, false, &p));
        assert!(!should_reap(&act(RunState::Run, p.silence_ceiling_ms - 1), NOW, false, &p));
    }

    /// THE CASE THE CEILING MUST NOT BREAK: a session queued behind others on a one-slot ollama. It is
    /// NOT idle, and CPU time cannot tell it from a parked one — but it keeps printing progress, so the
    /// output clock can.
    #[test]
    fn a_session_waiting_on_a_slow_model_is_not_reaped_while_it_reports_progress() {
        let p = ReapPolicy::default();
        // "thinking (step 1/20)…" two seconds ago, after ten minutes of a slow turn.
        assert!(!should_reap(&act(RunState::Run, 2_000), NOW, false, &p));
        // Even a full minute between progress lines is well inside the ceiling.
        assert!(!should_reap(&act(RunState::Run, 60_000), NOW, false, &p));
    }

    /// An exited agent leaves a bash prompt; there is nothing in flight, so the short grace applies.
    #[test]
    fn an_exited_agent_takes_the_short_grace_not_the_ceiling() {
        let p = ReapPolicy::default();
        assert!(should_reap(&act(RunState::Idle, 10_000), NOW, false, &p));
        assert!(!should_reap(&act(RunState::Idle, 9_999), NOW, false, &p));
        // A session that never emitted a marker is treated as exited, not as protected.
        assert!(should_reap(&act(RunState::Unknown, 10_000), NOW, false, &p));
    }

    #[test]
    fn the_focused_pane_is_never_reaped_at_any_silence() {
        let p = ReapPolicy::default();
        for st in [RunState::Run, RunState::Idle, RunState::Unknown] {
            assert!(!should_reap(&act(st, 10 * 60 * 60_000), NOW, true, &p), "{st:?}");
        }
    }

    /// A clock that jumps backwards must read as "no silence yet" rather than reaping everything.
    #[test]
    fn a_backwards_clock_reaps_nothing() {
        let p = ReapPolicy::default();
        let future = Activity { last_output_ms: NOW + 60_000, status: RunState::Idle };
        assert!(!should_reap(&future, NOW, false, &p));
    }

    #[test]
    fn the_selection_is_deterministic_and_respects_focus() {
        let p = ReapPolicy::default();
        let mut snap = HashMap::new();
        snap.insert("zzz:parked".into(), act(RunState::Run, 909_000));
        snap.insert("aaa:exited".into(), act(RunState::Idle, 30_000));
        snap.insert("mmm:working".into(), act(RunState::Run, 2_000));
        snap.insert("bbb:watched".into(), act(RunState::Idle, 30_000));

        let got = panes_to_reap(&snap, NOW, Some("bbb:watched"), &p);
        assert_eq!(got, vec!["aaa:exited".to_string(), "zzz:parked".to_string()]);
    }

    /// A focus report EXPIRES. Latching it would mean that when the renderer dies, the one session
    /// guaranteed to survive forever is whichever the user was last looking at — in exactly the
    /// situation this module exists to handle.
    #[test]
    fn a_stale_focus_report_stops_protecting_its_pane() {
        report_focus(Some("watched".into()));
        let at = now_ms();
        assert_eq!(focused_pane(at).as_deref(), Some("watched"));
        assert_eq!(focused_pane(at + FOCUS_REPORT_TTL_MS - 1).as_deref(), Some("watched"));
        assert_eq!(focused_pane(at + FOCUS_REPORT_TTL_MS), None, "the report has expired");

        report_focus(None);
        assert_eq!(focused_pane(now_ms()), None);
    }

    /// The registry folds output time and state together, which is what the ticker reads.
    #[test]
    fn noting_output_records_the_time_and_the_state_it_carried() {
        let pane = format!("test-pane-{}", std::process::id());
        note_output(&pane, b"hello");
        let a = snapshot()[&pane];
        assert_eq!(a.status, RunState::Unknown, "no marker yet");
        assert!(a.last_output_ms > 0);

        note_output(&pane, b"\x1b]100;run\x07");
        assert_eq!(snapshot()[&pane].status, RunState::Run);

        // Output WITHOUT a marker must not reset the state — only the clock.
        note_output(&pane, b"thinking...");
        assert_eq!(snapshot()[&pane].status, RunState::Run, "plain output keeps the last state");

        note_output(&pane, b"\x1b]100;idle\x07");
        assert_eq!(snapshot()[&pane].status, RunState::Idle);

        forget(&pane);
        assert!(!snapshot().contains_key(&pane), "a dead pane leaves no entry behind");
    }
}

/// The live policy, defaulting to [`ReapPolicy::default`] until the frontend reports the user's
/// Settings values.
fn policy_cell() -> &'static Mutex<ReapPolicy> {
    static P: OnceLock<Mutex<ReapPolicy>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(ReapPolicy::default()))
}

/// The frontend reporting the user's configured thresholds.
///
/// REPORTED, not owned there. Settings still renders the control, and if that number did not reach the
/// decision it would be a control that visibly does nothing — the failure this repo keeps meeting from
/// the other direction. A zero or absent value falls back to the default rather than reaping instantly.
pub fn set_policy(idle_grace_ms: Option<u64>, silence_ceiling_ms: Option<u64>) {
    let d = ReapPolicy::default();
    if let Ok(mut p) = policy_cell().lock() {
        p.idle_grace_ms = idle_grace_ms.filter(|v| *v > 0).unwrap_or(d.idle_grace_ms);
        p.silence_ceiling_ms = silence_ceiling_ms.filter(|v| *v > 0).unwrap_or(d.silence_ceiling_ms);
    }
}

/// The thresholds in force right now.
pub fn policy() -> ReapPolicy {
    policy_cell().lock().map(|p| *p).unwrap_or_default()
}

// ── The ticker ───────────────────────────────────────────────────────────────

/// How often the sweep runs. Half the short grace, so the grace is not rounded up to the tick — the
/// same reasoning as the frontend hook it replaces, where a 60s tick against a 10s grace made the
/// number decorative.
pub const TICK_MS: u64 = 5_000;

/// The event the frontend listens for so it can SHOW what the backend decided.
///
/// The direction is deliberate and is the point of this whole change: the backend decides and reports,
/// the frontend renders. Previously the frontend decided and the backend obeyed, which is why nothing
/// was reaped once the frontend was gone.
pub const REAPED_EVENT: &str = "pty-reaped";

#[cfg(test)]
mod headless_tests {
    use super::*;

    /// THE WHOLE POINT, stated as a test: the decision needs nothing from a frontend.
    ///
    /// Every input is either observed from the PTY bytes (`note_output`) or defaulted. The one thing
    /// only the UI knows — focus — is absent here, and absent must mean "reapable", because the case
    /// this module exists for is precisely the one where there is no UI to ask. Measured before this
    /// existed: the webview was OOM-killed and 17 sessions stayed alive for fifteen minutes.
    #[test]
    fn the_decision_is_reached_with_no_frontend_involved_at_all() {
        let policy = ReapPolicy::default();
        let now = 1_788_000_000_000u64;

        // Two sessions the backend learned about purely by reading their output.
        let mut snap = HashMap::new();
        // A parked agent: said `run` once at launch and printed nothing for 909s. This is what the
        // fifteen measured `bsc-agent` processes were.
        snap.insert(
            "village-animal-hospital:director".to_string(),
            Activity { last_output_ms: now - 909_000, status: RunState::Run },
        );
        // A worker mid-turn on a slow local model: still printing progress.
        snap.insert(
            "twitter-clone-test:api".to_string(),
            Activity { last_output_ms: now - 2_000, status: RunState::Run },
        );

        // No focus report at all — the renderer is gone.
        let doomed = panes_to_reap(&snap, now, None, &policy);
        assert_eq!(
            doomed,
            vec!["village-animal-hospital:director".to_string()],
            "the parked director goes; the one still talking to the model stays",
        );
    }

    /// An expired focus report must not keep protecting a pane. Without the TTL, the single session
    /// guaranteed to survive a renderer death is whichever the user was last looking at.
    #[test]
    fn a_pane_focused_when_the_renderer_died_is_still_reaped_afterwards() {
        let policy = ReapPolicy::default();
        let now = 1_788_000_000_000u64;
        let mut snap = HashMap::new();
        snap.insert(
            "watched".to_string(),
            Activity { last_output_ms: now - 909_000, status: RunState::Run },
        );

        // While the UI lived, it was protected.
        assert!(panes_to_reap(&snap, now, Some("watched"), &policy).is_empty());
        // With the UI gone there is no report, so it is reapable like anything else.
        assert_eq!(panes_to_reap(&snap, now, None, &policy), vec!["watched".to_string()]);
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;

    /// A reported threshold must actually take effect, or the Settings control is decorative.
    #[test]
    fn a_reported_policy_replaces_the_default_and_nonsense_falls_back() {
        set_policy(Some(30_000), Some(600_000));
        assert_eq!(policy(), ReapPolicy { idle_grace_ms: 30_000, silence_ceiling_ms: 600_000 });

        // Zero would reap every session on the next tick; absent means "not configured". Both take the
        // packaged default rather than the literal value.
        set_policy(Some(0), None);
        assert_eq!(policy(), ReapPolicy::default());
        set_policy(None, None);
        assert_eq!(policy(), ReapPolicy::default());
    }
}
