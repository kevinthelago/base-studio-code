//! The RENDERER watchdog — the half of a UI death that happens after a healthy boot.
//!
//! [`super::boot_watch`] covers a boot that never mounts. It cannot cover this one: the app boots
//! fine, runs for an hour, and then the WEB PROCESS dies underneath a window that stays open. The
//! observed case is WebKit killing its own renderer under memory pressure —
//!
//! ```text
//! Unable to shrink memory footprint of process (16744 MB) below the kill thresold (16384 MB). Killed
//! ```
//!
//! — printed by WebKit to stderr, not through our logger. From the app's side NOTHING happens: the
//! Tauri process is alive, no command fails, no panic unwinds, and the window simply goes blank. It is
//! the boot-watchdog's problem shape displaced in time, and it was invisible for the same reason:
//! the only party who could report it is the one that died.
//!
//! ## Why silence, again, rather than a platform signal
//!
//! WebKitGTK does emit `web-process-terminated`, and hooking it would name the cause precisely. It was
//! weighed and set aside: reaching it needs a `webkit2gtk` dependency pinned to whatever version
//! Tauri/wry resolves, and this tree has already been broken once by exactly that coupling (see the
//! `windows` 0.61 → 0.62 note in `Cargo.toml`). It is also LINUX-ONLY, while the failure is not — a
//! WebView2 renderer can die the same way.
//!
//! Silence covers strictly more: a renderer that was killed, that crashed, and that merely FROZE all
//! look identical from here, and all three are equally fatal to a user looking at the window. The
//! fault says "the UI stopped talking to us", which is exactly what was observed, rather than
//! inventing a cause it cannot know.
//!
//! ## The heartbeat is free
//!
//! No new IPC and no frontend change: the frontend already calls [`super::graph_log::frontend_log`]
//! every ~2s with its perf line. Any frontend-originated command is proof of life, so the watchdog
//! reads a clock the app was already winding.
//!
//! ## What this CANNOT cover, stated so nobody looks for it here
//!
//! A WHOLE-APP death. This watchdog lives in the Tauri process, so when that process goes down too,
//! the watchdog goes with it and files nothing — which is why a fatal event can leave zero faults
//! behind. From inside the process that is not a gap to be closed; it is arithmetic.
//!
//! What survives instead is the CURVE. [`super::perf`] samples the webview processes' RSS every
//! couple of seconds and writes each sample straight to perf.db, so the last readings before a death
//! are already on disk when it happens. That does not record the death, but it answers the question
//! the death raises:
//!
//! ```text
//! bsc logs perf --session app:webview
//! ```
//!
//! Before that existed the only sampled processes were the Tauri host and the system totals, and the
//! host stays FLAT while the renderer dies — measured 2026-08-28 at 372-377 MB while the web process
//! climbed to 4.6 GB and was killed. So the instrumentation reported health, and the growth that
//! actually mattered went unmeasured.
//!
//! ## Recovery
//!
//! Filing a fault makes the death visible; it does not give the user their app back. So the watchdog
//! also NAVIGATES the window to its own URL, which respawns the renderer. That is the difference
//! between "the app died at 03:00 and is still blank at 09:00" and a flicker.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

/// How long the UI may go silent before it is presumed dead.
///
/// The heartbeat is ~2s, so this is ~15 heartbeats. Deliberately loose: a busy main thread, a long
/// synchronous render or a laptop resuming from sleep can all stall the frontend briefly, and the cost
/// of firing early is a needless reload of a WORKING app — which is worse than waiting, because it
/// would throw away whatever the user was doing. Erring long only delays a recovery that is already
/// better than the status quo of never happening at all.
const SILENCE_DEADLINE_MS: i64 = 30_000;

/// How often the watchdog checks. Finer than the deadline so the reported gap is roughly the real one.
const TICK_SECS: u64 = 5;

/// The `source_hint` this producer writes under.
///
/// NOT `boot_watch`'s tag, and that separation is load-bearing: a mount ack RESOLVES everything under
/// the boot tag, and a renderer that died an hour into a healthy session must not be cleared by the
/// reload's own successful mount. These are different failures with different lifetimes.
const RENDERER_SOURCE: &str = "app-renderer";

/// Last time the frontend proved it was alive. `0` ⇒ never heard from.
static LAST_SEEN_MS: AtomicI64 = AtomicI64::new(0);
/// Whether a death is already being reported, so a slow reload cannot stack faults.
static REPORTING: AtomicBool = AtomicBool::new(false);

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The frontend is alive. Called from every frontend-originated command — cheap enough to stay that
/// way (one relaxed store), because the whole point is that it costs nothing to be on the hot path.
pub fn alive() {
    LAST_SEEN_MS.store(now_ms(), Ordering::Relaxed);
    REPORTING.store(false, Ordering::Relaxed);
}

/// Should the watchdog declare the renderer dead?
///
/// Pure, and separated from the Tauri plumbing precisely so the decision is testable — the plumbing
/// around it (a window handle, a navigate) is not, and that is where a bug would otherwise hide.
///
/// `last_seen == 0` means the frontend has NEVER checked in, which is a BOOT failure and belongs to
/// [`super::boot_watch`]. Reporting it here too would file two faults for one event and, worse, would
/// fire during a slow cold start where a reload is the last thing anyone wants.
pub fn is_dead(last_seen_ms: i64, now_ms: i64, deadline_ms: i64) -> bool {
    last_seen_ms > 0 && now_ms.saturating_sub(last_seen_ms) > deadline_ms
}

/// What the fault says. Pure + public so the wording is pinned by a test: like the silent-boot title,
/// this is written from the ABSENCE of information and must read as that rather than as a diagnosis.
pub fn dead_title(silent_ms: i64) -> String {
    format!("the UI stopped responding for {}s — the webview process is gone", silent_ms / 1000)
}

/// The detail line. Names the observed cause WITHOUT claiming it, since from here a kill, a crash and
/// a freeze are indistinguishable — and points at the one place the real message does appear.
pub fn dead_detail() -> String {
    "The window is open and the backend is healthy, but the frontend stopped checking in. The \
     renderer was killed, crashed, or froze — all three look identical from the backend. WebKit \
     prints its own memory kill to STDERR rather than through this log (\"Unable to shrink memory \
     footprint of process … Killed\"), so check the terminal that launched the app. The window has \
     been reloaded automatically; anything unsaved in the UI was lost with the renderer."
        .to_string()
}

/// The renderer's peak RSS, in MB, read from the kernel rather than guessed.
///
/// WHY THE FAULT NEEDS IT: this fault used to record only that the webview was gone, which reads the
/// same whether the renderer was killed at 400 MB or at 27 GB. Measured 2026-08-31, it was the latter
/// — 27.50 GB RSS against a 128 GB VmPeak, reached in about two minutes — and the only reason anyone
/// knows that is that a human happened to be sampling `/proc` at the moment it died. Recording it
/// makes the NEXT occurrence evidence instead of another restart.
///
/// `VmHWM` is the high-water mark, not the current value: by the time the watchdog fires the process
/// is usually gone or shrinking, so the instantaneous reading would understate it — often to zero.
///
/// Best-effort and Linux-only. An unreadable value is reported as UNKNOWN by the caller rather than as
/// zero, because "the renderer died at 0 MB" is a false statement and this fault exists to stop
/// exactly that kind of confident-but-wrong record.
/// How the renderer appears in `/proc/<pid>/comm` — a PREFIX, because that file is capped.
///
/// `TASK_COMM_LEN` is 16 including the NUL, so comm holds at most FIFTEEN characters.
/// `"WebKitWebProcess"` is sixteen, so an equality test against the full name can never match —
/// measured 2026-08-31, which is why the fault read `unknown` on every occurrence even while the
/// renderer was sitting right there at 28.5 GB. The sibling `WebKitNetworkPr` (exactly 15) is what
/// made the truncation visible.
///
/// The prefix stops short of `WebKitNetworkPr`, so the network process is not mistaken for the
/// renderer — it is small and would understate the peak badly.
const RENDERER_COMM_PREFIX: &str = "WebKitWebProc";



/// Whether a `/proc/<pid>/comm` value names the renderer. Pure, so the truncation rule is testable
/// against the real observed strings rather than against what the process is "called".
pub fn is_renderer_comm(comm: &str) -> bool {
    comm.starts_with(RENDERER_COMM_PREFIX)
}

/// The renderer's pid, current RSS and the kernel's own high-water mark, from one walk of `/proc`.
///
/// `VmHWM` comes along because it is free and strictly better than a sampled maximum: it is the peak
/// the kernel observed, including anything that happened between two of our five-second sweeps.
#[cfg(target_os = "linux")]
pub fn renderer_pid_rss_mb() -> Option<(i32, u64, u64)> {
    let entries = std::fs::read_dir("/proc").ok()?;
    let mut best: Option<(i32, u64, u64)> = None;
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
        if std::fs::read_to_string(e.path().join("comm"))
            .map(|c| !is_renderer_comm(c.trim()))
            .unwrap_or(true)
        {
            continue;
        }
        let Ok(status) = std::fs::read_to_string(e.path().join("status")) else { continue };
        let field = |name: &str| {
            status
                .lines()
                .find_map(|l| l.strip_prefix(name))
                .and_then(|v| v.split_whitespace().next())
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb / 1024)
        };
        // Several webkit processes can exist; the biggest is the one that matters.
        if let (Some(rss), Some(hwm)) = (field("VmRSS:"), field("VmHWM:")) {
            if best.is_none_or(|(_, b, _)| rss > b) {
                best = Some((pid, rss, hwm));
            }
        }
    }
    best
}

#[cfg(not(target_os = "linux"))]
pub fn renderer_pid_rss_mb() -> Option<(i32, u64, u64)> {
    None
}

/// The RSS past which the renderer is killed rather than allowed to take the machine.
///
/// A RUNAWAY SHOULD COST A RELOAD, NOT THE BOX. Measured four times in one day: the renderer reached
/// 25-30 GB on a 31 GB machine, pinned the main thread, and the OOM killer then chose a victim — which
/// was repeatedly a FLEET WORKER rather than the renderer itself. Killing it by hand returned the
/// machine from 0.2 GB to 29 GB every time, with the backend intact and nothing lost but the window,
/// which `renderer_watch` already reloads.
///
/// The default sits far above ordinary use — a healthy renderer measured a few hundred MB — so this
/// cannot fire on normal work. `0` disables it.
pub fn renderer_cap_mb() -> u64 {
    std::env::var("BSC_RENDERER_MAX_MB")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(8_192)
}

/// Whether an observed RSS is over the cap. Pure, so the decision is testable without a renderer.
///
/// A cap of 0 means DISABLED, not "kill everything" — the opt-out has to be safe to type.
pub fn over_cap(rss_mb: u64, cap_mb: u64) -> bool {
    cap_mb > 0 && rss_mb > cap_mb
}

/// The busiest threads of a process, as `(name, cpu_ms)`, most CPU first.
///
/// WHY THREAD NAMES: this box has no gdb, eu-stack, pstack or perf, and WebKitGTK exposes no usable
/// inspector, so neither a JS nor a native stack can be taken. JSC LABELS ITS THREADS, so the split
/// between the main thread, the GC/marking threads and the compiler threads still says which subsystem
/// is spinning — the narrowing a stack would have given, from information that is actually reachable.
///
/// Names are capped at fifteen characters by the kernel, exactly as `comm` is.
#[cfg(target_os = "linux")]
pub fn busiest_threads(pid: i32, top: usize) -> Vec<(String, u64)> {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else { return Vec::new() };
    let mut v: Vec<(String, u64)> = tasks
        .flatten()
        .filter_map(|t| {
            let name = std::fs::read_to_string(t.path().join("comm")).ok()?.trim().to_string();
            let stat = std::fs::read_to_string(t.path().join("stat")).ok()?;
            let rest = stat.rfind(')').map(|i| &stat[i + 1..])?;
            let f: Vec<&str> = rest.split_whitespace().collect();
            let ms = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
            Some((name, ms * 10)) // ticks (100/s) -> ms
        })
        .collect();
    v.sort_by_key(|(_, ms)| std::cmp::Reverse(*ms));
    v.truncate(top);
    v
}

#[cfg(not(target_os = "linux"))]
pub fn busiest_threads(_pid: i32, _top: usize) -> Vec<(String, u64)> {
    Vec::new()
}

/// Render the busy-thread list for a fault. Pure.
pub fn threads_line(threads: &[(String, u64)]) -> String {
    if threads.is_empty() {
        return " Busiest threads: unknown.".to_string();
    }
    let body = threads
        .iter()
        .map(|(n, ms)| format!("{n} {:.1}s", *ms as f64 / 1000.0))
        .collect::<Vec<_>>()
        .join(", ");
    format!(" Busiest threads at the cap: {body}.")
}

/// The last renderer peak OBSERVED while it was alive, in MB.
///
/// Sampled rather than read at fault time. The watchdog only fires after 30s of silence, by which
/// point the WebKitWebProcess is long gone from `/proc` — measured 2026-08-31, the field read
/// `unknown (could not read it from /proc)` on every real occurrence, and would only ever have
/// populated in the one case nobody needs: a renderer that froze WITHOUT dying.
fn observed_peak() -> &'static std::sync::atomic::AtomicU64 {
    static P: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    &P
}

/// Sample the renderer and, if it is past the cap, KILL IT.
///
/// Called from the sweep that already runs. Returns true when it killed, so the caller can log once.
/// The kill is SIGKILL: a renderer in a synchronous allocating loop cannot service a polite request,
/// which is the whole reason it is being killed.
#[cfg(target_os = "linux")]
pub fn enforce_renderer_cap() -> bool {
    let Some((pid, rss_mb, hwm_mb)) = renderer_pid_rss_mb() else { return false };
    observed_peak().store(
        fold_peak(observed_peak().load(std::sync::atomic::Ordering::Relaxed), Some(hwm_mb)),
        std::sync::atomic::Ordering::Relaxed,
    );
    let cap = renderer_cap_mb();
    if !over_cap(rss_mb, cap) {
        return false;
    }
    // Captured BEFORE the kill — afterwards the task list is gone, which is the mistake the peak
    // sampler already made once.
    let threads = busiest_threads(pid, 6);
    log::error!(
        "[renderer] {:.2} GB is past the {:.2} GB cap — killing it. A reload costs the window; \
         letting it run costs the machine, and the OOM killer has repeatedly taken a fleet worker \
         instead.{}",
        rss_mb as f64 / 1024.0,
        cap as f64 / 1024.0,
        threads_line(&threads),
    );
    record_cap_kill(rss_mb, &threads);
    // SIGKILL via the raw syscall — no crate, and nothing to unwind in a process being reclaimed.
    unsafe { libc::kill(pid, libc::SIGKILL) };
    true
}

#[cfg(not(target_os = "linux"))]
pub fn enforce_renderer_cap() -> bool {
    false
}

/// File the cap kill, so it is evidence rather than a log line that scrolls away.
fn record_cap_kill(rss_mb: u64, threads: &[(String, u64)]) {
    let Some(store) = self_store() else { return };
    let _ = store.record(&errordb::FaultInput {
        stage: "launch".to_string(),
        level: "fatal".to_string(),
        title: format!("the renderer hit {:.2} GB and was killed", rss_mb as f64 / 1024.0),
        stack: Some(format!(
            "A runaway renderer was killed before it could take the machine. The window reloads; the \
             backend and every session are untouched.{}{}",
            peak_line(Some(rss_mb)),
            threads_line(threads),
        )),
        source_hint: Some(RENDERER_SOURCE.to_string()),
        context: None,
        release: Some(env!("CARGO_PKG_VERSION").to_string()),
        ts: now_ms(),
    });
}


/// Fold one reading into the running peak. PURE, so the rule is testable without a renderer — a test
/// binary has none, so a test that went through `sample_renderer_peak` would assert nothing at all.
///
/// Two rules, and both matter:
///   • A FAILED reading (`None`) leaves the peak alone. It is not evidence the renderer got smaller.
///   • A SMALLER reading loses. The process is replaced on every reload, and the fault's question is
///     how big it got BEFORE it died — a fresh renderer must not erase the peak of the dead one.
pub fn fold_peak(current: u64, reading: Option<u64>) -> u64 {
    match reading {
        Some(mb) if mb > current => mb,
        _ => current,
    }
}

/// The peak to report: the largest reading ever observed. `None` when nothing was ever sampled.
pub fn last_observed_peak_mb() -> Option<u64> {
    match observed_peak().load(std::sync::atomic::Ordering::Relaxed) {
        0 => None, // never sampled — UNKNOWN, which is not the same as "it was small"
        mb => Some(mb),
    }
}

/// The memory line appended to the fault detail.
///
/// Split out and pure so the ABSENT case is pinned by a test: an unreadable peak has to read as
/// unknown, since a fault claiming the renderer died at 0 MB would be worse than one that says nothing.
pub fn peak_line(peak_mb: Option<u64>) -> String {
    match peak_mb {
        Some(mb) => format!(
            " Renderer peak memory before it died: {:.2} GB ({mb} MB). A figure in the tens of GB \
             means a runaway allocation — most likely a render loop — rather than an ordinary crash.",
            mb as f64 / 1024.0
        ),
        None => " Renderer peak memory: unknown (could not read it from /proc).".to_string(),
    }
}

fn self_store() -> Option<errordb::Store> {
    errordb::Store::open(&crate::error_db_path(bsc_util::SELF_PROJECT_KEY)).ok()
}

/// Record the fault. Fail-open in every direction — a watchdog must never be the reason anything
/// breaks, and this one runs while the app is already in trouble.
fn record(silent_ms: i64) {
    let Some(store) = self_store() else { return };
    let _ = store.record(&errordb::FaultInput {
        stage: "launch".to_string(),
        level: "fatal".to_string(),
        title: dead_title(silent_ms),
        // The peak is read HERE, at fault time, while the dying process may still be in /proc — a
        // moment later it is gone and the number is unrecoverable.
        // The LAST OBSERVED peak, not a fresh read: the process died ~30s ago and is not in /proc.
        stack: Some(format!("{}{}", dead_detail(), peak_line(last_observed_peak_mb()))),
        source_hint: Some(RENDERER_SOURCE.to_string()),
        context: None,
        release: Some(env!("CARGO_PKG_VERSION").to_string()),
        ts: now_ms(),
    });
}

/// Arm the watchdog. Called once from `setup`, alongside [`super::boot_watch::arm`].
pub fn arm(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(TICK_SECS)).await;
            let last = LAST_SEEN_MS.load(Ordering::Relaxed);
            if !is_dead(last, now_ms(), SILENCE_DEADLINE_MS) {
                continue;
            }
            // `swap` so a reload that itself takes a while cannot file a second fault every tick.
            // Cleared by the next `alive()`, i.e. by the reload actually working.
            if REPORTING.swap(true, Ordering::Relaxed) {
                continue;
            }
            let silent = now_ms().saturating_sub(last);
            log::error!("[renderer] {} — recording a fault and reloading", dead_title(silent));
            record(silent);
            reload(&app);
        }
    });
}

/// Respawn the renderer by navigating the window to its own URL.
///
/// Best-effort, like everything else here. If the window is gone there is nothing to recover and
/// nothing to report — the fault is already filed, which was the half that used to be missing.
fn reload(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(win) = app.get_webview_window("main") else {
        log::warn!("[renderer] no `main` window to reload — the fault stands on its own");
        return;
    };
    match win.url() {
        Ok(url) => {
            if let Err(e) = win.navigate(url) {
                log::warn!("[renderer] could not reload the window: {e}");
            }
        }
        Err(e) => log::warn!("[renderer] could not read the window URL to reload it: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_past_the_deadline_is_death() {
        assert!(is_dead(1_000, 1_000 + 30_001, 30_000));
    }

    #[test]
    fn silence_within_the_deadline_is_not() {
        // A busy main thread or a resumed laptop stalls the heartbeat briefly. Firing here would
        // reload a WORKING app and throw away what the user was doing.
        assert!(!is_dead(1_000, 1_000 + 30_000, 30_000));
        assert!(!is_dead(1_000, 1_000 + 4_000, 30_000));
    }

    #[test]
    fn a_frontend_that_never_checked_in_is_the_boot_watchdog_s_problem() {
        // `last_seen == 0` is a boot that never mounted. Reporting it here would double-file the same
        // event AND could fire during a slow cold start, where a reload is the worst possible move.
        assert!(!is_dead(0, 10_000_000, 30_000));
    }

    #[test]
    fn a_clock_that_goes_backwards_is_not_death() {
        // `saturating_sub` rather than a bare `-`: a system clock stepping backwards (NTP, a resume)
        // must not underflow into a huge "silence" and reload a healthy app.
        assert!(!is_dead(10_000, 5_000, 30_000));
    }

    #[test]
    fn alive_marks_the_frontend_live_and_clears_a_pending_report() {
        REPORTING.store(true, Ordering::Relaxed);
        alive();
        assert!(!REPORTING.load(Ordering::Relaxed));
        assert!(LAST_SEEN_MS.load(Ordering::Relaxed) > 0);
    }

    #[test]
    fn the_title_reports_the_observation_not_a_diagnosis() {
        // THE CAP DECISION. A runaway must cost a reload, not the machine — but it must never fire on
        // ordinary work: a healthy renderer measured a few hundred MB against an 8 GB default.
        assert!(over_cap(9_000, 8_192), "past the cap");
        assert!(!over_cap(8_192, 8_192), "exactly at it is not past it");
        assert!(!over_cap(400, 8_192), "a normal renderer is nowhere near");
        // 0 DISABLES. The opt-out has to be safe to type — reading it as "kill everything" would turn
        // an attempt to switch the cap off into the most destructive setting available.
        assert!(!over_cap(30_000, 0), "a cap of 0 is disabled, not a cap of zero");

        // The busy-thread line: it exists because no stack can be taken here, so the thread NAMES are
        // the only signal for which subsystem is spinning.
        let t = threads_line(&[("WebKitWebProces".into(), 56_260), ("Heap Helper".into(), 12_000)]);
        assert!(t.contains("WebKitWebProces 56.3s"), "{t}");
        assert!(t.contains("Heap Helper 12.0s"), "{t}");
        // Nothing readable stays UNKNOWN rather than becoming an empty claim.
        assert!(threads_line(&[]).contains("unknown"));

        // THE 15-CHARACTER CAP. `TASK_COMM_LEN` is 16 including the NUL, so `/proc/<pid>/comm` holds
        // at most fifteen characters and the full 16-char name is never what is there. Comparing
        // against it meant the sampler matched NOTHING — the fault read `unknown` while the renderer
        // sat at 28.5 GB.
        assert!(is_renderer_comm("WebKitWebProces"), "the TRUNCATED name is what /proc actually holds");
        assert!(is_renderer_comm("WebKitWebProcess"), "and the full one, wherever it is not truncated");
        // The sibling network process is exactly 15 chars and must NOT count — it is small, and
        // mistaking it for the renderer would understate the peak by orders of magnitude.
        assert!(!is_renderer_comm("WebKitNetworkPr"));
        assert!(!is_renderer_comm("base-studio-cod"));
        assert!(!is_renderer_comm(""));

        // SAMPLED WHILE ALIVE, because the watchdog fires 30s after the renderer died and /proc has
        // nothing left to read. Never sampled must stay UNKNOWN — not "small".
        assert_eq!(last_observed_peak_mb(), None, "nothing sampled yet");
        assert_eq!(last_observed_peak_mb(), None, "a failed reading must not become a figure");

        // MONOTONIC, through the REAL fold. A fresh small renderer after a reload must not erase the
        // peak of the one that just died — the fault's question is how big it got BEFORE it died.
        assert_eq!(fold_peak(0, Some(27_500)), 27_500, "the first reading takes");
        assert_eq!(fold_peak(27_500, Some(300)), 27_500, "a smaller later reading does not win");
        assert_eq!(fold_peak(27_500, Some(30_000)), 30_000, "a bigger one does");
        // A FAILED reading is not evidence the renderer shrank.
        assert_eq!(fold_peak(27_500, None), 27_500);
        assert_eq!(fold_peak(0, None), 0, "and never invents a figure from nothing");

        // The peak has to reach the fault, or the fault reads the same at 400 MB as at 27 GB.
        let big = peak_line(Some(27_500));
        assert!(big.contains("26.86 GB"), "{big}");
        assert!(big.contains("27500 MB"), "the raw figure too, for a reader doing their own arithmetic");
        assert!(big.contains("render loop"), "names the shape a huge number implies");

        // ABSENT MUST NOT BECOME ZERO. "The renderer died at 0 MB" is a false statement, and this
        // fault exists to stop exactly that kind of confident-but-wrong record.
        let none = peak_line(None);
        assert!(none.contains("unknown"), "{none}");
        assert!(!none.contains("0.00 GB"), "an unreadable peak is not a measured zero: {none}");

        let t = dead_title(45_000);
        assert!(t.contains("45s"), "the title should say how long it was silent: {t}");
        // It must not claim a cause it cannot know — a kill, a crash and a freeze are the same here.
        assert!(!t.to_lowercase().contains("memory"), "the title must not diagnose: {t}");
    }

    #[test]
    fn the_detail_points_at_stderr_where_the_real_message_is() {
        let d = dead_detail();
        assert!(d.contains("STDERR") || d.contains("stderr") || d.contains("terminal"));
        assert!(d.contains("reloaded"), "the reader must be told the window was reloaded: {d}");
    }

    #[test]
    fn the_renderer_source_is_not_the_boot_source() {
        // A mount ack resolves everything under the BOOT tag. Sharing the tag would let the reload's
        // own successful mount clear the fault that recorded the death.
        assert_ne!(RENDERER_SOURCE, "app-boot");
    }
}
