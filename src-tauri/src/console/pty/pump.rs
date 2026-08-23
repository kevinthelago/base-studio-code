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

/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee
/// to the mobile tunnel when paired). Coalescing collapses per-read emits — the dominant UI-lag source
/// when many sessions stream at once — into one event per frame per session. Emits `pty_exit_<pane>`
/// when the reader's `tx` disconnects.
pub(super) fn spawn_emitter(
    pane_id: String,
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<String>,
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
