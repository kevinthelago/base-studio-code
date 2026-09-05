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
    /// The raw exit code, when there was one — `None` for a KILLED child, which has no exit code.
    pub exit_code: Option<u32>,
    /// The fatal signal: the OS's own verdict when the child was killed, else the shell's 128+N.
    pub signal: Option<u32>,
    /// That signal's name (`Killed`, `Terminated`, …), so a reader does not have to remember which
    /// number SIGKILL is. Present whenever `signal` is, and on the rare kill whose name maps to no
    /// number — which is still far more than the `exit=1` this replaced.
    pub signal_name: Option<String>,
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
            // A CARRIAGE RETURN RETURNS TO COLUMN 0, so whatever follows OVERWRITES this line — it is
            // not appended to it. Dropping the `\r` as "just another control" concatenates the two,
            // which manufactures corruption that is not in the stream:
            //
            //   recorded:  `comma\rand`      (a wrap inside an ~800-char init line at 80 columns)
            //   rendered:  `commaand`        <- a doubled letter that never existed
            //
            // Measured 2026-08-31: every apparent doubling in a reported "corrupted shell init line"
            // — `__bscc_state`, `commaand`, `PROMPT_CCOMMAND`, `;;` — was one dropped `\r`. Read
            // literally that banner says `PROMPT_COMMAND` is never set and `__bsc_state` is undefined,
            // which is a complete and plausible explanation for a bug this repo actually has. The
            // recording holds the CORRECT text 33 times over. A diagnostic that invents a credible
            // wrong cause is worse than one that says nothing, and this one is read at exactly the
            // moment nobody can check it.
            if c == '\r' {
                // `\r\n` IS AN ORDINARY LINE ENDING, not a reset of the line it terminates. Treating
                // every `\r` as a reset deletes the line that just finished — it turned
                // `Welcome\r\nError…` into `Error…` with `Welcome` silently gone, which is the same
                // class of lie as the doubling, in the other direction.
                if chars.peek() == Some(&'\n') {
                    continue; // let the `\n` be handled normally on the next turn
                }
                // A BARE `\r` returns to column 0: what follows takes this line's place.
                if let Some(nl) = out.rfind('\n') {
                    out.truncate(nl + 1);
                } else {
                    out.clear();
                }
                continue;
            }
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

/// How the session's child ACTUALLY ended, with the two outcomes kept apart.
///
/// ## `exit=1` was covering a kill, and that is why nothing could be diagnosed
///
/// `portable_pty::ExitStatus` keeps the signal in a PRIVATE field with no accessor, and its
/// `From<std::process::ExitStatus>` writes:
///
/// ```text
/// code: status.code().map(|c| c as u32).unwrap_or(1),   // ← `code()` is None when SIGNALLED
/// signal: Some(signame),
/// ```
///
/// So a child killed by SIGKILL and a child that genuinely returned 1 both answer `exit_code() == 1`,
/// and `reap` — which read `exit_code()` and nothing else — reported them identically. The shell's
/// 128+N convention (`137`) never appears on this path either, because the status here is the
/// LAUNCHER's own, straight from `waitpid`, not a shell's report of a child. `signal_from_code` was
/// therefore decoding a number that could not occur, and every session killed from outside the app
/// was filed as "the agent exited with status 1".
///
/// That is not a cosmetic error. It is the fact the whole investigation rests on: a worker dying
/// ~10 s after every launch reads as an agent that crashes on startup, when what the kernel actually
/// recorded may have been "somebody killed this". The two have nothing in common except the number.
///
/// The only public route back to the signal is `Display`, which renders `Terminated by <signame>`
/// — so that is what [`signal_name_of`] reads, and `code` is `None` for a killed child because a
/// killed child HAS no exit code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ChildEnd {
    /// The exit code, or `None` when the child was killed by a signal.
    pub code: Option<u32>,
    /// The fatal signal's name, exactly as the OS spelled it (`strsignal`), when it was killed.
    pub signal_name: Option<String>,
}

impl ChildEnd {
    /// An ordinary exit with `code` — the constructor the tests and the non-signal path use.
    pub(super) fn from_code(code: u32) -> Self {
        Self { code: Some(code), signal_name: None }
    }

    /// Read a `portable_pty` status without losing the signal. See the type docs for why the
    /// round-trip goes through `Display`.
    pub(super) fn from_status(status: &portable_pty::ExitStatus) -> Self {
        match signal_name_of(&status.to_string()) {
            Some(name) => Self { code: None, signal_name: Some(name) },
            None => Self::from_code(status.exit_code()),
        }
    }
}

/// The signal name out of `portable_pty::ExitStatus`'s `Display`, which is the only public place it
/// survives. Pure, and pinned against the real type by `the_signal_survives_portable_ptys_display`
/// — a crate bump that re-words this string must fail a test, not silently go back to reporting
/// every kill as `exit=1`.
pub(super) fn signal_name_of(rendered: &str) -> Option<String> {
    rendered.strip_prefix("Terminated by ").map(str::to_string)
}

/// The number behind a signal NAME, asked of the same `strsignal` that produced the name — so the
/// mapping cannot drift from the C library's own spelling the way a hardcoded table would. `None`
/// off Unix (there are no signals to map) and for a name nothing in 1..=64 answers to.
#[cfg(unix)]
pub(super) fn signal_number(name: &str) -> Option<u32> {
    (1..=64u32).find(|n| signal_label(*n).as_deref() == Some(name))
}

#[cfg(not(unix))]
pub(super) fn signal_number(_name: &str) -> Option<u32> {
    None
}

/// The OS's own name for signal `n` — so a decoded 128+N reads as `signal 9 (Killed)` rather than
/// leaving the reader to remember which number SIGKILL is.
#[cfg(unix)]
pub(super) fn signal_label(n: u32) -> Option<String> {
    // SAFETY: `strsignal` takes an int and returns a pointer to a static (or thread-local) string;
    // it has no memory effects of ours and we copy out before doing anything else.
    let p = unsafe { libc::strsignal(n as i32) };
    if p.is_null() {
        return None;
    }
    let s = unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().to_string();
    // glibc answers an unknown number with "Unknown signal 61" rather than NULL, and that is not a
    // name — reporting it would dress a failed lookup up as a successful one.
    if s.starts_with("Unknown signal") {
        None
    } else {
        Some(s)
    }
}

#[cfg(not(unix))]
pub(super) fn signal_label(_n: u32) -> Option<String> {
    None
}

/// Classify a finished session from the facts the emitter already holds. PURE, so every arm is
/// testable without a Tauri handle or a real child — which is what `child_outcome` never was.
///
/// `removed` means the session was gone from the registry before we looked, which only happens when
/// the app took it out: that is the answer, not a missing one.
pub(super) fn classify_end(
    pane_id: &str,
    child: Option<&ChildEnd>,
    removed: bool,
    sandbox_role: Option<&str>,
    tail: &str,
) -> SessionEnd {
    let role = sandbox_role.filter(|r| !r.is_empty()).map(str::to_string);
    let launcher = role.is_some() && LAUNCHER_MARKERS.iter().any(|m| tail.contains(m));
    let exit = child.and_then(|c| c.code);
    // The OS's own verdict outranks the shell convention, because it IS the verdict: `killed` came
    // straight from `waitpid`, where 128+N is a shell's second-hand report of one.
    let killed = child.and_then(|c| c.signal_name.clone());
    let signal = killed
        .as_deref()
        .and_then(signal_number)
        .or_else(|| exit.and_then(signal_from_code));
    let signal_name = killed.clone().or_else(|| signal.and_then(signal_label));

    let (reason, detail) = if launcher {
        (EndReason::LauncherFailed, format!(
            "The sandbox failed to start{}, so the agent never ran. This is a host problem, not a session one.",
            role.as_deref().map(|r| format!(" for this {r} session")).unwrap_or_default(),
        ))
    } else if removed {
        (EndReason::AppClosed, "Closed by the app — a kill, a project teardown, or app exit.".to_string())
    } else if let Some(name) = killed.as_deref() {
        // THE ARM THAT DID NOT EXIST. `reap` handed this case over as `exit=1`, so a session that
        // something KILLED was reported as an agent that failed — and `removed` is already false
        // here, which means the app's own kill paths (`pty_kill`, project teardown, app exit) are
        // ruled out. That last clause is the whole diagnostic value: it says look outside the app.
        //
        // AND SAY WHAT THE CGROUP SAW. "Something outside it did" was true and unfalsifiable: every
        // in-app cause was ruled out by measurement (no reaper line, no session drop, no systemd
        // scope stop, disjoint process groups from any sibling), leaving a memcg OOM as the one
        // remaining explanation — and memcg kills log to the KERNEL ring buffer, which is
        // unreadable without privileges. The session's own cgroup CAN be read, and its `oom_kill`
        // counter settles it either way, and stating the absence is as useful as confirming it.
        //
        // READ AT DEATH, NOT OFF THE SAMPLE. The first version reported the sweep's cached reading,
        // taken up to `TICK_MS` earlier, of a counter that can only increment AT the death — so it
        // could never see the event it announced as ruled out, and announced it anyway. `oom_verdict`
        // compares that sample against LIVE readings of the two things that outlive the cgroup: the
        // surviving ancestor's `memory.events` and `/proc/vmstat`.
        let cg = super::reap::oom_verdict(&super::reap::observe_oom(pane_id));
        (EndReason::Signalled, match signal {
            Some(sig) => format!(
                "Killed by signal {sig} ({name}) — the app did not close it, so something outside it did.{cg}"
            ),
            None => format!(
                "Killed by {name} — the app did not close it, so something outside it did.{cg}"
            ),
        })
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
        signal_name,
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
        // A KILLED child has no exit code, so there is no `exit=` to print — printing one is
        // exactly the fiction this replaced. It reads as a kill because it WAS a kill.
        _ => match (end.exit_code, end.signal, end.signal_name.as_deref()) {
            (None, Some(sig), Some(name)) => format!("killed by signal {sig} ({name})"),
            (None, Some(sig), None) => format!("killed by signal {sig}"),
            (None, None, Some(name)) => format!("killed by {name}"),
            (Some(code), Some(sig), _) => format!("exit={code} (killed by signal {sig})"),
            (Some(code), None, _) => format!("exit={code}"),
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
                    // The reap clock, stamped HERE because this is where the bytes already are. It
                    // also folds in the OSC-100 run/idle marker, which used to be parsed only by the
                    // frontend's TerminalView — which is exactly why the backend could not own this
                    // policy before, and why a dead webview left 17 sessions with nothing to reap them.
                    super::reap::note_output(&pane_id, &buf[..n]);
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
fn reap(app: &AppHandle, pane_id: &str) -> Option<ChildEnd> {
    let state = app.try_state::<super::PtyState>()?;
    for attempt in 0..20 {
        {
            let mut sessions = state.0.lock().unwrap_or_else(|e| e.into_inner());
            let session = sessions.get_mut(pane_id)?;
            match session.child.try_wait() {
                // NOT `exit_code()`. It answers 1 for every signalled child, which is how a kill
                // spent months being reported as "the agent exited with status 1" — see `ChildEnd`.
                Ok(Some(status)) => return Some(ChildEnd::from_status(&status)),
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
pub(super) fn cage_death_notice(end: &SessionEnd) -> Option<String> {
    // Only a caged pane has a cage to report on; everything else keeps today's silence.
    let role = end.sandbox_role.as_deref().filter(|r| !r.is_empty())?;

    // It READS the classification rather than re-deriving one. It used to take the raw exit code and
    // decode the signal a second time, which is how the pane notice and the log line could describe
    // the same death differently — and did, the moment the kill arm existed in only one of them.
    let kind = match end.reason {
        EndReason::LauncherFailed => CageDeath::Launcher,
        // A signal is a death as much as a non-zero exit is, and the arm that named it was exactly
        // the arm this notice used to be unable to reach (its input was a code that could not
        // express one).
        EndReason::Failed | EndReason::Signalled => CageDeath::Harness,
        // Nothing to say about a clean exit, a deliberate close, or an unknown status that carried
        // no launcher marker either.
        EndReason::Finished | EndReason::AppClosed | EndReason::Unknown => return None,
    };

    let status = child_status_phrase(end);

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

/// One batch of PTY output as the frontend receives it.
///
/// `upto` is the RECORDING offset this batch reaches — the number that lets a reveal tell bytes it
/// has already replayed from bytes still to arrive live, which closes the last seam in the handoff
/// (see `scrollback::Cursor`). `None` when nothing is being recorded, and for a synthetic notice that
/// is not in the recording at all, which the frontend must therefore always write.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PtyChunk {
    pub data: String,
    pub upto: Option<u64>,
}

/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee
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
                    let at = pending_at.take();
                    let guard = cursor.lock();
                    let _ = app.emit(&evt, PtyChunk { data, upto: at });
                    if let (Ok(mut c), Some(at)) = (guard, at) {
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
        let child = reap(&app, &pane_id);
        // ONE classification, three consumers (#a-stopped-session-says-why). The registry probe
        // happens here, before anything else can remove the session, so "the app closed it" is a
        // fact observed at the right moment rather than inferred later from a missing status.
        let end = classify_end(&pane_id, child.as_ref(), !session_present(&app, &pane_id), sandbox_role.as_deref(), &tail);
        // ...and say so in the pane. A refusal to cage was already legible (`NOT sandboxed: …`);
        // a cage that was built, launched and died was not.
        //
        // This stays, and is NOT what the user reads. It lives in the buffer of the thing that just
        // died: the reported worker was recreated seconds later and the notice went with the old
        // terminal. It is for whoever is looking AT the pane when it happens; the payload below is
        // for everyone else.
        if let Some(notice) = cage_death_notice(&end) {
            // `upto: None` — this text is generated HERE and is not in the recording, so a reveal can
            // never have replayed it and the frontend must always write it.
            let _ = app.emit(&evt, PtyChunk { data: notice, upto: None });
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
        let child = exit.map(ChildEnd::from_code);
        classify_end("proj:stream", child.as_ref(), removed, role, tail)
    }

    /// A child the OS KILLED — the state `reap` could not express before, and the one the reported
    /// worker was almost certainly in every time the log said `exit=1`.
    fn killed(name: &str, removed: bool, role: Option<&str>) -> SessionEnd {
        let child = ChildEnd { code: None, signal_name: Some(name.to_string()) };
        classify_end("proj:stream", Some(&child), removed, role, "")
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
    /// THE REPORTED "CORRUPTED SHELL INIT LINE", which was not corrupted at all.
    ///
    /// A carriage return returns to column 0, so what follows OVERWRITES the line. Dropping it as
    /// "just another control" concatenated the two halves and invented a doubled letter.
    #[test]
    fn a_carriage_return_resets_the_line_instead_of_doubling_a_letter() {
        // The exact shape captured from `scrollback/twitter-clone-test_api.bin`.
        assert_eq!(last_words("comma\rand").as_deref(), Some("and"));
        assert!(!last_words("comma\rand").unwrap().contains("commaand"), "the doubling is gone");

        // The everyday case this also fixes: a progress line rewritten in place reads ONCE.
        assert_eq!(last_words("50%\r100%").as_deref(), Some("100%"));

        // A `\r` only resets the CURRENT line — earlier lines survive. (The banner joins lines with
        // " / ", which is why that separator appears here rather than a newline.)
        assert_eq!(last_words("keep me\nlost\rkept").as_deref(), Some("keep me / kept"));

        // `\r\n` IS AN ORDINARY LINE ENDING. Resetting on it would delete the line that just
        // finished — the same class of lie as the doubling, in the other direction.
        assert_eq!(last_words("one\r\ntwo").as_deref(), Some("one / two"));
    }

    /// Newline and tab handling must not change — this fix is about `\r` and nothing else.
    #[test]
    fn newline_and_tab_handling_is_unchanged() {
        assert_eq!(last_words("a\tb").as_deref(), Some("a b"));
        assert_eq!(last_words("a\nb").as_deref(), Some("a / b"));
        // Other C0 controls are still dropped rather than rendered.
        assert_eq!(last_words("a\u{7}b").as_deref(), Some("ab"));
    }

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
        assert_eq!(json["signalName"], "Killed", "the name rides along so a banner need not decode 9");
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

    // ── the kill that was being reported as `exit=1` ──────────────────────────────────────────
    //
    // `portable_pty::ExitStatus::from` writes `code: status.code().…unwrap_or(1)` for a SIGNALLED
    // child and hides the signal in a private field. `reap` read `exit_code()`, so every kill came
    // back as 1 — indistinguishable from an agent that genuinely returned 1, and the shell's 128+N
    // convention never appears on this path at all (the status is the launcher's own, from
    // `waitpid`). A worker dying ~10 s after every launch therefore read as "the agent crashes on
    // startup" when the kernel may have recorded "somebody killed this".

    /// A killed child reports the KILL, and does not invent an exit code it never had.
    #[test]
    fn a_killed_child_is_reported_as_killed_not_as_exit_1() {
        let e = killed("Killed", false, Some("worker"));
        assert_eq!(e.reason, EndReason::Signalled);
        assert_eq!(e.exit_code, None, "a killed process HAS no exit code — 1 was portable_pty's filler");
        assert_eq!(e.signal, Some(9), "the name maps back through the same strsignal that produced it");
        assert_eq!(e.signal_name.as_deref(), Some("Killed"));
        assert_eq!(child_status_phrase(&e), "killed by signal 9 (Killed)");
        assert!(e.reason.is_fault());
    }

    /// SIGTERM reads differently from SIGKILL, which is the point of carrying the signal at all:
    /// a TERM is something asking politely (a systemd scope stopping), a KILL is not.
    #[test]
    fn a_terminated_child_names_its_own_signal() {
        let e = killed("Terminated", false, None);
        assert_eq!(e.signal, Some(15));
        assert_eq!(child_status_phrase(&e), "killed by signal 15 (Terminated)");
    }

    /// THE DIAGNOSTIC SENTENCE. `removed` false means the app's own kill paths — `pty_kill`, a
    /// project teardown, app exit — are already ruled out at this point, so the detail may say so.
    /// Without it a reader has to re-derive that exclusion by hand every time.
    #[test]
    fn a_kill_the_app_did_not_order_says_to_look_outside_the_app() {
        let e = killed("Killed", false, Some("worker"));
        assert!(e.detail.contains("the app did not close it"), "{}", e.detail);
        // ...and when the app DID close it, that is the answer instead — no outside-the-app claim.
        let a = killed("Killed", true, Some("worker"));
        assert_eq!(a.reason, EndReason::AppClosed);
        assert!(!a.detail.contains("outside"), "{}", a.detail);
    }

    /// A name nothing maps to still beats `exit=1`: the kill is reported, unnumbered.
    #[test]
    fn an_unmappable_signal_name_still_reports_the_kill() {
        let e = killed("Signal 999", false, None);
        assert_eq!(e.reason, EndReason::Signalled);
        assert_eq!(e.signal, None);
        assert_eq!(child_status_phrase(&e), "killed by Signal 999");
    }

    /// THE CRATE CONTRACT. The signal survives only in `Display`, so a `portable-pty` bump that
    /// re-words that string must fail HERE — not silently put every kill back to `exit=1`.
    #[test]
    fn the_signal_survives_portable_ptys_display() {
        let sig = portable_pty::ExitStatus::with_signal("Killed");
        assert_eq!(sig.exit_code(), 1, "the collapse this whole type exists to undo");
        assert_eq!(ChildEnd::from_status(&sig),
                   ChildEnd { code: None, signal_name: Some("Killed".into()) });
        // ...and an ordinary exit is NOT read as a signal.
        let ok = portable_pty::ExitStatus::with_exit_code(1);
        assert_eq!(ChildEnd::from_status(&ok), ChildEnd::from_code(1));
    }

    /// The number↔name round-trip goes through the C library both ways, so it cannot drift from a
    /// hardcoded table that was right when it was written.
    #[cfg(unix)]
    #[test]
    fn a_signal_name_and_its_number_agree_with_the_os() {
        assert_eq!(signal_number("Killed"), Some(9));
        assert_eq!(signal_number("Terminated"), Some(15));
        assert_eq!(signal_label(9).as_deref(), Some("Killed"));
        assert_eq!(signal_number("not a signal at all"), None);
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
    ///
    /// "The shipped source" is RESOLVED by [`crate::testutil::module_source`] rather than
    /// `include_str!`'d: the file this module lives in is the one `bsc graph migrate-crate src-tauri`
    /// deletes. Post-migration the resolver returns this module's section of the materialized
    /// `$OUT_DIR/crate.rs`, which is a stronger reading of "shipped" than a file ever was.
    ///
    /// # It searches the SHIPPED half only, and that is a fix, not a detail
    ///
    /// This used to `contains` over the whole module. MEASURED while repointing it: with the shipped
    /// `signal_from_code` deliberately changed to `(1..=63)`, this test **passed** — because `describe`
    /// directly above is the very second copy it exists to police, and its unchanged text satisfied the
    /// search. A guard that its own subject can satisfy is not evidence about the subject. Cutting at
    /// the first `#[cfg(test)]` is the same trim
    /// `no_raw_escape_byte_survives_in_a_line_typed_into_a_shell` already uses next door, and it makes
    /// the assertion mean what the sentence above always claimed.
    #[test]
    fn the_shipped_decode_is_the_one_under_test() {
        let src = crate::testutil::module_source("console/pty/pump.rs");
        let shipped = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        assert!(
            shipped.contains("code.checked_sub(128).filter(|n| (1..=64).contains(n))"),
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
    use super::{cage_death_notice, classify_end, ChildEnd, PtyChunk, LAUNCHER_MARKERS};

    /// The notice now reads a CLASSIFICATION rather than a raw exit code, so the tests build one —
    /// which is also what stopped the pane notice and the log line from decoding a death twice.
    fn notice(role: Option<&str>, exit: Option<u32>, tail: &str) -> Option<String> {
        let child = exit.map(ChildEnd::from_code);
        cage_death_notice(&classify_end("proj:stream", child.as_ref(), false, role, tail))
    }

    /// The launcher failing is DEFINITE, so the notice may say so outright.
    #[test]
    fn a_bwrap_failure_names_the_cage_not_the_agent() {
        let tail = "bwrap: Can't mkdir /coord/out: Read-only file system\n";
        let n = notice(Some("worker"), Some(1), tail).expect("a notice");
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
            let n = notice(Some("director"), Some(1), &format!("...\n{m} something\n"))
                .expect("a notice");
            assert!(n.contains("SANDBOX failed to start"), "{m} must read as a launcher failure: {n}");
        }
    }

    /// The cage came up and the thing inside it exited. Different fault, different fix — and the
    /// notice must not claim the sandbox broke.
    #[test]
    fn a_harness_failure_says_the_cage_started() {
        let n = notice(Some("director"), Some(1), "Auto-update failed\n").expect("a notice");
        assert!(n.contains("ended inside its sandbox"), "{n}");
        assert!(n.contains("cage started"), "{n}");
        assert!(!n.contains("SANDBOX failed to start"), "must not blame the cage: {n}");
    }

    /// THE constraint that shapes the whole thing: a session that legitimately finishes fast looks
    /// exactly like one that died, and the app cannot read intent from a duration. So a clean exit
    /// gets nothing at all, however quick it was.
    #[test]
    fn a_clean_exit_says_nothing_however_fast_it_was() {
        assert_eq!(notice(Some("worker"), Some(0), "done\n"), None);
        // ...and neither does an unknown status with no launcher marker: there is nothing honest
        // to report, and a notice on every ambiguous exit is how a warning becomes noise.
        assert_eq!(notice(Some("worker"), None, "some output\n"), None);
    }

    /// An UNCAGED pane keeps today's silence — this notice is about a cage, and a pane without one
    /// has nothing for it to say.
    #[test]
    fn an_uncaged_pane_is_untouched() {
        assert_eq!(notice(None, Some(1), "bwrap: boom"), None);
        assert_eq!(notice(Some(""), Some(1), "bwrap: boom"), None);
    }

    /// A fatal signal is named, not left as a number — 137 is the cage's own OOM kill, which is
    /// exactly the case a reader must not have to decode by hand.
    #[test]
    fn a_fatal_signal_is_named() {
        let n = notice(Some("worker"), Some(137), "").expect("a notice");
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
        // RESOLVED, not `include_str!`'d — this module's file is one `bsc graph migrate-crate
        // src-tauri` deletes, and the resolver falls through to the materialized `$OUT_DIR/crate.rs`
        // section once it does. The bounded slices below are unchanged and still stop well short of
        // this test module, so the guard cannot match its own string literals either way.
        let src = crate::testutil::module_source("console/pty/pump.rs");
        const DECODE: &str = "checked_sub(128).filter(|n| (1..=64).contains(n))";
        let body_of = |f: &str| {
            let at = src.find(f).unwrap_or_else(|| panic!("{f} is here"));
            let rest = &src[at..];
            &rest[..rest.len().min(1_500)]
        };

        assert!(body_of("fn signal_from_code").contains(DECODE), "the one definition lives here");
        assert!(
            // By NAME, not `name(` — `classify_end` passes it as a function value
            // (`and_then(signal_from_code)`), which is a call site just as much as a paren is.
            body_of("fn classify_end").contains("signal_from_code"),
            "classify_end must CALL the shared decode, not carry its own",
        );
        for f in ["fn classify_end", "fn cage_death_notice"] {
            assert!(
                !body_of(f).contains(DECODE),
                "{f} re-implements the decode instead of calling it",
            );
        }
        // ...and the notice does not decode AT ALL any more. It takes the `SessionEnd` that
        // `classify_end` produced and reads its verdict, which is the stronger version of the same
        // guarantee: there is one classification, not two that are merely asked to agree. The
        // difference stopped being theoretical when the KILL arm existed — `cage_death_notice`'s
        // old input was an exit code, which cannot express a signal at all, so a killed cage was
        // silent in the pane while the log called it `exit=1`.
        assert!(
            !body_of("fn cage_death_notice").contains("signal_from_code"),
            "cage_death_notice must read the classification, not re-derive one",
        );
    }

    /// A cage whose session was KILLED gets a notice too. It could not before: the input was an
    /// exit code, and a kill has none — so the one death most worth reporting in the pane was the
    /// one death the pane stayed silent about.
    #[test]
    fn a_killed_cage_is_reported_and_names_the_signal() {
        let child = ChildEnd { code: None, signal_name: Some("Killed".into()) };
        let n = cage_death_notice(&classify_end("proj:stream", Some(&child), false, Some("worker"), ""))
            .expect("a killed cage must not be silent");
        assert!(n.contains("killed by signal 9 (Killed)"), "{n}");
        assert!(n.contains("ended inside its sandbox"), "the cage started; what ran in it was killed: {n}");
    }

    /// The notice ends the line it lands on and terminates its own, so it cannot be swallowed by a
    /// half-written line the dying session left behind.
    #[test]
    fn the_notice_stands_on_its_own_line() {
        let n = notice(Some("worker"), Some(1), "half a line").expect("a notice");
        assert!(n.starts_with("\r\n"), "{n:?}");
        assert!(n.ends_with("\r\n"), "{n:?}");
    }

    /// The WIRE SHAPE of a batch, pinned by name.
    ///
    /// This is a cross-language contract with a listener that is a graph RECORD, and the field names
    /// are the whole of it: the frontend reads `chunk.data`, so renaming this field writes `undefined`
    /// into a terminal rather than failing anywhere a compiler can see it. (`rename_all` is inert for
    /// these two names and is carried for the next field that is not one word — which is exactly when
    /// a silent rename would be easiest to miss.)
    ///
    /// IT ALREADY COST A REVERT, and not even for a real mismatch. `2332ce6d` introduced this struct,
    /// the running app began reporting `NaNKB`, and the payload was reverted at `b7e785ad` — while the
    /// actual cause was a dev server serving a STALE COPY of the listener, so the payload-tolerant
    /// version written 90 seconds earlier was never the code that ran. A test that states the shape is
    /// what lets the next such question be answered here instead of by inference from a symptom.
    #[test]
    fn a_batch_serializes_as_data_and_upto() {
        let tagged = serde_json::to_value(PtyChunk { data: "hi".into(), upto: Some(42) }).unwrap();
        assert_eq!(tagged, serde_json::json!({ "data": "hi", "upto": 42 }));

        // `None` must reach the frontend as an explicit null, not as a MISSING key: the listener
        // distinguishes "not in the recording, always write it" from "recorded up to here", and a
        // key that vanished would be indistinguishable from a field the frontend forgot to read.
        let untagged = serde_json::to_value(PtyChunk { data: "notice".into(), upto: None }).unwrap();
        assert_eq!(untagged, serde_json::json!({ "data": "notice", "upto": null }));
    }
}
