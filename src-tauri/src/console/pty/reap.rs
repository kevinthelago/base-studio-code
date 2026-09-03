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

/// The ONE spelling of a run state that leaves this process.
///
/// Both publishers of this fact went through `format!("{:?}", …)` and only ONE of them lowercased it:
/// the `pty_activity` command the UI reads said `Run`, while the `pty-activity.json` the CLI reads said
/// `run`. A reader written against either matched nothing against the other — and since nothing in the
/// frontend read the command at all, that disagreement sat there unobserved. One function, so the two
/// cannot drift apart again.
///
/// A `match` rather than a lowercased `Debug`: the wire word must not follow a variant RENAME, and an
/// added variant should fail to compile here rather than start emitting a word no reader knows.
pub fn state_word(s: RunState) -> &'static str {
    match s {
        RunState::Run => "run",
        RunState::Idle => "idle",
        RunState::Unknown => "unknown",
    }
}

/// One session's liveness, as the backend observes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Activity {
    /// Epoch-ms of the last byte this session produced. The single clock both thresholds read.
    pub last_output_ms: u64,
    pub status: RunState,
    /// Epoch-ms when this session was first seen.
    ///
    /// The never-started rule needs it: "has not started YET" and "will never start" are
    /// indistinguishable in a session's first minutes, and only AGE separates them.
    pub created_ms: u64,
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

/// How old a session must be before ZERO CPU is allowed to mean "it never started".
///
/// A JUST-OPENED SESSION LOOKS EXACTLY LIKE A PARKED ONE. It has no CPU — it is blocked on a socket
/// waiting for the model, not computing — and no output after its banner. Those are precisely the two
/// signals the never-started rule reads, so without this it reaped every local session before its
/// first token: "after i click to open it freezes for a second, the pane opens and then it's reaped
/// before anything can happen."
///
/// Three minutes because that is what a COLD local model costs before its first response — the agent
/// prints "the first local response can take a while (model load + context)" for exactly this reason.
/// Below it a `run` session takes the ordinary silence ceiling, which is long enough to cover the same
/// wait; above it, a session that has still never used one CPU tick genuinely never started.
///
/// This does not weaken the case the maintainer actually asked for. A session whose agent has EXITED
/// is `Idle`, keeps the ten-second grace, and is unaffected — nothing is in flight there.
pub const NEVER_STARTED_MIN_AGE_MS: u64 = 3 * 60_000;

/// Whether this session should be reaped now.
///
/// `on_screen` is reported BY the frontend rather than inferred here — the backend cannot know which
/// panes a person can see. It is deliberately a report with an expiry (see [`on_screen_panes`]): when
/// the renderer dies, nothing is on screen, everything becomes reapable, and that is exactly the case
/// this whole module exists for.
///
/// IT USED TO BE `focused`, AND THAT WORD WAS THE BUG. The frontend reported ONE pane id, resolved
/// from the console grid's `focusedPaneIdx` — so a studio session, a graph session and a network
/// architect could never be it, and this guard, the only unconditional protection in the whole
/// policy, was unreachable for every session the app owns. With a ten-second idle grace that is the
/// difference between a session and a corpse: the user watched their architect die while looking at
/// it. What protects a session is being VISIBLE, not being the console's cursor.
pub fn should_reap(
    a: &Activity,
    now_ms: u64,
    on_screen: bool,
    cpu_ms: Option<u64>,
    policy: &ReapPolicy,
) -> bool {
    // Saturating, like the silence below: a clock that moved backwards must read as YOUNG, which is
    // the protective direction.
    let age_ms = now_ms.saturating_sub(a.created_ms);
    if on_screen {
        return false; // a surface is showing it — the user can see this session
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
        // AGE-GATED. Without `age_ms`, a session opened seconds ago is indistinguishable from one
        // that will never start — both have zero CPU and no output — and every local session was
        // reaped before the model's first token.
        RunState::Run if cpu_ms == Some(0) && age_ms >= NEVER_STARTED_MIN_AGE_MS => {
            silent_ms >= policy.idle_grace_ms
        }
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

/// Every pane a surface is showing, as last REPORTED by the frontend, with the epoch-ms of that
/// report. Empty means "nothing is on screen" — which is also what a report that never arrived and a
/// report that has expired both mean, and they are deliberately indistinguishable: each of the three
/// says the same thing, that nothing here is protected.
fn focus_cell() -> &'static Mutex<(std::collections::HashSet<String>, u64)> {
    static F: OnceLock<Mutex<(std::collections::HashSet<String>, u64)>> = OnceLock::new();
    F.get_or_init(|| Mutex::new((std::collections::HashSet::new(), 0)))
}

/// How long an on-screen report is trusted.
///
/// A REPORT WITH AN EXPIRY, not a latch. If the renderer dies while panes are on screen, a latched
/// report would protect them forever — the sessions guaranteed to survive would be the ones the user
/// was last looking at, in the exact situation where the UI is gone. The frontend re-reports on a
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
        created_ms: now_ms(),
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
        .or_insert(Activity {
            last_output_ms: now_ms(),
            created_ms: now_ms(),
            status: RunState::Unknown,
            root_pid: 0,
        })
        .root_pid = root_pid;
}

/// Drop a session's activity when its PTY goes away, so a dead pane cannot be reaped twice or hold a
/// name a later session reuses.
pub fn forget(pane_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(pane_id);
    }
}

/// The frontend reporting every pane a surface is currently SHOWING. An empty list clears it.
///
/// A SET, not one id. The single-id form could only ever name the console grid's focused pane, so no
/// studio, graph session or network architect was ever protected — and several surfaces genuinely do
/// show different sessions at once (a console cell and an open Glance morph), so there is no one pane
/// to name even when the answer is not a studio.
pub fn report_on_screen(pane_ids: Vec<String>) {
    if let Ok(mut cell) = focus_cell().lock() {
        *cell = (pane_ids.into_iter().collect(), now_ms());
    }
}

/// The panes a surface is showing, if the report is still fresh. See [`FOCUS_REPORT_TTL_MS`].
///
/// A STALE REPORT IS AN EMPTY SET, never the last one seen. That is the whole reason this is a report
/// with an expiry rather than a latch: when the renderer dies, everything it was showing has to become
/// reapable, which is the case the backend reaper exists for.
pub fn on_screen_panes(now_ms_: u64) -> std::collections::HashSet<String> {
    let Ok(cell) = focus_cell().lock() else { return std::collections::HashSet::new() };
    let (ids, at) = &*cell;
    if now_ms_.saturating_sub(*at) < FOCUS_REPORT_TTL_MS { ids.clone() } else { std::collections::HashSet::new() }
}

/// Every pane that should be reaped right now, given a snapshot and the on-screen report.
///
/// Pure over its inputs so the whole decision is testable without a PTY, a clock or a webview.
pub fn panes_to_reap(
    snapshot: &HashMap<String, Activity>,
    now_ms_: u64,
    on_screen: &std::collections::HashSet<String>,
    procs: &ProcSnapshot,
    policy: &ReapPolicy,
) -> Vec<String> {
    let mut out: Vec<String> = snapshot
        .iter()
        .filter(|(id, a)| {
            // A root pid of 0 means the session never reported one, which is UNKNOWN rather than zero
            // CPU — the distinction that decides whether it takes the grace or the ceiling.
            let cpu_ms = (a.root_pid != 0).then(|| subtree_cpu_ms(a.root_pid, procs));
            should_reap(a, now_ms_, on_screen.contains(id.as_str()), cpu_ms, policy)
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

/// The on-screen report as a set — the shape a live UI sends every few seconds. Test-only, and shared
/// by every test module here so "nothing is on screen" has ONE spelling rather than a copy per module.
#[cfg(test)]
fn on_screen_set(ids: &[&str]) -> std::collections::HashSet<String> {
    ids.iter().map(|s| (*s).to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_788_000_000_000;

    /// OLD by default: these tests are about the silence rules, so the age gate must not silently
    /// change what they mean. `young()` is the opposite case, tested explicitly below.
    fn act(status: RunState, silent_ms: u64) -> Activity {
        Activity {
            last_output_ms: NOW - silent_ms,
            created_ms: NOW - (NEVER_STARTED_MIN_AGE_MS + 60_000),
            status,
            root_pid: 0,
        }
    }

    /// A session opened `age_ms` ago that has printed nothing since its banner.
    fn young(age_ms: u64) -> Activity {
        Activity {
            last_output_ms: NOW - age_ms,
            created_ms: NOW - age_ms,
            status: RunState::Run,
            root_pid: 4242,
        }
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

    /// THE REGRESSION THIS FIXES: "after i click to open it freezes for a second, the pane opens and
    /// then it's reaped before anything can happen."
    ///
    /// A just-opened session has ZERO CPU (blocked on a socket waiting for the model, not computing)
    /// and NO OUTPUT after its banner — exactly the two signals the never-started rule reads. So it
    /// reaped every local session before its first token.
    #[test]
    fn a_just_opened_session_is_not_reaped_while_it_waits_for_the_model() {
        let p = ReapPolicy::default();
        let cpu = ProcSnapshot::default(); // pid 4242 absent ⇒ genuinely zero CPU
        for age in [1_000u64, 15_000, 60_000, NEVER_STARTED_MIN_AGE_MS - 1] {
            let mut panes = HashMap::new();
            panes.insert("twitter-clone-test:api".to_string(), young(age));
            assert!(
                panes_to_reap(&panes, NOW, &on_screen_set(&[]), &cpu, &p).is_empty(),
                "a {age}ms-old session waiting on the model must survive",
            );
        }

        // Past the age, a session that has STILL never used a CPU tick genuinely never started.
        let mut panes = HashMap::new();
        panes.insert("parked".to_string(), young(NEVER_STARTED_MIN_AGE_MS + 1_000));
        assert_eq!(panes_to_reap(&panes, NOW, &on_screen_set(&[]), &cpu, &p), vec!["parked".to_string()]);
    }

    /// The exited-agent case is UNTOUCHED — that is where "reap in seconds" is both wanted and safe,
    /// because nothing is in flight.
    #[test]
    fn an_exited_agent_still_takes_the_short_grace_however_young() {
        let p = ReapPolicy::default();
        let just_exited = Activity {
            last_output_ms: NOW - 10_000,
            created_ms: NOW - 12_000, // far younger than the never-started age gate
            status: RunState::Idle,
            root_pid: 4242,
        };
        assert!(should_reap(&just_exited, NOW, false, Some(0), &p));
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
            Activity { last_output_ms: NOW - 60_000, created_ms: NOW - 900_000, status: RunState::Run, root_pid: 4242 },
        );
        // pgid 4242 is absent from the CPU map ⇒ genuinely zero ⇒ reapable on the short grace.
        let cpu = ProcSnapshot::default();
        assert_eq!(panes_to_reap(&snap, NOW, &on_screen_set(&[]), &cpu, &p), vec!["parked".to_string()]);
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
        let a = Activity { last_output_ms: NOW - 30_000, created_ms: NOW - 900_000, status: RunState::Run, root_pid: 1238124 };
        let mut panes = HashMap::new();
        panes.insert("twitter-clone-test:api".to_string(), a);
        assert!(
            panes_to_reap(&panes, NOW, &on_screen_set(&[]), &snap, &p).is_empty(),
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
    fn a_pane_on_screen_is_never_reaped_at_any_silence() {
        let p = ReapPolicy::default();
        for st in [RunState::Run, RunState::Idle, RunState::Unknown] {
            assert!(!should_reap(&act(st, 10 * 60 * 60_000), NOW, true, WORKED, &p), "{st:?}");
        }
    }

    /// A clock that jumps backwards must read as "no silence yet" rather than reaping everything.
    #[test]
    fn a_backwards_clock_reaps_nothing() {
        let p = ReapPolicy::default();
        let future = Activity { last_output_ms: NOW + 60_000, created_ms: NOW, status: RunState::Idle, root_pid: 0 };
        assert!(!should_reap(&future, NOW, false, WORKED, &p));
    }

    #[test]
    fn the_selection_is_deterministic_and_respects_what_is_on_screen() {
        let p = ReapPolicy::default();
        let mut snap = HashMap::new();
        snap.insert("zzz:parked".into(), act(RunState::Run, 909_000));
        snap.insert("aaa:exited".into(), act(RunState::Idle, 30_000));
        snap.insert("mmm:working".into(), act(RunState::Run, 2_000));
        snap.insert("bbb:watched".into(), act(RunState::Idle, 30_000));

        let watched = on_screen_set(&["bbb:watched"]);
        let got = panes_to_reap(&snap, NOW, &watched, &ProcSnapshot::default(), &p);
        assert_eq!(got, vec!["aaa:exited".to_string(), "zzz:parked".to_string()]);
    }

    /// THE REGRESSION. Two surfaces can show two different sessions at once — a console cell and an
    /// open Glance morph — and a studio or a network architect is never the console's focused pane at
    /// all. The report was ONE pane id, so at most one of these could be protected and the app-owned
    /// ones could not be protected at any time, under a ten-second grace.
    #[test]
    fn every_pane_a_surface_is_showing_is_protected_not_just_one() {
        let p = ReapPolicy::default();
        let mut snap = HashMap::new();
        // Silent well past the idle grace, so ONLY the on-screen report can save them.
        for id in [
            "twitter-clone-test:api",          // a console grid cell
            "design-studio:designer-react",    // a studio, docked on the Components page
            "network-finance:architect",       // a network architect, open in a Glance morph
            "algorithms-studio:librarian-rust",
        ] {
            snap.insert(id.to_string(), act(RunState::Idle, 30_000));
        }
        snap.insert("nobody:watching".into(), act(RunState::Idle, 30_000));

        let shown = on_screen_set(&[
            "twitter-clone-test:api",
            "design-studio:designer-react",
            "network-finance:architect",
            "algorithms-studio:librarian-rust",
        ]);
        let got = panes_to_reap(&snap, NOW, &shown, &ProcSnapshot::default(), &p);
        assert_eq!(got, vec!["nobody:watching".to_string()], "only the unwatched session goes");
    }

    /// An on-screen report EXPIRES. Latching it would mean that when the renderer dies, the sessions
    /// guaranteed to survive forever are whichever the user was last looking at — in exactly the
    /// situation this module exists to handle.
    #[test]
    fn a_stale_on_screen_report_stops_protecting_its_panes() {
        report_on_screen(vec!["watched".into(), "also-watched".into()]);
        let at = now_ms();
        assert_eq!(on_screen_panes(at).len(), 2);
        assert!(on_screen_panes(at).contains("watched"));
        assert!(on_screen_panes(at + FOCUS_REPORT_TTL_MS - 1).contains("also-watched"));
        assert!(on_screen_panes(at + FOCUS_REPORT_TTL_MS).is_empty(), "the report has expired");

        report_on_screen(Vec::new());
        assert!(on_screen_panes(now_ms()).is_empty());
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
    let on_screen = on_screen_panes(now_ms_);
    let panes: Vec<serde_json::Value> = {
        let mut v: Vec<_> = snapshot()
            .into_iter()
            .map(|(id, a)| {
                let silent = now_ms_.saturating_sub(a.last_output_ms);
                let is_on_screen = on_screen.contains(id.as_str());
                let cpu_ms = (a.root_pid != 0).then(|| subtree_cpu_ms(a.root_pid, procs));
                serde_json::json!({
                    "paneId": id,
                    "silentMs": silent,
                    "status": state_word(a.status),
                    "onScreen": is_on_screen,
                    // Surfaced because it is what decides WHICH threshold applies — a reader seeing
                    // `reapable: false` on a silent pane needs to know it is protected for having
                    // done work, not by an arbitrary number.
                    "cpuMs": cpu_ms,
                    "reapable": should_reap(&a, now_ms_, is_on_screen, cpu_ms, policy),
                })
            })
            .collect();
        v.sort_by(|a, b| a["paneId"].as_str().cmp(&b["paneId"].as_str()));
        v
    };
    // Sorted OUTSIDE the macro: `json!` cannot parse a turbofish-free generic in a block, and a
    // reader diffing two snapshots must see a real change rather than hash order.
    let on_screen_sorted = {
        let mut v: Vec<String> = on_screen.iter().cloned().collect();
        v.sort();
        v
    };
    let doc = serde_json::json!({
        "writtenAtMs": now_ms_,
        "policy": {
            "idleGraceMs": policy.idle_grace_ms,
            "silenceCeilingMs": policy.silence_ceiling_ms,
        },
        // SORTED, so a reader diffing two snapshots sees a real change rather than hash order. An
        // empty array is the honest answer for all three of "no UI is reporting", "the report
        // expired" and "the UI is showing nothing" — they mean the same thing here: nothing is
        // protected.
        "onScreenPaneIds": on_screen_sorted,
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
mod cgroup_tests {
    use super::*;

    /// `oom_kill` is a COUNTER, and unknown keys must not break the parse — a newer kernel adding a
    /// field cannot be allowed to turn this into a silent zero.
    #[test]
    fn memory_events_yields_the_oom_kill_counter() {
        let real = "low 0\nhigh 0\nmax 12\noom 3\noom_kill 2\noom_group_kill 0\n";
        assert_eq!(parse_memory_events(real), 2);
        assert_eq!(parse_memory_events("low 0\nhigh 0\n"), 0, "absent reads as none");
        assert_eq!(parse_memory_events(""), 0);
        // `oom` is NOT `oom_kill` — one counts pressure events, the other counts processes killed.
        assert_eq!(parse_memory_events("oom 9\n"), 0);
    }

    /// The literal `max` means UNCAPPED. Reading it as 0 would make every session look over a cap of
    /// nothing, which is the confident-but-wrong direction.
    #[test]
    fn memory_max_distinguishes_uncapped_from_a_number() {
        assert_eq!(parse_memory_max("max\n"), None);
        assert_eq!(parse_memory_max("16642998272\n"), Some(16_642_998_272));
        assert_eq!(parse_memory_max("garbage"), None);
    }

    fn win() -> OomWindow {
        OomWindow { sample_age_ms: Some(4_000), ..Default::default() }
    }
    fn used(cur: u64, max: Option<u64>) -> Option<CgroupMem> {
        Some(CgroupMem { current: cur, max, oom_kill: 0 })
    }

    /// Rung 1: its OWN cgroup, still readable, is the whole answer.
    #[test]
    fn its_own_cgroup_still_readable_settles_it() {
        let w = OomWindow {
            mem: used(8 << 30, Some(16 << 30)),
            own_now: Some(1),
            global_then: Some(3),
            global_now: Some(4),
            ..win()
        };
        let l = oom_verdict(&w);
        assert!(l.contains("ITS OWN CGROUP OOM-KILLED IT"), "{l}");
        assert!(l.contains("oom_kill=1"), "{l}");
        assert!(l.contains("8.00 GB") && l.contains("16.00 GB"), "usage and cap: {l}");
        assert!(l.contains("MemorySwapMax=0"), "names why it could not swap out of it: {l}");
    }

    /// Rung 2: THE ONE THE OLD CODE COULD NOT REACH. The child cgroup is gone, so its own counter is
    /// unreadable — but the ancestor kept the count, and it rose while the session died.
    #[test]
    fn a_rise_in_the_surviving_ancestor_is_a_kill_in_this_sessions_subtree() {
        let w = OomWindow {
            mem: used(1 << 30, Some(16 << 30)),
            own_now: None, // the cgroup is already gone — the normal case at a death
            ancestor_then: Some(9),
            ancestor_now: Some(10),
            global_then: Some(9),
            global_now: Some(10),
            ..win()
        };
        let l = oom_verdict(&w);
        assert!(l.contains("ITS OWN CGROUP SUBTREE"), "{l}");
        assert!(l.contains("9 \u{2192} 10"), "it shows the counter moving: {l}");
    }

    /// Rung 3: the ONLY rung that may say "ruled out", and the old code said it without this evidence.
    #[test]
    fn a_rule_out_requires_the_global_counter_to_have_stood_still() {
        let w = OomWindow {
            mem: used(1 << 30, Some(16 << 30)),
            own_now: None,
            ancestor_then: Some(9),
            ancestor_now: Some(9),
            global_then: Some(9),
            global_now: Some(9),
            ..win()
        };
        let l = oom_verdict(&w);
        assert!(l.contains("NO OOM KILL HAPPENED ANYWHERE"), "{l}");
        assert!(l.contains("ruled out"), "{l}");
        assert!(l.contains("4s before it died"), "the sample's age is stated, not implied: {l}");
    }

    /// Rung 4: something WAS OOM-killed, but not here. Measured on this box: all nine of the boot's
    /// kills were in the app's own terminal scope, and none in a session scope.
    #[test]
    fn a_kill_elsewhere_on_the_box_is_not_attributed_to_this_session() {
        let w = OomWindow {
            mem: used(1 << 30, Some(16 << 30)),
            ancestor_then: Some(0),
            ancestor_now: Some(0),
            global_then: Some(8),
            global_now: Some(9),
            ..win()
        };
        let l = oom_verdict(&w);
        assert!(l.contains("NOT in this session's cgroup subtree"), "{l}");
        assert!(!l.contains("ruled out"), "it must not claim a rule-out it cannot make: {l}");
    }

    /// Rung 5: nothing readable is its OWN answer — neither shown nor ruled out, never a zero.
    #[test]
    fn nothing_readable_refuses_to_rule_anything_out() {
        let l = oom_verdict(&OomWindow::default());
        assert!(l.contains("NEITHER shown nor ruled out"), "{l}");
        assert!(l.contains("never readable"), "the absent sample is stated too: {l}");
        // An uncapped cgroup says so rather than printing a number it does not have.
        let l = oom_verdict(&OomWindow { mem: used(1 << 30, None), ..win() });
        assert!(l.contains("uncapped"), "{l}");
    }

    /// `/proc/vmstat` is the counter that survives everything, so its parse is pinned to the real shape.
    #[test]
    fn the_global_oom_counter_is_parsed_from_vmstat() {
        let real = "nr_dirty 42\noom_kill 9\npgfault 1\n";
        assert_eq!(parse_vmstat_oom_kill(real), Some(9));
        // ABSENT IS NOT ZERO — an older kernel without the field must not read as "no kills".
        assert_eq!(parse_vmstat_oom_kill("nr_dirty 42\n"), None);
        // `oom_kill` is not a prefix match on some other key.
        assert_eq!(parse_vmstat_oom_kill("oom_kill_something 4\n"), None);
    }

    /// The path comes from the process, not from a guess at systemd's layout.
    #[test]
    fn the_cgroup_dir_is_read_from_the_process_itself() {
        let me = std::process::id() as i32;
        let d = cgroup_dir_of(me).expect("this process has a v2 cgroup");
        assert!(d.starts_with("/sys/fs/cgroup"), "{d:?}");
        // A leading slash in the cgroup path must EXTEND the base, not replace it.
        assert!(d.to_string_lossy().len() > "/sys/fs/cgroup".len(), "{d:?}");
        assert_eq!(cgroup_dir_of(-1), None, "a pid that cannot exist reads as unknown");
    }
}

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
            Activity { last_output_ms: now - 909_000, created_ms: now - 900_000, status: RunState::Run, root_pid: 7001 },
        );
        // A worker mid-turn on a slow local model: still printing progress.
        snap.insert(
            "twitter-clone-test:api".to_string(),
            Activity { last_output_ms: now - 2_000, created_ms: now - 900_000, status: RunState::Run, root_pid: 0 },
        );

        // No focus report at all — the renderer is gone.
        let doomed = panes_to_reap(&snap, now, &on_screen_set(&[]), &ProcSnapshot::default(), &policy);
        assert_eq!(
            doomed,
            vec!["village-animal-hospital:director".to_string()],
            "the parked director goes; the one still talking to the model stays",
        );
    }

    /// ONE WIRE WORD for a run state, shared by both publishers.
    ///
    /// The words are asserted LITERALLY rather than against `format!("{:?}")`, which would only
    /// re-derive the bug: the whole point is that renaming a variant must not silently change what
    /// every reader matches on.
    #[test]
    fn a_run_state_has_exactly_one_wire_word_and_it_is_lowercase() {
        assert_eq!(state_word(RunState::Run), "run");
        assert_eq!(state_word(RunState::Idle), "idle");
        assert_eq!(state_word(RunState::Unknown), "unknown");
        for s in [RunState::Run, RunState::Idle, RunState::Unknown] {
            assert_eq!(state_word(s), state_word(s).to_lowercase(), "the wire word is lowercase");
        }
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
        // An ARRAY, always — the CLI iterates it. Empty here: this test reports nothing on screen.
        assert_eq!(doc["onScreenPaneIds"].as_array().map(Vec::len), Some(0));

        let row = doc["panes"].as_array().expect("panes")
            .iter().find(|p| p["paneId"] == pane.as_str()).expect("our pane");
        assert_eq!(row["status"], "run", "lowercased for the CLI");
        assert_eq!(row["reapable"], false, "fresh output ⇒ not reapable");
        assert_eq!(row["onScreen"], false, "nothing was reported on screen");
        // No pgid was recorded for this pane, so CPU is UNKNOWN — and unknown must serialize as null
        // rather than 0, or a reader cannot tell "never ran" from "could not tell".
        assert!(row["cpuMs"].is_null(), "unknown CPU is null, never zero");
        assert!(row["silentMs"].as_u64().is_some());

        // No .tmp left behind — the rename must have completed.
        assert!(!path.with_extension("json.tmp").exists());
        forget(&pane);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// An expired on-screen report must not keep protecting a pane. Without the TTL, the sessions
    /// guaranteed to survive a renderer death are whichever the user was last looking at.
    #[test]
    fn a_pane_on_screen_when_the_renderer_died_is_still_reaped_afterwards() {
        let policy = ReapPolicy::default();
        let now = 1_788_000_000_000u64;
        let mut snap = HashMap::new();
        snap.insert(
            "watched".to_string(),
            Activity { last_output_ms: now - 909_000, created_ms: now - 900_000, status: RunState::Run, root_pid: 0 },
        );

        // While the UI lived, it was protected.
        let shown = on_screen_set(&["watched"]);
        assert!(panes_to_reap(&snap, now, &shown, &ProcSnapshot::default(), &policy).is_empty());
        // With the UI gone the report is EMPTY, so it is reapable like anything else.
        let none = std::collections::HashSet::new();
        assert_eq!(panes_to_reap(&snap, now, &none, &ProcSnapshot::default(), &policy), vec!["watched".to_string()]);
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

/// Bytes in a GiB, for the memory lines below.
const GIB: f64 = 1_073_741_824.0;

// ── The session own cgroup (#a-signalled-session-cannot-say-whether-its-cgroup-oom-killed-it) ────

/// What a session's cgroup says about its memory, at one instant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CgroupMem {
    /// `memory.current` in bytes.
    pub current: u64,
    /// `memory.max` in bytes; `None` for `max` (uncapped).
    pub max: Option<u64>,
    /// `memory.events`' `oom_kill` COUNTER — the number of processes this cgroup has OOM-killed.
    ///
    /// A counter, not a flag, so a rise between two samples is what proves a kill happened rather
    /// than one having happened at some point in the past.
    pub oom_kill: u64,
}

/// The cgroup v2 directory a pid belongs to.
///
/// Read from `/proc/<pid>/cgroup` rather than composed from the unit name, so it cannot drift from
/// systemd's actual layout (`user.slice/user-N.slice/user@N.service/app.slice/…`) and needs no
/// knowledge of which slice a scope lands in. The v2 line is `0::<path>`.
pub fn cgroup_dir_of(pid: i32) -> Option<std::path::PathBuf> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).ok()?;
    let rel = raw.lines().find_map(|l| l.strip_prefix("0::"))?.trim();
    // A leading `/` would make `join` replace the base rather than extend it.
    Some(std::path::Path::new("/sys/fs/cgroup").join(rel.trim_start_matches('/')))
}

/// Parse `memory.events`. Pure, so the format is pinned without a live cgroup.
///
/// The file is `key value` per line; unknown keys are ignored so a newer kernel adding one cannot
/// break the parse.
pub fn parse_memory_events(body: &str) -> u64 {
    body.lines()
        .find_map(|l| l.strip_prefix("oom_kill "))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0)
}

/// Parse `memory.max`, where the literal `max` means UNCAPPED — not zero, which would read as a cap
/// of nothing and make every session look over its limit.
pub fn parse_memory_max(body: &str) -> Option<u64> {
    match body.trim() {
        "max" => None,
        n => n.parse().ok(),
    }
}

/// Read a cgroup's memory state. `None` when the cgroup is gone or unreadable — which is a real
/// answer, and must not be confused with a reading of zero.
pub fn read_cgroup_mem(dir: &std::path::Path) -> Option<CgroupMem> {
    let current = std::fs::read_to_string(dir.join("memory.current")).ok()?.trim().parse().ok()?;
    Some(CgroupMem {
        current,
        max: std::fs::read_to_string(dir.join("memory.max")).ok().and_then(|s| parse_memory_max(&s)),
        oom_kill: std::fs::read_to_string(dir.join("memory.events"))
            .map(|s| parse_memory_events(&s))
            .unwrap_or(0),
    })
}

/// A session's cgroup reading, plus the two counters that OUTLIVE it.
///
/// `mem` alone was the whole sample, and it could not answer the question it was built for. See
/// [`oom_verdict`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CgroupSample {
    pub mem: CgroupMem,
    /// When this was taken, so a verdict can say how stale it is instead of implying it is current.
    pub at_ms: u64,
    /// The cgroup dir it was read from, kept so the ANCESTOR can be re-read after the child is gone.
    pub dir: std::path::PathBuf,
    /// The nearest existing ancestor's recursive `oom_kill` at sample time.
    pub ancestor_oom: Option<u64>,
    /// `/proc/vmstat`'s global `oom_kill` at sample time.
    pub global_oom: Option<u64>,
}

/// The last cgroup reading taken while each session was ALIVE.
///
/// Sampled rather than read at death, for the reason the renderer peak already taught: by the time a
/// session's end is observed its cgroup may be gone, and a reading taken then is `None` exactly when
/// it is most wanted.
fn cgroup_cell() -> &'static Mutex<HashMap<String, CgroupSample>> {
    static C: OnceLock<Mutex<HashMap<String, CgroupSample>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `/proc/vmstat`'s `oom_kill`: every OOM kill on the machine since boot, by ANY OOM killer.
///
/// The one counter that survives absolutely everything — no cgroup, no privileges, no kernel ring
/// buffer. `dmesg` and `journalctl -k` both refuse without privileges, which is what made a memcg
/// kill unobservable in the first place.
pub fn parse_vmstat_oom_kill(body: &str) -> Option<u64> {
    body.lines().find_map(|l| l.strip_prefix("oom_kill ")).and_then(|n| n.trim().parse().ok())
}

/// Read [`parse_vmstat_oom_kill`] from the live `/proc/vmstat`.
pub fn vmstat_oom_kill() -> Option<u64> {
    parse_vmstat_oom_kill(&std::fs::read_to_string("/proc/vmstat").ok()?)
}

/// The nearest EXISTING ancestor of `dir`, and its `oom_kill`.
///
/// THIS IS THE READING THAT SURVIVES THE DEATH, and it is why the sample was never needed for this
/// half. memcg increments `oom_kill` on every ancestor AT THE TIME OF THE EVENT, so an ancestor
/// still holds the count long after the child cgroup is destroyed — which is exactly the
/// "cgroup already gone" case sampling was invented to work around.
///
/// VERIFIED on this box: all nine of the boot's OOM kills show as `memory.events.local = 9` on one
/// `vte-spawn` scope and as `memory.events = 9` on every ancestor up to `user.slice`, while
/// `/proc/vmstat` agrees at 9 — so no session scope had been OOM-killed at all.
pub fn ancestor_oom_kill(dir: &std::path::Path) -> Option<(std::path::PathBuf, u64)> {
    let mut cur = dir.parent()?;
    loop {
        let f = cur.join("memory.events");
        if let Ok(body) = std::fs::read_to_string(&f) {
            return Some((cur.to_path_buf(), parse_memory_events(&body)));
        }
        cur = cur.parent()?;
        if !cur.starts_with("/sys/fs/cgroup") {
            return None;
        }
    }
}

/// Sample every live session's cgroup. Called from the sweep that already runs.
pub fn sample_cgroups() {
    let panes = snapshot();
    let Ok(mut cell) = cgroup_cell().lock() else { return };
    for (pane_id, a) in panes {
        if a.root_pid == 0 {
            continue;
        }
        let Some(dir) = cgroup_dir_of(a.root_pid) else { continue };
        let Some(m) = read_cgroup_mem(&dir) else { continue };
        // The two counters that OUTLIVE this cgroup, read at the same instant as the memory reading,
        // so a verdict has a BEFORE to compare its live AFTER against.
        cell.insert(
            pane_id,
            CgroupSample {
                mem: m,
                at_ms: now_ms(),
                ancestor_oom: ancestor_oom_kill(&dir).map(|(_, n)| n),
                global_oom: vmstat_oom_kill(),
                dir,
            },
        );
    }
}

/// What this pane's cgroup last said, if it was ever readable.
pub fn last_cgroup_mem(pane_id: &str) -> Option<CgroupSample> {
    cgroup_cell().lock().ok()?.get(pane_id).cloned()
}

/// Everything known about whether an OOM killed this session, sampled-then-live.
///
/// Pure, so the ladder below is pinned without a live cgroup or a real death.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OomWindow {
    /// The last reading taken while it was alive, and how stale that is.
    pub mem: Option<CgroupMem>,
    pub sample_age_ms: Option<u64>,
    /// The session's OWN cgroup `oom_kill`, read live at death. `None` once the cgroup is gone.
    pub own_now: Option<u64>,
    /// The surviving ancestor's `oom_kill`, at sample time and now.
    pub ancestor_then: Option<u64>,
    pub ancestor_now: Option<u64>,
    /// `/proc/vmstat`'s global `oom_kill`, at sample time and now.
    pub global_then: Option<u64>,
    pub global_now: Option<u64>,
}

/// Gather this pane's OOM evidence: the sample taken while it LIVED, plus LIVE reads of the two
/// counters that outlive its cgroup.
///
/// The impure half; [`oom_verdict`] is the pure half that turns it into a sentence. `ancestor_oom_kill`
/// walks up from the session's own dir, so it still answers after that dir is gone — which is the
/// normal case at a death and the whole reason this is not just a re-read.
pub fn observe_oom(pane_id: &str) -> OomWindow {
    let s = last_cgroup_mem(pane_id);
    OomWindow {
        mem: s.as_ref().map(|s| s.mem),
        sample_age_ms: s.as_ref().map(|s| now_ms().saturating_sub(s.at_ms)),
        own_now: s.as_ref().and_then(|s| read_cgroup_mem(&s.dir)).map(|m| m.oom_kill),
        ancestor_then: s.as_ref().and_then(|s| s.ancestor_oom),
        ancestor_now: s.as_ref().and_then(|s| ancestor_oom_kill(&s.dir)).map(|(_, n)| n),
        global_then: s.as_ref().and_then(|s| s.global_oom),
        global_now: vmstat_oom_kill(),
    }
}

/// The line appended to a signalled session's end message.
///
/// ## Why this stopped being a one-line read of the sample
///
/// It used to say "Its cgroup recorded NO oom_kill …, so a memcg OOM is ruled out" straight off
/// [`last_cgroup_mem`] — a sample taken by the sweep up to [`TICK_MS`] BEFORE the death, of a counter
/// that can only increment AT the death. The instrument was structurally incapable of observing the
/// event it declared ruled out, and it said "ruled out" anyway. That is the same failure as
/// `the-peak-sampler-can-never-match-because-proc-comm-is-truncated-to-15-chars`: an instrument
/// reporting absence from a place the evidence could never appear.
///
/// ## The ladder, strongest evidence first
///
/// Each rung says what was actually observed, and only the rungs that CAN support a rule-out make
/// one. An unknown is never rendered as a zero.
pub fn oom_verdict(w: &OomWindow) -> String {
    let usage = match (w.mem, w.sample_age_ms) {
        (Some(m), age) => {
            let cap = match m.max {
                Some(b) => format!("{:.2} GB", b as f64 / GIB),
                None => "uncapped".to_string(),
            };
            let when = match age {
                Some(ms) => format!("{:.0}s before it died", ms as f64 / 1000.0),
                None => "at the last sample".to_string(),
            };
            format!(" It was using {:.2} GB against a cap of {cap} {when}.", m.current as f64 / GIB)
        }
        (None, _) => " Its cgroup was never readable while it ran.".to_string(),
    };

    // 1 · Its OWN cgroup, read live and still there, is the whole answer.
    if let Some(n) = w.own_now.filter(|n| *n > 0) {
        return format!(
            " ITS OWN CGROUP OOM-KILLED IT: memory.events oom_kill={n}.{usage} The cage renders \
             MemorySwapMax=0, so it cannot swap under pressure."
        );
    }
    // 2 · The ancestor outlives the child, so a rise there during the window is a kill in THIS
    //     session's own subtree — and nothing else runs in it.
    if let (Some(then), Some(now)) = (w.ancestor_then, w.ancestor_now) {
        if now > then {
            return format!(
                " AN OOM KILL LANDED IN ITS OWN CGROUP SUBTREE while it died: the surviving ancestor's \
                 oom_kill went {then} → {now}.{usage}"
            );
        }
    }
    // 3 · No OOM kill anywhere on the machine ⇒ an EARNED rule-out, which the sample alone never was.
    if let (Some(then), Some(now)) = (w.global_then, w.global_now) {
        if now == then {
            return format!(
                " NO OOM KILL HAPPENED ANYWHERE ON THIS MACHINE while it died (/proc/vmstat oom_kill \
                 stayed at {now}), so an OOM — cgroup or host — is ruled out.{usage}"
            );
        }
        // 4 · Something was OOM-killed, but not in this session's subtree.
        return format!(
            " An OOM kill happened on this machine while it died (/proc/vmstat oom_kill {then} → \
             {now}) but NOT in this session's cgroup subtree, so it killed something else.{usage}"
        );
    }
    // 5 · Nothing that can settle it was readable. Say that, rather than implying an absence.
    format!(" Nothing that outlives the cgroup was readable, so an OOM is NEITHER shown nor ruled out.{usage}")
}
