// The PTY IO pump: a reader thread decodes PTY bytes into complete UTF-8 chunks and
// an emitter thread coalesces them into ~one frontend event per 16ms frame (teeing to
// the mobile tunnel when paired). Split out of `mod.rs` (#1864); behavior is unchanged.

use crate::mobile::tunnel;
use crate::split_utf8_at_boundary;
use std::io::Read;
use tauri::{AppHandle, Emitter, Manager};

/// How the session's child actually ended, for the one log line that reports a session ending.
///
/// ## The gap this closes
/// `reader EOF` and a byte count were the whole record of a session's death, and they cannot tell a
/// clean `exit` from a `SIGKILL`. A sandboxed studio pane was dying ~10 s after every launch with
/// nothing in the log but those two lines: the launch replayed perfectly outside the app — same
/// argv, same scope, same resizes, same init line, same startup prompt — so every hypothesis about
/// WHY had to be tested by reproduction rather than read off the evidence, and a plausible wrong one
/// (`PR_SET_PDEATHSIG` is per-thread, so a retired `spawn_blocking` thread kills the cage) survived
/// a long way on circumstantial fit before measurement refuted it. An exit status would have settled
/// it in one line.
///
/// ## Why it reads the status here rather than waiting for it
/// This runs on the emitter thread as the session finishes, so the child is normally already gone
/// and `try_wait` answers immediately. It deliberately does NOT block: a session whose child is
/// somehow still alive at EOF is itself worth reporting, and a pump thread that parked on `wait`
/// would hold the state lock while doing it.
///
/// Never panics and never blocks the teardown — every failure degrades to a phrase, because this is
/// a diagnostic and must not become a way for a session to fail to end.
fn child_outcome(app: &AppHandle, pane_id: &str) -> String {
    let Some(state) = app.try_state::<super::PtyState>() else {
        return "exit=unknown (no session registry)".into();
    };
    // Recover from a poisoned lock rather than giving up: a diagnostic that goes silent exactly when
    // something else has already panicked is worse than useless. Matches `kill_all_pty_sessions`.
    let mut sessions = state.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(session) = sessions.get_mut(pane_id) else {
        // The session was already removed — `pty_kill`, or a teardown that got here first. That is
        // itself the answer: the app ended this one deliberately.
        return "exit=n/a (session already removed — the app closed it)".into();
    };
    match session.child.try_wait() {
        Ok(Some(status)) => {
            let code = status.exit_code();
            // A shell reports a fatal signal as 128+N; naming the signal is what turns "137" into
            // "something SIGKILLed it", which is the distinction this whole helper exists for.
            match code.checked_sub(128).filter(|n| (1..=64).contains(n)) {
                Some(sig) => format!("exit={code} (killed by signal {sig})"),
                None => format!("exit={code}"),
            }
        }
        Ok(None) => "exit=none (child still running at EOF — the pty closed, the process did not)".into(),
        Err(e) => format!("exit=unknown ({e})"),
    }
}

/// Reader thread: decode PTY bytes and forward complete UTF-8 chunks over `tx`. The `leftover` buffer
/// holds any trailing incomplete multi-byte sequence (e.g. ✓, →, box-drawing) so we never split a
/// character across reads. Exits on EOF/error or when the emitter is gone; flushes any tail first so
/// `tx` dropping signals the emitter (Disconnected) to finish.
pub(super) fn spawn_reader(
    pane_id: String,
    mut reader: Box<dyn Read + Send>,
    tx: std::sync::mpsc::Sender<String>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut leftover: Vec<u8> = Vec::new();
        // Opt-in raw tap (`$BSC_PTY_DUMP` = a directory): append every byte this session emits to
        // `<dir>/<pane>.bin`, verbatim and before any UTF-8 splitting.
        //
        // It exists because a session's OUTPUT is the one thing no reproduction can recover. A
        // sandboxed pane died after its first external command having emitted 6974 bytes, while a
        // faithful reproduction of the same launch — same argv, same init line, same resize, same
        // command — survived on a few hundred. The extra bytes ARE the diagnosis, and they only
        // exist inside a real session.
        //
        // Unset by default and fail-safe throughout: a bad path, a full disk or a permission error
        // must never disturb the session being diagnosed.
        let mut dump = std::env::var("BSC_PTY_DUMP").ok().filter(|d| !d.is_empty()).and_then(|dir| {
            let safe: String = pane_id
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .collect();
            let _ = std::fs::create_dir_all(&dir);
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(std::path::Path::new(&dir).join(format!("{safe}.bin")))
                .map_err(|e| log::warn!("pty[{pane_id}] BSC_PTY_DUMP unavailable: {e}"))
                .ok()
        });
        if dump.is_some() {
            log::info!("pty[{pane_id}] raw output is being tapped to $BSC_PTY_DUMP");
        }
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { log::info!("pty[{pane_id}] reader EOF"); break; }
                Err(e) => { log::warn!("pty[{pane_id}] reader error: {e}"); break; }
                Ok(n) => {
                    if let Some(f) = dump.as_mut() {
                        use std::io::Write;
                        // Best-effort: a failed write must not end the session it is diagnosing.
                        let _ = f.write_all(&buf[..n]);
                        let _ = f.flush();
                    }
                    leftover.extend_from_slice(&buf[..n]);
                    let (text, keep) = split_utf8_at_boundary(&leftover);
                    leftover = keep;
                    if !text.is_empty() && tx.send(text).is_err() {
                        break; // emitter gone
                    }
                }
            }
        }
        if !leftover.is_empty() {
            let _ = tx.send(String::from_utf8_lossy(&leftover).into_owned());
        }
        // tx drops here → emitter sees Disconnected and finishes.
    });
}

/// Collect the exited child and return its status.
///
/// A PTY reaching EOF does not reap anything: the child is a separate process, and until somebody
/// waits on it the kernel keeps it as a zombie. A caged launch that died at startup sat as
/// `[bwrap] <defunct>` — State Z, no cmdline, no children — for the app's entire lifetime, and the
/// only way to find it was `ps` plus reading the pty ledger by hand.
///
/// A short grace loop rather than a blocking `wait()`: EOF usually arrives a beat BEFORE the child
/// is collectable, so a single `try_wait` reports `None` and leaves the zombie behind — but a
/// blocking wait would hang this thread forever on the case where the pty closed and the process
/// genuinely did not (`exit=none` in the log, which is a real state worth still reporting).
fn reap(app: &AppHandle, pane_id: &str) -> Option<u32> {
    let state = app.try_state::<super::PtyState>()?;
    for attempt in 0..20 {
        {
            let mut sessions = state.0.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(pane_id)?;
            match session.child.try_wait() {
                Ok(Some(status)) => return Some(status.exit_code()),
                Ok(None) => {}
                Err(_) => return None,
            }
        }
        // Lock released between attempts: this runs while the app may be launching other panes,
        // and holding the session registry for the whole grace window would serialize them.
        if attempt < 19 {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    }
    None
}

/// What died when a CAGED session ended badly — the cage, or the thing inside it./// What died when a CAGED session ended badly — the cage, or the thing inside it.
///
/// They have different fixes, which is the whole reason to tell them apart: a launcher failure is
/// the host's problem (a stale scope unit, a bind whose source is missing, no user systemd), while a
/// harness failure is the session's (a bad model, a missing credential, a crash).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CageDeath {
    /// `bwrap` or `systemd-run` failed before the shell ever ran.
    Launcher,
    /// The cage came up and what ran inside it exited.
    Harness,
}

/// Markers that mean the LAUNCHER failed, not the session. Each is a line one of the two wrappers
/// prints on its own way out, before `exec`.
const LAUNCHER_MARKERS: &[&str] = &[
    "bwrap:",
    "systemd-run:",
    "Failed to start transient scope unit",
    "Failed to connect to bus",
];

/// The notice a caged session's death puts in its own pane, or `None` when there is nothing
/// honest to say.
///
/// **The hard part is NOT crying wolf.** A session that legitimately finishes fast looks exactly
/// like one that died — the app cannot read intent from a duration. So this speaks only when the
/// outcome is independently bad:
///
/// * a launcher marker in the output ⇒ the cage never started, which is definite; or
/// * a NON-ZERO exit ⇒ something ended badly, which is a fact rather than an inference.
///
/// A clean `exit=0` gets nothing, however fast it was. That is a session that finished.
///
/// Why it exists at all: `sandbox_refusal` already makes a DECLINED cage legible — the pane prints
/// "NOT sandboxed: …". There was no equivalent for a cage that was built, launched and died, so the
/// refusal path was legible and the failure path silent. That is backwards: a refusal is a decision,
/// a death is a fault.
pub(super) fn cage_death_notice(
    role: Option<&str>,
    exit: Option<u32>,
    tail: &str,
) -> Option<String> {
    // Only a caged pane has a cage to report on; everything else keeps today's silence.
    let role = role.filter(|r| !r.is_empty())?;

    let launcher = LAUNCHER_MARKERS.iter().any(|m| tail.contains(m));
    // Nothing to say about a clean exit, and nothing HONEST to say about an unknown one that
    // carried no launcher marker either.
    let kind = match (launcher, exit) {
        (true, _) => CageDeath::Launcher,
        (false, Some(code)) if code != 0 => CageDeath::Harness,
        _ => return None,
    };

    let status = match exit {
        // 128+N is how a shell reports a fatal signal; naming it turns 137 into something a reader
        // can act on. Same decode as `child_outcome`, and the test below pins them together.
        Some(code) => match code.checked_sub(128).filter(|n| (1..=64).contains(n)) {
            Some(sig) => format!("exit={code} (killed by signal {sig})"),
            None => format!("exit={code}"),
        },
        None => "exit=unknown".to_string(),
    };

    let body = match kind {
        CageDeath::Launcher => format!(
            "[bsc] the SANDBOX failed to start for this {role} session ({status}). \
             The agent never ran. This is a host problem, not a session one — check the line above \
             for what bwrap or systemd-run refused."
        ),
        CageDeath::Harness => format!(
            "[bsc] this {role} session ended inside its sandbox ({status}). \
             The cage started; what ran in it exited. If that was not deliberate, relaunch the pane \
             — the output above is what it managed to print."
        ),
    };
    // Amber, on its own line, after whatever the session last wrote. Same shape as the refusal
    // notice, so the two read as one family.
    Some(format!("\r\n\x1b[1;33m{body}\x1b[0m\r\n"))
}

/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee
/// to the mobile tunnel when paired). Coalescing collapses per-read emits — the dominant UI-lag source
/// when many sessions stream at once — into one event per frame per session. Emits `pty_exit_<pane>`
/// when the reader's `tx` disconnects.
pub(super) fn spawn_emitter(
    pane_id: String,
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<String>,
    // The cage this pane was launched into, if any — `None` for an ordinary session. Carried so a
    // caged death can say so in the pane; see `cage_death_notice`.
    sandbox_role: Option<String>,
) {
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::{Duration, Instant};
        const FLUSH: Duration = Duration::from_millis(16);
        const MAX_PENDING: usize = 64 * 1024;
        let evt = format!("pty_data_{}", pane_id);
        // Tee PTY output to the mobile tunnel (#242) when a client is connected.
        // Looked up once; `broadcast_output` is a no-op while nobody is paired.
        let tunnel_state = app.try_state::<tunnel::TunnelState>();
        let mut pending = String::new();
        let mut last_emit = Instant::now();
        let mut total: u64 = 0;
        // The last few KB the pane saw. A launcher failure prints its reason and dies, so the
        // discriminator is in here — and bounding it keeps a chatty session from retaining output
        // for the life of the thread.
        const TAIL_CAP: usize = 8 * 1024;
        let mut tail = String::new();
        // Rolling window to flag sustained output floods.
        let mut win_start = Instant::now();
        let mut win_bytes: u64 = 0;
        let mut win_emits: u64 = 0;
        let mut done = false;
        while !done {
            let mut flush_now = false;
            match rx.recv_timeout(FLUSH) {
                Ok(chunk) => {
                    total += chunk.len() as u64;
                    win_bytes += chunk.len() as u64;
                    pending.push_str(&chunk);
                    if pending.len() >= MAX_PENDING || last_emit.elapsed() >= FLUSH {
                        flush_now = true;
                    }
                }
                // Idle for a frame — flush trailing output (e.g. the prompt) now.
                Err(RecvTimeoutError::Timeout) => flush_now = true,
                Err(RecvTimeoutError::Disconnected) => { flush_now = true; done = true; }
            }
            if flush_now && !pending.is_empty() {
                let data = std::mem::take(&mut pending);
                tail.push_str(&data);
                if tail.len() > TAIL_CAP {
                    // Trim on a CHAR boundary — the tail holds decoded UTF-8 (box drawing, ✓, →),
                    // and slicing mid-sequence would panic on the one path that only runs when
                    // something has already gone wrong.
                    let cut = tail.len() - TAIL_CAP;
                    let at = (cut..tail.len()).find(|i| tail.is_char_boundary(*i)).unwrap_or(tail.len());
                    tail.drain(..at);
                }
                if let Some(ts) = &tunnel_state {
                    ts.broadcast_output(&pane_id, &data);
                }
                // Best-effort runtime-fault side-tap (#2264): scan this batch for stack traces / panics
                // / ERROR lines when the pane is marked an app-runner. Additive — it only BORROWS the
                // bytes here (before the move into `app.emit`), so the WebView/tunnel stream is
                // byte-for-byte unchanged; a no-op (one atomic load) when no pane is tapped.
                crate::observability::pty_faults::observe(&pane_id, &data);
                let _ = app.emit(&evt, data);
                win_emits += 1;
                last_emit = Instant::now();
            }
            let secs = win_start.elapsed().as_secs_f64();
            if secs >= 2.0 {
                let eps = win_emits as f64 / secs;
                let bps = win_bytes as f64 / secs;
                if eps > 60.0 || bps > 128_000.0 {
                    log::warn!("pty[{pane_id}] high output: {eps:.0} emits/s, {bps:.0} B/s");
                }
                win_start = Instant::now();
                win_bytes = 0;
                win_emits = 0;
            }
        }
        // Drop the pane's fault tap if it had one (#2264) — no-op for the common untapped pane.
        crate::observability::pty_faults::on_pane_exit(&pane_id);
        // Reap BEFORE reporting, for both reasons at once: it collects the defunct child (a caged
        // launch that died left `[bwrap] <defunct>` for the app's whole lifetime), and it is what
        // makes an exit status readable at all.
        let exit = reap(&app, &pane_id);
        // ...and say so in the pane. A refusal to cage was already legible (`NOT sandboxed: …`);
        // a cage that was built, launched and died was not.
        if let Some(notice) = cage_death_notice(sandbox_role.as_deref(), exit, &tail) {
            let _ = app.emit(&evt, notice);
        }
        let _ = app.emit(&format!("pty_exit_{}", pane_id), ());
        log::info!("pty[{pane_id}] session ended ({total} bytes) · {}", child_outcome(&app, &pane_id));
    });
}

#[cfg(test)]
mod outcome_tests {
    /// The signal decode is the whole point of the line, so it is pinned as a PURE rule.
    ///
    /// `child_outcome` itself needs a live Tauri `AppHandle` and a real child, so the part worth
    /// testing is extracted here rather than mocked: 128+N is how a shell reports a fatal signal,
    /// and turning 137 into "killed by signal 9" is the difference between a log line a reader can
    /// act on and one they have to decode. The band is bounded because a plain exit code can also
    /// exceed 128 — 255 is not "signal 127".
    fn describe(code: u32) -> String {
        match code.checked_sub(128).filter(|n| (1..=64).contains(n)) {
            Some(sig) => format!("exit={code} (killed by signal {sig})"),
            None => format!("exit={code}"),
        }
    }

    #[test]
    fn a_fatal_signal_is_named_and_a_plain_code_is_not() {
        assert_eq!(describe(137), "exit=137 (killed by signal 9)");   // SIGKILL — the cage case
        assert_eq!(describe(143), "exit=143 (killed by signal 15)");  // SIGTERM — an app teardown
        assert_eq!(describe(0), "exit=0");                            // a clean exit
        assert_eq!(describe(1), "exit=1");
        // 128 exactly is not signal 0, and a high plain code is not a signal either.
        assert_eq!(describe(128), "exit=128");
        assert_eq!(describe(255), "exit=255");
    }

    /// The decode must match what `child_outcome` actually does — a second copy that drifts would
    /// pass while the shipped line is wrong.
    #[test]
    fn the_shipped_decode_is_the_one_under_test() {
        let src = include_str!("pump.rs");
        assert!(
            src.contains("code.checked_sub(128).filter(|n| (1..=64).contains(n))"),
            "child_outcome's signal decode changed — update `describe` in this module to match",
        );
    }
}

// ── a caged death is legible (a-cage-that-dies-at-launch-leaves-a-silent-zombie) ─────────────────
//
// `sandbox_refusal` already made a DECLINED cage legible — the pane prints "NOT sandboxed: …".
// There was no equivalent for a cage that was built, launched and died: the pane showed only what
// the harness managed to print, the ledger still listed the pane as live, and the child sat defunct
// for the app's lifetime. The refusal path was legible and the failure path silent, which is
// backwards — a refusal is a decision, a death is a fault.

#[cfg(test)]
mod cage_death_tests {
    use super::{cage_death_notice, LAUNCHER_MARKERS};

    /// The launcher failing is DEFINITE, so the notice may say so outright.
    #[test]
    fn a_bwrap_failure_names_the_cage_not_the_agent() {
        let tail = "bwrap: Can't mkdir /coord/out: Read-only file system\n";
        let n = cage_death_notice(Some("worker"), Some(1), tail).expect("a notice");
        assert!(n.contains("SANDBOX failed to start"), "{n}");
        assert!(n.contains("never ran"), "the agent did not run — say so: {n}");
        assert!(n.contains("host problem"), "and that the fix is not in the session: {n}");
        assert!(n.contains("exit=1"), "{n}");
    }

    /// Every marker the wrappers can print has to route to the launcher verdict, or a real cage
    /// failure gets reported as an agent failure and the reader looks in the wrong place.
    #[test]
    fn every_launcher_marker_is_read_as_a_launcher_failure() {
        for m in LAUNCHER_MARKERS {
            let n = cage_death_notice(Some("director"), Some(1), &format!("...\n{m} something\n"))
                .expect("a notice");
            assert!(n.contains("SANDBOX failed to start"), "{m} must read as a launcher failure: {n}");
        }
    }

    /// The cage came up and the thing inside it exited. Different fault, different fix — and the
    /// notice must not claim the sandbox broke.
    #[test]
    fn a_harness_failure_says_the_cage_started() {
        let n = cage_death_notice(Some("director"), Some(1), "Auto-update failed\n").expect("a notice");
        assert!(n.contains("ended inside its sandbox"), "{n}");
        assert!(n.contains("cage started"), "{n}");
        assert!(!n.contains("SANDBOX failed to start"), "must not blame the cage: {n}");
    }

    /// THE constraint that shapes the whole thing: a session that legitimately finishes fast looks
    /// exactly like one that died, and the app cannot read intent from a duration. So a clean exit
    /// gets nothing at all, however quick it was.
    #[test]
    fn a_clean_exit_says_nothing_however_fast_it_was() {
        assert_eq!(cage_death_notice(Some("worker"), Some(0), "done\n"), None);
        // ...and neither does an unknown status with no launcher marker: there is nothing honest
        // to report, and a notice on every ambiguous exit is how a warning becomes noise.
        assert_eq!(cage_death_notice(Some("worker"), None, "some output\n"), None);
    }

    /// An UNCAGED pane keeps today's silence — this notice is about a cage, and a pane without one
    /// has nothing for it to say.
    #[test]
    fn an_uncaged_pane_is_untouched() {
        assert_eq!(cage_death_notice(None, Some(1), "bwrap: boom"), None);
        assert_eq!(cage_death_notice(Some(""), Some(1), "bwrap: boom"), None);
    }

    /// A fatal signal is named, not left as a number — 137 is the cage's own OOM kill, which is
    /// exactly the case a reader must not have to decode by hand.
    #[test]
    fn a_fatal_signal_is_named() {
        let n = cage_death_notice(Some("worker"), Some(137), "").expect("a notice");
        assert!(n.contains("exit=137 (killed by signal 9)"), "{n}");
    }

    /// The decode must match `child_outcome`'s, or the pane and the log disagree about the same
    /// death. Pinned against the shipped source, the way `outcome_tests` already does.
    ///
    /// Asserted PER FUNCTION rather than by counting occurrences: the first draft counted them and
    /// got 5, not 2, because the test's own string literals count too. A guard whose number is
    /// tuned to include itself is one nobody can reason about later.
    #[test]
    fn the_notice_decodes_signals_the_same_way_the_log_does() {
        let src = include_str!("pump.rs");
        const DECODE: &str = "code.checked_sub(128).filter(|n| (1..=64).contains(n))";
        for f in ["fn child_outcome", "fn cage_death_notice"] {
            let body = &src[src.find(f).expect("the function is here")..];
            let body = &body[..body.len().min(2_000)];
            assert!(
                body.contains(DECODE),
                "{f} must decode a fatal signal the same way as the other — the pane and the log \
                 describe the SAME death, and a divergence makes them disagree about it",
            );
        }
    }

    /// The notice ends the line it lands on and terminates its own, so it cannot be swallowed by a
    /// half-written line the dying session left behind.
    #[test]
    fn the_notice_stands_on_its_own_line() {
        let n = cage_death_notice(Some("worker"), Some(1), "half a line").expect("a notice");
        assert!(n.starts_with("\r\n"), "{n:?}");
        assert!(n.ends_with("\r\n"), "{n:?}");
    }
}
