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
    /// The session's shell pid — the ROOT of its process tree. `0` when unknown.
    ///
    /// Named a root rather than a process group on purpose: this was a pgid, and `bsc-agent` setsids
    /// into its own group, so grouping by it summed the shell alone and a working session read as
    /// having used no CPU at all.
    pub root_pid: i32,
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
pub fn should_reap(
    a: &Activity,
    now_ms: u64,
    focused: bool,
    cpu_ms: Option<u64>,
    policy: &ReapPolicy,
) -> bool {
    if focused {
        return false; // the user is watching it
    }
    // Saturating: a clock that went backwards must read as "no silence yet", never as a huge one.
    let silent_ms = now_ms.saturating_sub(a.last_output_ms);
    match a.status {
        // A session that has NEVER used a CPU tick did not go idle — it never started. That is the
        // class worth reaping in seconds, and it is the only thing that separates the two.
        //
        // MEASURED 2026-08-31 at 153s of age: the one working agent had 0.27s of CPU and 22 MB RSS;
        // the other fourteen had EXACTLY zero and 10 MB. Meanwhile both working sessions were silent
        // and climbing (43s → 98s), so OUTPUT alone cannot tell them apart at a ten-second horizon —
        // a short ceiling on silence would have reaped exactly the sessions worth keeping.
        //
        // This corrects the reasoning on the previous item, which rejected CPU because "a session
        // blocked on a slow model burns no CPU". True instantaneously; false cumulatively.
        RunState::Run if cpu_ms == Some(0) => silent_ms >= policy.idle_grace_ms,
        // It has done work, or we could not tell. Only total silence past the ceiling reaps it.
        //
        // UNKNOWN COUNTS AS HAS-WORKED on purpose: losing a turn costs more than a session lingering,
        // so the unreadable case takes the protective branch rather than the aggressive one.
        RunState::Run => silent_ms >= policy.silence_ceiling_ms,
        // The agent has exited. Nothing is in flight, so the short grace applies whatever the CPU says.
        RunState::Idle | RunState::Unknown => silent_ms >= policy.idle_grace_ms,
    }
}

/// One snapshot of `/proc`: each pid's parent and its cumulative CPU.
///
/// Taken in a single walk so the tree and the numbers describe the same instant.
#[derive(Default)]
pub struct ProcSnapshot {
    /// pid -> ppid
    pub parent: HashMap<i32, i32>,
    /// pid -> utime+stime in ms
    pub cpu_ms: HashMap<i32, u64>,
}

/// Read every process's parent and CPU from `/proc`.
#[cfg(target_os = "linux")]
pub fn proc_snapshot() -> ProcSnapshot {
    let mut snap = ProcSnapshot::default();
    let Ok(entries) = std::fs::read_dir("/proc") else { return snap };
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
        let Ok(stat) = std::fs::read_to_string(e.path().join("stat")) else { continue };
        // comm (field 2) can contain spaces and parentheses, so count fields from the LAST ')'.
        let Some(rest) = stat.rfind(')').map(|i| &stat[i + 1..]) else { continue };
        let f: Vec<&str> = rest.split_whitespace().collect();
        // After comm: [0]=state [1]=ppid … [11]=utime [12]=stime
        let (Some(ppid), Some(u), Some(st)) = (f.first(), f.get(11), f.get(12)) else { continue };
        let (Ok(ppid), Ok(u), Ok(st)) =
            (ppid.parse::<i32>(), u.parse::<u64>(), st.parse::<u64>())
        else {
            continue;
        };
        snap.parent.insert(pid, ppid);
        snap.cpu_ms.insert(pid, (u + st) * 10); // ticks (100/s) -> ms
    }
    snap
}

#[cfg(not(target_os = "linux"))]
pub fn proc_snapshot() -> ProcSnapshot {
    ProcSnapshot::default()
}

/// Cumulative CPU of `root` and every descendant.
///
/// THE TREE, NOT THE PROCESS GROUP. This summed by pgid and was wrong: `bsc-agent` is a CHILD of the
/// session's shell but `setsid`s into its OWN process group, so its pgrp is its own pid. Bucketing by
/// the shell's pid therefore summed the SHELL ALONE — measured live, a director that had burned 1.85s
/// reported `cpuMs=10`, which `should_reap` reads as "never started" and reaps on the ten-second grace
/// instead of the five-minute ceiling. Whether a session survived came down to whether its shell
/// happened to accumulate one 10ms tick at startup.
///
/// Walking children covers the caged and uncaged cases identically, so this stays one rule rather than
/// a special case: the agent's ppid is the shell either way.
///
/// Depth-bounded and visited-guarded: `/proc` is read live, so a pid can be reused between the parent
/// map being built and this walk, and a cycle must cost a bounded loop rather than the sweep thread.
pub fn subtree_cpu_ms(root: i32, snap: &ProcSnapshot) -> u64 {
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, ppid) in &snap.parent {
        children.entry(*ppid).or_default().push(*pid);
    }
    let mut total = 0u64;
    let mut seen: std::collections::HashSet<i32> = std::collections::HashSet::new();
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue; // already counted, or a cycle from a reused pid
        }
        total += snap.cpu_ms.get(&pid).copied().unwrap_or(0);
        if let Some(kids) = children.get(&pid) {
            stack.extend(kids.iter().copied());
        }
    }
    total
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
    let e = map.entry(pane_id.to_string()).or_insert(Activity {
        last_output_ms: now_ms(),
        status: RunState::Unknown,
        root_pid: 0,
    });
    e.last_output_ms = now_ms();
    if let Some(s) = state {
        e.status = s;
    }
}

/// Record the session's shell pid, so the sweep can total the CPU of its whole process TREE.
pub fn note_root_pid(pane_id: &str, root_pid: i32) {
    let Ok(mut map) = registry().lock() else { return };
    map.entry(pane_id.to_string())
        .or_insert(Activity { last_output_ms: now_ms(), status: RunState::Unknown, root_pid: 0 })
        .root_pid = root_pid;
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
    procs: &ProcSnapshot,
    policy: &ReapPolicy,
) -> Vec<String> {
    let mut out: Vec<String> = snapshot
        .iter()
        .filter(|(id, a)| {
            // A root pid of 0 means the session never reported one, which is UNKNOWN rather than zero
            // CPU — the distinction that decides whether it takes the grace or the ceiling.
            let cpu_ms = (a.root_pid != 0).then(|| subtree_cpu_ms(a.root_pid, procs));
            should_reap(a, now_ms_, Some(id.as_str()) == focused, cpu_ms, policy)
        })
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
        Activity { last_output_ms: NOW - silent_ms, status, root_pid: 0 }
    }

    /// CPU that says "this session has done work" — the measured 0.27s of the one live agent.
    const WORKED: Option<u64> = Some(270);
    /// Exactly zero: the measured value for all fourteen parked agents.
    const NEVER_RAN: Option<u64> = Some(0);

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
        assert!(should_reap(&act(RunState::Run, 909_000), NOW, false, WORKED, &p));
        // ...but not before the ceiling. `run` still buys real protection.
        assert!(!should_reap(&act(RunState::Run, 60_000), NOW, false, WORKED, &p));
        assert!(!should_reap(&act(RunState::Run, p.silence_ceiling_ms - 1), NOW, false, WORKED, &p));
    }

    /// THE CASE THE CEILING MUST NOT BREAK: a session queued behind others on a one-slot ollama. It is
    /// NOT idle, and CPU time cannot tell it from a parked one — but it keeps printing progress, so the
    /// output clock can.
    #[test]
    fn a_session_waiting_on_a_slow_model_is_not_reaped_while_it_reports_progress() {
        let p = ReapPolicy::default();
        // "thinking (step 1/20)…" two seconds ago, after ten minutes of a slow turn.
        assert!(!should_reap(&act(RunState::Run, 2_000), NOW, false, WORKED, &p));
        // Even a full minute between progress lines is well inside the ceiling.
        assert!(!should_reap(&act(RunState::Run, 60_000), NOW, false, WORKED, &p));
    }

    /// An exited agent leaves a bash prompt; there is nothing in flight, so the short grace applies.
    #[test]
    fn an_exited_agent_takes_the_short_grace_not_the_ceiling() {
        let p = ReapPolicy::default();
        assert!(should_reap(&act(RunState::Idle, 10_000), NOW, false, WORKED, &p));
        assert!(!should_reap(&act(RunState::Idle, 9_999), NOW, false, WORKED, &p));
        // A session that never emitted a marker is treated as exited, not as protected.
        assert!(should_reap(&act(RunState::Unknown, 10_000), NOW, false, WORKED, &p));
    }

    /// THE MAINTAINER'S ASK, and the measurement that shaped it. "Make it 10 seconds for reaping idle
    /// sessions" — taken as a shorter silence ceiling, that would have reaped the two working sessions,
    /// because BOTH were silent and climbing (43s → 98s) while doing real work.
    #[test]
    fn a_session_that_never_used_a_cpu_tick_goes_on_the_short_grace() {
        let p = ReapPolicy::default();
        // The fourteen parked agents: exactly zero CPU at 153s of age. Not idle — never started.
        assert!(should_reap(&act(RunState::Run, 10_000), NOW, false, NEVER_RAN, &p));
        // Still not instant: the short grace is a grace, so a just-launched session gets it.
        assert!(!should_reap(&act(RunState::Run, 9_999), NOW, false, NEVER_RAN, &p));
    }

    /// The other half, and the reason the rule is CPU and not silence: a working session is silent too.
    #[test]
    fn a_session_that_has_done_work_keeps_the_full_ceiling_even_while_silent() {
        let p = ReapPolicy::default();
        // Measured: twitter-clone-test at 0.27s CPU, silent for 98s and climbing.
        assert!(!should_reap(&act(RunState::Run, 98_000), NOW, false, WORKED, &p));
        // A single tick of CPU is enough to mean "this started".
        assert!(!should_reap(&act(RunState::Run, 98_000), NOW, false, Some(10), &p));
        // It is not immortal — the ceiling still applies.
        assert!(should_reap(&act(RunState::Run, p.silence_ceiling_ms), NOW, false, WORKED, &p));
    }

    /// UNKNOWN takes the protective branch. Losing a turn costs more than a session lingering, so the
    /// unreadable case must not fall into the aggressive one.
    #[test]
    fn unknown_cpu_is_treated_as_having_worked_rather_than_as_zero() {
        let p = ReapPolicy::default();
        assert!(!should_reap(&act(RunState::Run, 10_000), NOW, false, None, &p));
        assert!(should_reap(&act(RunState::Run, p.silence_ceiling_ms), NOW, false, None, &p));
    }

    /// A root pid of 0 means the session never reported one — UNKNOWN, not "zero CPU".
    #[test]
    fn a_pane_with_no_root_pid_is_unknown_not_idle() {
        let p = ReapPolicy::default();
        let mut snap = HashMap::new();
        snap.insert("no-pgid".to_string(), act(RunState::Run, 60_000)); // pgid 0
        snap.insert(
            "parked".to_string(),
            Activity { last_output_ms: NOW - 60_000, status: RunState::Run, root_pid: 4242 },
        );
        // pgid 4242 is absent from the CPU map ⇒ genuinely zero ⇒ reapable on the short grace.
        let cpu = ProcSnapshot::default();
        assert_eq!(panes_to_reap(&snap, NOW, None, &cpu, &p), vec!["parked".to_string()]);
    }

    /// THE TOPOLOGY THAT BROKE IT, measured live:
    ///
    ///     shell     pid 1238124
    ///     bsc-agent pid 1238130  ppid 1238124  PGRP 1238130  cpu 1.85s
    ///
    /// The agent is a CHILD of the shell but setsids into its OWN process group. Summing by process
    /// group therefore counted the shell alone — a session with 1.85s of work reported 10ms, which the
    /// policy reads as "never started" and reaps on the ten-second grace.
    #[test]
    fn cpu_is_summed_over_the_tree_so_an_agent_that_left_the_group_still_counts() {
        let mut snap = ProcSnapshot::default();
        // shell (barely any CPU) -> bsc-agent (the real work) -> a tool it spawned
        snap.parent.insert(1238124, 1);
        snap.cpu_ms.insert(1238124, 10);
        snap.parent.insert(1238130, 1238124);
        snap.cpu_ms.insert(1238130, 1_850);
        snap.parent.insert(1238999, 1238130);
        snap.cpu_ms.insert(1238999, 40);
        // An UNRELATED process must not be counted, or every session would look busy.
        snap.parent.insert(9999, 1);
        snap.cpu_ms.insert(9999, 100_000);

        assert_eq!(subtree_cpu_ms(1238124, &snap), 1_900, "shell + agent + its child");
        assert_eq!(subtree_cpu_ms(1238130, &snap), 1_890, "from the agent down");
        assert_eq!(subtree_cpu_ms(424242, &snap), 0, "an unknown root sums nothing");

        // And the consequence: this session keeps the CEILING rather than the never-started grace.
        let p = ReapPolicy::default();
        let a = Activity { last_output_ms: NOW - 30_000, status: RunState::Run, root_pid: 1238124 };
        let mut panes = HashMap::new();
        panes.insert("twitter-clone-test:api".to_string(), a);
        assert!(
            panes_to_reap(&panes, NOW, None, &snap, &p).is_empty(),
            "a session with real work is not reaped after 30s of quiet",
        );
    }

    /// `/proc` is read live, so a reused pid can make the parent map cyclic. That must cost a bounded
    /// loop, not the sweep thread.
    #[test]
    fn a_cycle_in_the_parent_map_terminates() {
        let mut snap = ProcSnapshot::default();
        snap.parent.insert(10, 11);
        snap.cpu_ms.insert(10, 5);
        snap.parent.insert(11, 10);
        snap.cpu_ms.insert(11, 7);
        assert_eq!(subtree_cpu_ms(10, &snap), 12, "each pid counted exactly once");
    }

    #[test]
    fn the_focused_pane_is_never_reaped_at_any_silence() {
        let p = ReapPolicy::default();
        for st in [RunState::Run, RunState::Idle, RunState::Unknown] {
            assert!(!should_reap(&act(st, 10 * 60 * 60_000), NOW, true, WORKED, &p), "{st:?}");
        }
    }

    /// A clock that jumps backwards must read as "no silence yet" rather than reaping everything.
    #[test]
    fn a_backwards_clock_reaps_nothing() {
        let p = ReapPolicy::default();
        let future = Activity { last_output_ms: NOW + 60_000, status: RunState::Idle, root_pid: 0 };
        assert!(!should_reap(&future, NOW, false, WORKED, &p));
    }

    #[test]
    fn the_selection_is_deterministic_and_respects_focus() {
        let p = ReapPolicy::default();
        let mut snap = HashMap::new();
        snap.insert("zzz:parked".into(), act(RunState::Run, 909_000));
        snap.insert("aaa:exited".into(), act(RunState::Idle, 30_000));
        snap.insert("mmm:working".into(), act(RunState::Run, 2_000));
        snap.insert("bbb:watched".into(), act(RunState::Idle, 30_000));

        let got = panes_to_reap(&snap, NOW, Some("bbb:watched"), &ProcSnapshot::default(), &p);
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

/// Publish the reaper's view where a SHELL can read it, next to the PTY ledger.
///
/// The activity registry lives in the app's memory, so the only ways to see it are a Tauri command
/// (reachable from the UI) or a file. A UI-only view is useless in the exact case this whole module
/// exists for — the renderer is gone and the operator wants to know why fifteen sessions are still
/// alive. So the ticker writes a snapshot each sweep and `bsc session activity` reads it.
///
/// Best-effort and atomic-ish: a failed write must never end the sweep it is describing, and a
/// half-written file must not be parsed, so it lands via a temp file and a rename.
pub fn publish(path: &std::path::Path, now_ms_: u64, procs: &ProcSnapshot, policy: &ReapPolicy) {
    let focused = focused_pane(now_ms_);
    let panes: Vec<serde_json::Value> = {
        let mut v: Vec<_> = snapshot()
            .into_iter()
            .map(|(id, a)| {
                let silent = now_ms_.saturating_sub(a.last_output_ms);
                let is_focused = Some(id.as_str()) == focused.as_deref();
                let cpu_ms = (a.root_pid != 0).then(|| subtree_cpu_ms(a.root_pid, procs));
                serde_json::json!({
                    "paneId": id,
                    "silentMs": silent,
                    "status": format!("{:?}", a.status).to_lowercase(),
                    "focused": is_focused,
                    // Surfaced because it is what decides WHICH threshold applies — a reader seeing
                    // `reapable: false` on a silent pane needs to know it is protected for having
                    // done work, not by an arbitrary number.
                    "cpuMs": cpu_ms,
                    "reapable": should_reap(&a, now_ms_, is_focused, cpu_ms, policy),
                })
            })
            .collect();
        v.sort_by(|a, b| a["paneId"].as_str().cmp(&b["paneId"].as_str()));
        v
    };
    let doc = serde_json::json!({
        "writtenAtMs": now_ms_,
        "policy": {
            "idleGraceMs": policy.idle_grace_ms,
            "silenceCeilingMs": policy.silence_ceiling_ms,
        },
        // Absent rather than empty-string when no UI is reporting: "nothing is focused" and "a pane
        // named empty is focused" must not look the same to a reader.
        "focusedPaneId": focused,
        "panes": panes,
    });
    let Ok(body) = serde_json::to_vec_pretty(&doc) else { return };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &body).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

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
            Activity { last_output_ms: now - 909_000, status: RunState::Run, root_pid: 7001 },
        );
        // A worker mid-turn on a slow local model: still printing progress.
        snap.insert(
            "twitter-clone-test:api".to_string(),
            Activity { last_output_ms: now - 2_000, status: RunState::Run, root_pid: 0 },
        );

        // No focus report at all — the renderer is gone.
        let doomed = panes_to_reap(&snap, now, None, &ProcSnapshot::default(), &policy);
        assert_eq!(
            doomed,
            vec!["village-animal-hospital:director".to_string()],
            "the parked director goes; the one still talking to the model stays",
        );
    }

    /// The published file is the CONTRACT `bsc session activity` parses, so its shape is pinned here
    /// rather than left to whatever `serde_json::json!` happened to produce.
    #[test]
    fn the_published_snapshot_carries_what_the_cli_reads() {
        let dir = crate::testutil::unique_dir("bsc-reap-pub", "shape");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let path = dir.join("pty-activity.json");

        let pane = format!("pub-pane-{}", std::process::id());
        note_output(&pane, b"\x1b]100;run\x07");
        publish(&path, now_ms(), &ProcSnapshot::default(), &ReapPolicy::default());

        let body = std::fs::read_to_string(&path).expect("published");
        let doc: serde_json::Value = serde_json::from_str(&body).expect("valid json");
        assert!(doc["writtenAtMs"].as_u64().unwrap_or(0) > 0);
        assert_eq!(doc["policy"]["idleGraceMs"], 10_000);
        assert_eq!(doc["policy"]["silenceCeilingMs"], 300_000);
        // ABSENT, not empty-string: "nothing is focused" and "a pane named empty" must differ.
        assert!(doc["focusedPaneId"].is_null());

        let row = doc["panes"].as_array().expect("panes")
            .iter().find(|p| p["paneId"] == pane.as_str()).expect("our pane");
        assert_eq!(row["status"], "run", "lowercased for the CLI");
        assert_eq!(row["reapable"], false, "fresh output ⇒ not reapable");
        // No pgid was recorded for this pane, so CPU is UNKNOWN — and unknown must serialize as null
        // rather than 0, or a reader cannot tell "never ran" from "could not tell".
        assert!(row["cpuMs"].is_null(), "unknown CPU is null, never zero");
        assert!(row["silentMs"].as_u64().is_some());

        // No .tmp left behind — the rename must have completed.
        assert!(!path.with_extension("json.tmp").exists());
        forget(&pane);
        let _ = std::fs::remove_dir_all(&dir);
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
            Activity { last_output_ms: now - 909_000, status: RunState::Run, root_pid: 0 },
        );

        // While the UI lived, it was protected.
        assert!(panes_to_reap(&snap, now, Some("watched"), &ProcSnapshot::default(), &policy).is_empty());
        // With the UI gone there is no report, so it is reapable like anything else.
        assert_eq!(panes_to_reap(&snap, now, None, &ProcSnapshot::default(), &policy), vec!["watched".to_string()]);
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
