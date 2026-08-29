// The PTY IO pump: a reader thread decodes PTY bytes into complete UTF-8 chunks and
// an emitter thread coalesces them into ~one frontend event per 16ms frame (teeing to
// the mobile tunnel when paired). Split out of `mod.rs` (#1864); behavior is unchanged.

use crate::mobile::tunnel;
use crate::split_utf8_at_boundary;
use std::io::Read;
use tauri::{AppHandle, Emitter, Manager};

/// WHY a session ended, in the vocabulary a reader has to act on differently
/// (#a-stopped-session-says-why).
///
/// The distinction that matters is not "did it stop" — the pane going quiet already says that — but
/// whose problem it is. A launcher failure is the HOST's (a stale scope unit, a bind whose source is
/// gone, no user systemd); a non-zero exit is the SESSION's; a signal is something outside both; and
/// an app-closed session is nobody's, because it was deliberate.
///
/// Serialized in camelCase because it crosses to the frontend on `pty_exit_<pane>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum EndReason {
    /// Exit 0. A session that FINISHED. Deliberately its own arm: reporting this as a fault is how
    /// an observability feature becomes noise the user learns to ignore.
    Finished,
    /// A non-zero exit from the thing that ran. The session's own problem.
    Failed,
    /// Killed by a fatal signal (the shell's 128+N). Outside the session and outside the app.
    Signalled,
    /// `bwrap` / `systemd-run` failed before the shell ever ran — the agent never started.
    LauncherFailed,
    /// The app removed the session first: `pty_kill`, a project teardown, app exit.
    AppClosed,
    /// The pty closed and we could not learn the status. Named rather than guessed.
    Unknown,
}

impl EndReason {
    /// Is this an outcome the user should be TOLD about, rather than one that is simply normal?
    /// A finished session and a deliberate close are not faults.
    pub(crate) fn is_fault(self) -> bool {
        matches!(self, Self::Failed | Self::Signalled | Self::LauncherFailed | Self::Unknown)
    }
}

/// How a session ended — the ONE computation behind the log line, the in-pane cage notice and the
/// `pty_exit_<pane>` payload.
///
/// It used to be three: `reap` read the status, `cage_death_notice` re-derived the signal decode from
/// it, and `child_outcome` called `try_wait` a SECOND time to build a string for the log. The event
/// the frontend actually receives carried `()`, so the one consumer that could have shown the user
/// anything got nothing at all.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionEnd {
    pub pane_id: String,
    pub reason: EndReason,
    /// The raw exit code, when there was one.
    pub exit_code: Option<u32>,
    /// The fatal signal, decoded from the shell's 128+N convention.
    pub signal: Option<u32>,
    /// The cage this pane ran in, if any — a caged death reads differently from a host one.
    pub sandbox_role: Option<String>,
    /// One sentence, already phrased for a human. The banner shows this verbatim.
    pub detail: String,
    /// What the session last PRINTED, when it ended badly — sanitized and bounded by `last_words`.
    ///
    /// Only ever populated for a fault. Quoting a clean session's output would make the notice noise,
    /// and there is nothing to explain about an ending that went fine. `None` on a fault means the
    /// session printed nothing legible at all, which the caller reports rather than hides.
    pub last_output: Option<String>,
}

/// How much of the session's own final output travels with a fault, in characters.
///
/// Small on purpose. This rides a Tauri event and lands in a BANNER: the whole value is the last
/// line or two the session printed, and a bigger slice buys a taller banner rather than a better
/// answer. The full buffer is already in the pane for whoever is looking at it.
const LAST_WORDS_CAP: usize = 400;

/// How many non-empty lines of it to keep.
const LAST_WORDS_LINES: usize = 4;

/// The session's final output, made readable — what the pane last printed, with the terminal taken
/// out of it.
///
/// A TUI's buffer is mostly escape sequences: cursor moves, colour, erase-line, the redraw of a
/// frame. Quoting it raw gives a banner a wall of `\x1b[2K\x1b[1G` with the one line that matters
/// buried in it — the reported worker printed 18116 bytes on its way out and essentially all of it
/// was redraw. So this strips the terminal control layer, keeps the last few lines that actually
/// carry text, and bounds the result.
///
/// PURE, so the shape of a real TUI tail is testable without a PTY.
///
/// Returns `None` when nothing legible survives. That is a DIFFERENT answer from a short one and the
/// caller says so: a session that printed nothing at all before dying is itself a finding, where an
/// empty quote in a banner just reads as a broken banner.
pub(super) fn last_words(tail: &str) -> Option<String> {
    // CSI / OSC and friends. Hand-rolled rather than a crate: the grammar we actually meet here is
    // `ESC [ … final-byte` and `ESC ] … BEL|ST`, and a dependency for that is not worth the audit.
    let mut out = String::with_capacity(tail.len());
    let mut chars = tail.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            // Keep newline and tab; drop every other C0/C7 control, which is what makes a banner
            // render the text rather than the terminal's intentions.
            if c == '\n' || c == '\t' || !c.is_control() {
                out.push(if c == '\t' { ' ' } else { c });
            }
            continue;
        }
        match chars.next() {
            // CSI: parameters/intermediates, then a final byte in @..~
            Some('[') => {
                for f in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&f) {
                        break;
                    }
                }
            }
            // OSC: runs to BEL or ST (ESC \).
            Some(']') => {
                while let Some(f) = chars.next() {
                    if f == '\u{7}' {
                        break;
                    }
                    if f == '\u{1b}' {
                        chars.next();
                        break;
                    }
                }
            }
            // Any other two-byte escape — consume the second byte and move on.
            Some(_) => {}
            None => break,
        }
    }

    let mut lines: Vec<&str> = out
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    if lines.is_empty() {
        return None;
    }
    // The LAST lines: a dying process says the useful thing on the way out, not on the way in.
    if lines.len() > LAST_WORDS_LINES {
        lines.drain(..lines.len() - LAST_WORDS_LINES);
    }
    let mut text = lines.join(" / ");
    if text.chars().count() > LAST_WORDS_CAP {
        // Keep the END, and cut on a char boundary — this is decoded UTF-8 and a byte slice would
        // panic on the box-drawing a TUI is full of.
        let skip = text.chars().count() - LAST_WORDS_CAP;
        text = format!("…{}", text.chars().skip(skip).collect::<String>());
    }
    Some(text)
}

/// Decode the shell's 128+N fatal-signal convention. Bounded because a plain exit code can also
/// exceed 128 — 255 is not "signal 127". The one definition; `child_status_phrase` and
/// `classify_end` both read it, so the log line and the banner can never disagree.
pub(super) fn signal_from_code(code: u32) -> Option<u32> {
    code.checked_sub(128).filter(|n| (1..=64).contains(n))
}

/// Classify a finished session from the facts the emitter already holds. PURE, so every arm is
/// testable without a Tauri handle or a real child — which is what `child_outcome` never was.
///
/// `removed` means the session was gone from the registry before we looked, which only happens when
/// the app took it out: that is the answer, not a missing one.
pub(super) fn classify_end(
    pane_id: &str,
    exit: Option<u32>,
    removed: bool,
    sandbox_role: Option<&str>,
    tail: &str,
) -> SessionEnd {
    let role = sandbox_role.filter(|r| !r.is_empty()).map(str::to_string);
    let launcher = role.is_some() && LAUNCHER_MARKERS.iter().any(|m| tail.contains(m));
    let signal = exit.and_then(signal_from_code);

    let (reason, detail) = if launcher {
        (EndReason::LauncherFailed, format!(
            "The sandbox failed to start{}, so the agent never ran. This is a host problem, not a session one.",
            role.as_deref().map(|r| format!(" for this {r} session")).unwrap_or_default(),
        ))
    } else if removed {
        (EndReason::AppClosed, "Closed by the app — a kill, a project teardown, or app exit.".to_string())
    } else {
        match (exit, signal) {
            (_, Some(sig)) => (EndReason::Signalled, format!("Killed by signal {sig}.")),
            (Some(0), _) => (EndReason::Finished, "Finished — the agent exited cleanly.".to_string()),
            (Some(code), _) => (EndReason::Failed, format!(
                "The agent exited with status {code}{}.",
                role.as_deref().map(|r| format!(" inside its {r} sandbox")).unwrap_or_default(),
            )),
            (None, _) => (EndReason::Unknown, "The terminal closed but the exit status could not be read.".to_string()),
        }
    };
    // The tail is only quoted for a FAULT. It is already in hand either way — `cage_death_notice`
    // greps the same buffer — so this costs nothing but says nothing when nothing is wrong.
    let last_output = if reason.is_fault() { last_words(tail) } else { None };
    SessionEnd {
        pane_id: pane_id.to_string(),
        reason,
        exit_code: exit,
        signal,
        sandbox_role: role,
        detail,
        last_output,
    }
}

/// The `exit=…` phrase the session-ending log line has always carried. Kept byte-identical so the
/// existing log shape (and anything grepping it) is unchanged, now derived from the classification
/// rather than from a second `try_wait`.
pub(super) fn child_status_phrase(end: &SessionEnd) -> String {
    match end.reason {
        EndReason::AppClosed => "exit=n/a (session already removed — the app closed it)".into(),
        EndReason::Unknown => "exit=unknown".into(),
        _ => match (end.exit_code, end.signal) {
            (Some(code), Some(sig)) => format!("exit={code} (killed by signal {sig})"),
            (Some(code), None) => format!("exit={code}"),
            _ => "exit=unknown".into(),
        },
    }
}

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
/// Was this pane's session STILL REGISTERED when we came to report it?
///
/// `false` means the app took it out first — `pty_kill`, a project teardown, app exit — which is the
/// answer rather than a missing one, and is why `classify_end` takes it as a fact instead of
/// inferring "deliberate" from an absent status.
///
/// Recovers from a poisoned lock rather than giving up: a diagnostic that goes silent exactly when
/// something else has already panicked is worse than useless. Matches `kill_all_pty_sessions`.
fn session_present(app: &AppHandle, pane_id: &str) -> bool {
    let Some(state) = app.try_state::<super::PtyState>() else { return false };
    let sessions = state.0.lock().unwrap_or_else(|e| e.into_inner());
    sessions.contains_key(pane_id)
}

/// Reader thread: decode PTY bytes and forward complete UTF-8 chunks over `tx`. The `leftover` buffer
/// holds any trailing incomplete multi-byte sequence (e.g. ✓, →, box-drawing) so we never split a
/// character across reads. Exits on EOF/error or when the emitter is gone; flushes any tail first so
/// `tx` dropping signals the emitter (Disconnected) to finish.
pub(super) fn spawn_reader(
    pane_id: String,
    mut reader: Box<dyn Read + Send>,
    tx: std::sync::mpsc::Sender<(String, Option<u64>)>,
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
        // Durable scrollback (#pty-output-is-recorded-to-disk-at-safe-boundaries). ALWAYS on, unlike
        // the diagnostic tap above: this is the store that lets the lossy in-memory buffers go. Placed
        // here, beside the tap, because this is the one point that sees the bytes VERBATIM — before
        // `split_utf8_at_boundary` and before any consumer — which is what a faithful replay needs.
        //
        // `None` when it cannot be opened, and that is the whole error policy: recording is a
        // convenience, the session is the product.
        let mut record = super::scrollback::ScrollbackRecorder::open(
            &super::scrollback::scrollback_dir(),
            &pane_id,
        );
        if record.is_none() {
            log::warn!("pty[{pane_id}] scrollback recording unavailable — history stays memory-only");
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
                    // Raw, unsplit, before anything interprets it — see the recorder's module doc for
                    // why an arbitrary offset is not replayable and what it does about that.
                    if let Some(r) = record.as_mut() {
                        r.write(&buf[..n]);
                    }
                    leftover.extend_from_slice(&buf[..n]);
                    let (text, keep) = split_utf8_at_boundary(&leftover);
                    leftover = keep;
                    // The RECORDING offset after this read, carried alongside the text so the emitter
                    // can say exactly how far the frontend has been sent. `None` when nothing is being
                    // recorded, which a reveal reads as "no history".
                    //
                    // Note this is the offset after the whole READ, while `text` may be one byte short
                    // of it when a multi-byte character straddles the boundary. That is the safe
                    // direction: the cursor can only ever lag the recording, never lead it, so a replay
                    // bounded by it can never include a byte the frontend has not been sent.
                    let at = record.as_ref().map(|r| r.len());
                    if !text.is_empty() && tx.send((text, at)).is_err() {
                        break; // emitter gone
                    }
                }
            }
        }
        if !leftover.is_empty() {
            let at = record.as_ref().map(|r| r.len());
            let _ = tx.send((String::from_utf8_lossy(&leftover).into_owned(), at));
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
        Some(code) => match signal_from_code(code) {
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
    rx: std::sync::mpsc::Receiver<(String, Option<u64>)>,
    // How far the frontend has been sent, shared with any reveal in flight. See `scrollback::Cursor`:
    // holding this across the emit is what makes the replay/live handoff seamless.
    cursor: super::scrollback::Cursor,
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
        // The recording offset the batch in `pending` reaches. Published to the cursor as the batch
        // goes out, so the cursor always names a byte the frontend has actually received.
        let mut pending_at: Option<u64> = None;
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
                Ok((chunk, at)) => {
                    total += chunk.len() as u64;
                    win_bytes += chunk.len() as u64;
                    pending.push_str(&chunk);
                    if at.is_some() {
                        pending_at = at;
                    }
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
                // Publish the cursor and emit UNDER THE SAME LOCK. A reveal takes this lock, so it
                // either sees the state before this batch (and the batch reaches it live afterwards)
                // or the state after (and the batch is already in its replay) — never half of each.
                // That is the entire seam, closed in the one place that owns the bytes.
                {
                    let guard = cursor.lock();
                    let _ = app.emit(&evt, data);
                    if let (Ok(mut c), Some(at)) = (guard, pending_at.take()) {
                        *c = Some(at);
                    }
                }
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
        // Drop this pane's scrollback cursor. Pane ids are not all long-lived — `debug-studio:req-163`
        // and its kin are minted per request — so leaving them in the map would grow it for the life
        // of the app, which is precisely the kind of leak this whole effort exists to remove.
        if let Some(cs) = app.try_state::<super::scrollback::Cursors>() {
            cs.remove(&pane_id);
        }
        // Drop the pane's fault tap if it had one (#2264) — no-op for the common untapped pane.
        crate::observability::pty_faults::on_pane_exit(&pane_id);
        // Reap BEFORE reporting, for both reasons at once: it collects the defunct child (a caged
        // launch that died left `[bwrap] <defunct>` for the app's whole lifetime), and it is what
        // makes an exit status readable at all.
        let exit = reap(&app, &pane_id);
        // ONE classification, three consumers (#a-stopped-session-says-why). The registry probe
        // happens here, before anything else can remove the session, so "the app closed it" is a
        // fact observed at the right moment rather than inferred later from a missing status.
        let end = classify_end(&pane_id, exit, !session_present(&app, &pane_id), sandbox_role.as_deref(), &tail);
        // ...and say so in the pane. A refusal to cage was already legible (`NOT sandboxed: …`);
        // a cage that was built, launched and died was not.
        //
        // This stays, and is NOT what the user reads. It lives in the buffer of the thing that just
        // died: the reported worker was recreated seconds later and the notice went with the old
        // terminal. It is for whoever is looking AT the pane when it happens; the payload below is
        // for everyone else.
        if let Some(notice) = cage_death_notice(sandbox_role.as_deref(), exit, &tail) {
            let _ = app.emit(&evt, notice);
        }
        // The payload the frontend needs to say WHY. This used to be `()` — the emitter had the exit
        // status in hand, spent it on one log line, and handed the one consumer that could show a
        // user anything an empty tuple.
        let _ = app.emit(&format!("pty_exit_{}", pane_id), &end);
        // A FAULT logs at warn, a clean finish at info. The app log is the record that outlives the
        // banner's five seconds, so the level is what makes `grep WARN` a list of sessions that died
        // rather than a list of sessions that ended — and 15 endings in one run, 9 of them failures,
        // is exactly the shape that was previously indistinguishable at a glance.
        let phrase = child_status_phrase(&end);
        if end.reason.is_fault() {
            // The last words go in the LOG too, not just the banner — the banner lasts five seconds
            // and this is the copy that is still there tomorrow. `printed nothing` is stated rather
            // than left as an absence, because a session that died silently is itself the finding.
            let words = end.last_output.as_deref().unwrap_or("(printed nothing)");
            log::warn!("pty[{pane_id}] session ended ({total} bytes) · {phrase} · {} · last output: {words}", end.detail);
        } else {
            log::info!("pty[{pane_id}] session ended ({total} bytes) · {phrase}");
        }
    });
}

#[cfg(test)]
mod end_tests {
    use super::*;

    fn end(exit: Option<u32>, removed: bool, role: Option<&str>, tail: &str) -> SessionEnd {
        classify_end("proj:stream", exit, removed, role, tail)
    }

    /// THE REPORTED SHAPE. Nine of the fifteen session endings in one run were `exit=1` on ONE
    /// worker — not a kill, not a reap, not a signal. The app knew the status every time and the
    /// event carried `()`, so the user was told nothing.
    #[test]
    fn a_nonzero_exit_is_a_failure_that_names_its_status() {
        let e = end(Some(1), false, Some("worker"), "");
        assert_eq!(e.reason, EndReason::Failed);
        assert_eq!(e.exit_code, Some(1));
        assert_eq!(e.signal, None);
        assert!(e.reason.is_fault());
        assert!(e.detail.contains("status 1"), "{}", e.detail);
        assert!(e.detail.contains("worker sandbox"), "a caged death says so: {}", e.detail);
    }

    /// A session that FINISHED is not a fault. This is the arm that keeps the banner from becoming
    /// noise the user learns to ignore — every clean end would otherwise pop one.
    #[test]
    fn a_clean_exit_is_finished_not_failed() {
        let e = end(Some(0), false, Some("worker"), "");
        assert_eq!(e.reason, EndReason::Finished);
        assert!(!e.reason.is_fault());
        assert_eq!(child_status_phrase(&e), "exit=0");
    }

    /// 128+N is how a shell reports a fatal signal. Naming it is what turns 137 into something a
    /// reader can act on — and it must beat the plain-failure arm, or every signal would read as
    /// "exited with status 137".
    #[test]
    fn a_signal_is_named_and_outranks_the_plain_failure_arm() {
        let e = end(Some(137), false, None, "");
        assert_eq!(e.reason, EndReason::Signalled);
        assert_eq!(e.signal, Some(9));
        assert!(e.detail.contains("signal 9"), "{}", e.detail);
        assert_eq!(child_status_phrase(&e), "exit=137 (killed by signal 9)");
    }

    /// A plain exit code can exceed 128 — 255 is not "signal 127". The band is bounded, and this is
    /// the same rule the log line has always used.
    #[test]
    fn a_high_exit_code_is_not_mistaken_for_a_signal() {
        assert_eq!(signal_from_code(255), None);
        assert_eq!(signal_from_code(128), None);
        assert_eq!(signal_from_code(129), Some(1));
        assert_eq!(signal_from_code(192), Some(64));
        assert_eq!(signal_from_code(193), None);
        assert_eq!(end(Some(255), false, None, "").reason, EndReason::Failed);
    }

    /// A LAUNCHER failure is the host's problem and the agent never ran — a different fix from a
    /// session that started and died, which is the whole reason the two are told apart. It outranks
    /// the exit code, because bwrap's own status says nothing about the agent.
    #[test]
    fn a_launcher_failure_outranks_the_exit_code_and_says_the_agent_never_ran() {
        let e = end(Some(1), false, Some("worker"), "bwrap: Can't bind mount /nope\n");
        assert_eq!(e.reason, EndReason::LauncherFailed);
        assert!(e.detail.contains("never ran"), "{}", e.detail);
        assert!(e.detail.contains("host problem"), "{}", e.detail);
    }

    /// A launcher marker only means anything for a CAGED pane. An uncaged session that happens to
    /// print the word `bwrap:` must not be reported as a sandbox failure it never had.
    #[test]
    fn an_uncaged_session_never_reports_a_launcher_failure() {
        let e = end(Some(1), false, None, "bwrap: not that it matters here\n");
        assert_eq!(e.reason, EndReason::Failed);
    }

    /// The app taking the session out first IS the answer, not a missing one — and it must not be
    /// dressed up as a fault, or every deliberate close would alarm the user.
    #[test]
    fn a_session_the_app_removed_is_reported_as_deliberate() {
        let e = end(Some(1), true, Some("worker"), "");
        assert_eq!(e.reason, EndReason::AppClosed);
        assert!(!e.reason.is_fault());
        assert_eq!(child_status_phrase(&e), "exit=n/a (session already removed — the app closed it)");
    }

    /// An unreadable status is NAMED rather than guessed. It is still a fault: the pty closed and we
    /// cannot say the session finished.
    #[test]
    fn an_unreadable_status_is_named_not_guessed() {
        let e = end(None, false, None, "");
        assert_eq!(e.reason, EndReason::Unknown);
        assert!(e.reason.is_fault());
        assert_eq!(child_status_phrase(&e), "exit=unknown");
    }

    // ── the LAST WORDS (#a-stopped-session-shows-its-last-words) ───────────────────────────────

    /// A TUI's dying buffer is mostly redraw. The reported worker printed 18116 bytes on its way out
    /// and essentially all of it was escape sequences — quoting that raw gives a banner a wall of
    /// control codes with the one useful line buried inside.
    #[test]
    fn the_terminal_is_stripped_out_of_the_last_words() {
        let tail = "\u{1b}[2K\u{1b}[1G\u{1b}[32mWelcome\u{1b}[0m\r\n\u{1b}[31mError: credentials expired\u{1b}[0m\r\n";
        let w = last_words(tail).expect("something legible");
        assert!(w.contains("Error: credentials expired"), "{w}");
        assert!(!w.contains('\u{1b}'), "no escapes survive: {w:?}");
        assert!(!w.contains("[31m"), "no CSI bodies survive: {w:?}");
        assert!(!w.contains('\r'), "no bare control chars: {w:?}");
    }

    /// An OSC sequence (a title set, the OSC-7 cwd report the shell rc emits) runs to BEL or ST and
    /// must not swallow the rest of the buffer with it.
    #[test]
    fn an_osc_sequence_is_consumed_without_eating_the_message() {
        let bel = last_words("\u{1b}]0;a title\u{7}the real message").expect("text");
        assert_eq!(bel, "the real message");
        let st = last_words("\u{1b}]7;file://host/repo\u{1b}\\after").expect("text");
        assert_eq!(st, "after");
    }

    /// The LAST lines, because a dying process says the useful thing on its way out.
    #[test]
    fn only_the_final_lines_are_kept_and_blanks_are_dropped() {
        let tail = "one\n\n\ntwo\nthree\nfour\nfive\nsix\n";
        let w = last_words(tail).expect("text");
        assert!(w.starts_with("three"), "{w}");
        assert!(w.ends_with("six"), "{w}");
        assert!(!w.contains("one"), "older lines are dropped: {w}");
    }

    /// Bounded, because this rides an event into a BANNER — a bigger slice buys a taller banner
    /// rather than a better answer.
    #[test]
    fn the_last_words_are_capped_and_keep_the_end() {
        let tail = format!("{}TAILEND", "x".repeat(5_000));
        let w = last_words(&tail).expect("text");
        assert!(w.chars().count() <= LAST_WORDS_CAP + 1, "capped: {}", w.chars().count());
        assert!(w.ends_with("TAILEND"), "the END is what matters: {w}");
        assert!(w.starts_with('…'), "and the cut is marked: {w}");
    }

    /// Cutting DECODED UTF-8 by bytes would panic on the box-drawing a TUI is full of.
    #[test]
    fn a_multibyte_tail_is_cut_on_a_char_boundary() {
        let tail = "─".repeat(5_000);
        let w = last_words(&tail).expect("text");
        assert!(w.chars().count() <= LAST_WORDS_CAP + 1);
    }

    /// A session that printed NOTHING legible is its own finding — `None` rather than an empty
    /// string, so the caller can say "printed nothing" instead of showing an empty quote.
    #[test]
    fn a_tail_with_no_text_is_none_not_an_empty_string() {
        assert_eq!(last_words(""), None);
        assert_eq!(last_words("\u{1b}[2K\u{1b}[1G\r\n   \n"), None, "pure redraw is nothing");
    }

    /// Only a FAULT quotes the output. A clean ending has nothing to explain, and quoting it is how
    /// the notice becomes noise the user learns to scroll past.
    #[test]
    fn only_a_fault_carries_the_last_words() {
        let tail = "Error: something broke";
        assert_eq!(end(Some(1), false, None, tail).last_output.as_deref(), Some("Error: something broke"));
        assert_eq!(end(Some(0), false, None, tail).last_output, None, "a clean exit explains nothing");
        assert_eq!(end(Some(1), true, None, tail).last_output, None, "the app closing it explains nothing");
    }

    /// The wire shape again, now that the payload grew a field the banner reads.
    #[test]
    fn the_last_words_reach_the_wire() {
        let json = serde_json::to_value(end(Some(1), false, Some("worker"), "boom")).unwrap();
        assert_eq!(json["lastOutput"], "boom");
        assert!(serde_json::to_value(end(Some(0), false, None, "boom")).unwrap()["lastOutput"].is_null());
    }

    /// The payload crosses to the frontend, so its wire shape is part of the contract — a renamed
    /// field or a re-spelled variant silently stops the banner from rendering.
    #[test]
    fn the_payload_wire_shape_is_stable() {
        let json = serde_json::to_value(end(Some(137), false, Some("worker"), "")).unwrap();
        assert_eq!(json["paneId"], "proj:stream");
        assert_eq!(json["reason"], "signalled");
        assert_eq!(json["exitCode"], 137);
        assert_eq!(json["signal"], 9);
        assert_eq!(json["sandboxRole"], "worker");
        assert!(json["detail"].as_str().is_some_and(|d| !d.is_empty()));
        assert_eq!(serde_json::to_value(end(Some(1), false, Some("w"), "bwrap: x")).unwrap()["reason"],
                   "launcher-failed", "kebab-case, as the frontend union spells it");
    }

    /// The log phrase is unchanged from what `child_outcome` produced, so anything grepping the app
    /// log still matches. Pinned because the string moved to a new derivation.
    #[test]
    fn the_log_phrase_is_byte_identical_to_what_it_replaced() {
        assert_eq!(child_status_phrase(&end(Some(1), false, None, "")), "exit=1");
        assert_eq!(child_status_phrase(&end(Some(137), false, None, "")), "exit=137 (killed by signal 9)");
        assert_eq!(child_status_phrase(&end(Some(1), true, None, "")),
                   "exit=n/a (session already removed — the app closed it)");
    }
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

    /// The signal decode must exist ONCE, and every consumer must call it.
    ///
    /// This used to assert the opposite — that the same expression appeared in BOTH `child_outcome`
    /// and `cage_death_notice` — because the decode was genuinely duplicated and the risk was that
    /// the two would drift and describe the same death differently. #a-stopped-session-says-why
    /// removed the duplication: `signal_from_code` is the one definition, and the pane notice, the
    /// log phrase and the `pty_exit` payload all read it. So the guard flips from "these two agree"
    /// to "there is only one of them", which is the stronger claim.
    ///
    /// Asserted PER FUNCTION over bounded source slices rather than by counting occurrences: the
    /// first draft of the old guard counted them and got 5, not 2, because the test's own string
    /// literals count too. A guard whose number is tuned to include itself is one nobody can reason
    /// about later — and the slices below stop well short of this module for the same reason.
    #[test]
    fn the_signal_decode_has_exactly_one_definition_and_every_consumer_calls_it() {
        let src = include_str!("pump.rs");
        const DECODE: &str = "checked_sub(128).filter(|n| (1..=64).contains(n))";
        let body_of = |f: &str| {
            let at = src.find(f).unwrap_or_else(|| panic!("{f} is here"));
            let rest = &src[at..];
            &rest[..rest.len().min(1_500)]
        };

        assert!(body_of("fn signal_from_code").contains(DECODE), "the one definition lives here");
        for f in ["fn classify_end", "fn cage_death_notice"] {
            assert!(
                // By NAME, not `name(` — `classify_end` passes it as a function value
                // (`and_then(signal_from_code)`), which is a call site just as much as a paren is.
                body_of(f).contains("signal_from_code"),
                "{f} must CALL the shared decode, not carry its own — the pane, the log and the \
                 banner describe the SAME death, and a second copy is how they start disagreeing",
            );
            assert!(
                !body_of(f).contains(DECODE),
                "{f} re-implements the decode instead of calling it",
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
