//! Best-effort PTY-tap runtime-fault fallback (#2264, part of the runtime-fault epic #2258).
//!
//! For an app bsc **didn't** generate (a brought-in repo, the migration case) there is no injected
//! shim POSTing structured faults to the localhost collector (#2261). This module gives such an app
//! best-effort coverage by tapping the dev-server output the console already streams: it scans the
//! text for stack traces / panics / uncaught rejections / `ERROR`/`FATAL` lines, fingerprints them
//! (best-effort, stage `runtime`), and records them in the pane's project `error.db` via the shared
//! [`errordb::Store`], tagged `source_hint = "pty-tap"` so a reader can tell these lower-confidence
//! text-scraped faults apart from a shim/OTLP fault.
//!
//! ## The side-tap is additive and gated
//! [`observe`] is called from the PTY emitter's single output chokepoint (`console/pty/pump.rs`)
//! **after** the WebView emit + mobile-tunnel tee already borrowed the same bytes — it never mutates
//! or consumes them, so the rendered/tunneled stream is byte-for-byte unchanged. It is **off by
//! default per pane**: a pane must be explicitly marked an app-runner ([`mark_app_runner`], driven by
//! the `pty_set_app_runner` command) before the tap does anything. When no pane is enabled, `observe`
//! is a single relaxed atomic load and returns — so the common case (every ordinary terminal) pays
//! effectively nothing on the hot path. Recording is rate-limited per pane.
//!
//! ## Attribution
//! An enabled pane carries the sanitized project key it belongs to (from the pane→project binding the
//! store already owns — `fleetPaneStreams` / the pane's project key). The key resolves the project's
//! `error.db` via [`crate::error_db_path`], exactly the store the whole fleet + `bsc errors` share.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The registry of enabled app-runner taps (pane_id → live tap state). Empty until a pane is marked.
fn taps() -> &'static Mutex<HashMap<String, PtyFaultTap>> {
    static TAPS: OnceLock<Mutex<HashMap<String, PtyFaultTap>>> = OnceLock::new();
    TAPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Number of currently-enabled taps — the hot-path fast exit. `observe` reads this (a relaxed atomic)
/// on every flush for every pane; only when it is non-zero does it take the registry lock. So a
/// desktop with the feature unused (the default) never locks on the streaming path.
static ENABLED: AtomicUsize = AtomicUsize::new(0);

/// At most this many faults are recorded per pane per [`RATE_WINDOW`] — a guard against a runaway
/// distinct-error flood (identical faults already collapse to one row by fingerprint, so this only
/// bounds a pathological stream of *distinct* signatures).
const RATE_MAX: u32 = 30;
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// Cap a recorded title's length so a monster single-line log entry can't bloat a DB row.
const TITLE_CAP: usize = 500;
/// Cap how many frame lines a single stack collects, so a huge backtrace stays bounded.
const MAX_STACK_LINES: usize = 40;

/// Mark a pane as "running the app" so [`observe`] scans its output for runtime faults, attributing
/// them to `project_key`'s `error.db`. Idempotent: re-marking the same pane refreshes its key and
/// resets its line buffer without double-counting the enabled tally. Called by `pty_set_app_runner`.
pub fn mark_app_runner(pane_id: &str, project_key: &str) {
    let mut map = taps().lock().unwrap_or_else(|e| e.into_inner());
    let fresh = !map.contains_key(pane_id);
    map.insert(pane_id.to_string(), PtyFaultTap::new(project_key));
    if fresh {
        ENABLED.fetch_add(1, Ordering::Relaxed);
    }
    log::info!("pty-tap: pane[{pane_id}] marked app-runner for project {project_key:?}");
}

/// Stop tapping a pane (the user un-marked it, or the pane was killed). A no-op for an unmarked pane.
pub fn clear_app_runner(pane_id: &str) {
    let mut map = taps().lock().unwrap_or_else(|e| e.into_inner());
    if map.remove(pane_id).is_some() {
        ENABLED.fetch_sub(1, Ordering::Relaxed);
        log::info!("pty-tap: pane[{pane_id}] app-runner cleared");
    }
}

/// Whether a pane is currently tapped (test-only introspection helper).
#[cfg(test)]
fn is_app_runner(pane_id: &str) -> bool {
    taps().lock().unwrap_or_else(|e| e.into_inner()).contains_key(pane_id)
}

/// Feed one flushed PTY output batch through the side-tap. Called from `spawn_emitter` right after the
/// WebView/mobile-tunnel emit has borrowed `text`; it only reads the bytes. Returns immediately (one
/// relaxed atomic load) when no pane is enabled, so the streaming hot path is untouched by default.
pub fn observe(pane_id: &str, text: &str) {
    if ENABLED.load(Ordering::Relaxed) == 0 {
        return;
    }
    let mut map = taps().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(tap) = map.get_mut(pane_id) {
        tap.feed(text);
    }
}

/// The session ended — drop the pane's tap (and decrement the enabled tally) if it had one. Cheap
/// no-op for the overwhelming majority of panes (never marked). Called at the end of `spawn_emitter`.
pub fn on_pane_exit(pane_id: &str) {
    if ENABLED.load(Ordering::Relaxed) == 0 {
        return;
    }
    clear_app_runner(pane_id);
}

/// Live per-pane tap state: the owning project key, an incomplete-trailing-line carry buffer (so a
/// fault split across a PTY read boundary isn't missed), and the rate-limit window.
struct PtyFaultTap {
    project_key: String,
    /// Bytes after the last newline of the previous batch — completed by the next batch's head.
    carry: String,
    window_start: Instant,
    window_count: u32,
}

impl PtyFaultTap {
    fn new(project_key: &str) -> Self {
        PtyFaultTap {
            project_key: project_key.to_string(),
            carry: String::new(),
            window_start: Instant::now(),
            window_count: 0,
        }
    }

    /// Accumulate `text`, extract faults from the newly-completed lines, and record each (rate-limited).
    /// Only whole lines (up to the last `\n`) are scanned; the remainder is carried for the next batch.
    fn feed(&mut self, text: &str) {
        self.carry.push_str(text);
        let Some(cut) = self.carry.rfind('\n') else {
            // No complete line yet — keep buffering, but don't let a pathological no-newline stream
            // grow the carry without bound.
            if self.carry.len() > 64 * 1024 {
                self.carry.clear();
            }
            return;
        };
        let complete: String = self.carry.drain(..=cut).collect();
        for fault in extract_faults(&complete) {
            if !self.allow() {
                break;
            }
            record_fault(&self.project_key, &fault);
        }
    }

    /// One rate-limit token: at most [`RATE_MAX`] recordings per [`RATE_WINDOW`], per pane.
    fn allow(&mut self) -> bool {
        if self.window_start.elapsed() >= RATE_WINDOW {
            self.window_start = Instant::now();
            self.window_count = 0;
        }
        if self.window_count >= RATE_MAX {
            return false;
        }
        self.window_count += 1;
        true
    }
}

/// A fault signature extracted from the text stream (before it becomes an [`errordb::FaultInput`]).
#[derive(Debug, Clone, PartialEq)]
pub struct DetectedFault {
    /// The head line — the error class + message, or the panic/ERROR line.
    pub title: String,
    /// The associated frames (if any), joined by newlines — feeds the fingerprint's first frame.
    pub stack: Option<String>,
    /// Best-effort severity: `fatal` (panic/uncaught), `error` (JS error / `ERROR`), or `warn`.
    pub level: String,
}

/// Scan a block of terminal text for runtime-fault signatures. **Pure** (no I/O) and the tested core:
/// it strips ANSI escapes, splits into lines, and groups each recognizable head line with any stack
/// frames that follow it. Deliberately best-effort — a good-enough grouping over mainstream output
/// shapes (Rust/Go panics, JS/Node stacks, uncaught rejections, `ERROR`/`FATAL` log lines), NOT a
/// semantic parse. A benign line (a request log, a "compiled successfully") matches nothing.
pub fn extract_faults(block: &str) -> Vec<DetectedFault> {
    let cleaned = strip_ansi(block);
    let lines: Vec<&str> = cleaned.lines().collect();
    let mut faults = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let Some((title, level, wants_stack)) = classify_head(lines[i]) else {
            i += 1;
            continue;
        };
        let mut stack_lines: Vec<&str> = Vec::new();
        if wants_stack {
            let mut j = i + 1;
            // A Rust panic head ends with ':' and carries its MESSAGE on the next line (the 1.65+
            // two-line format) — absorb it, since it isn't a frame shape and the walk below would
            // stop on it and drop the note/backtrace that follows. Never absorb another fault head.
            if title.contains("panicked at") && title.trim_end().ends_with(':') {
                if let Some(msg) = lines.get(j).copied() {
                    if !msg.trim().is_empty() && classify_head(msg).is_none() {
                        stack_lines.push(msg.trim_end());
                        j += 1;
                    }
                }
            }
            while j < lines.len() && stack_lines.len() < MAX_STACK_LINES {
                let lj = lines[j];
                if lj.trim().is_empty() || !is_frame_line(lj) {
                    break;
                }
                stack_lines.push(lj.trim_end());
                j += 1;
            }
            i = j;
        } else {
            i += 1;
        }
        let stack = (!stack_lines.is_empty()).then(|| stack_lines.join("\n"));
        faults.push(DetectedFault { title: cap_title(&title), stack, level: level.to_string() });
    }
    faults
}

/// Classify a candidate head line → `(title, level, wants_stack)`, or None if it's not a fault head.
/// Order matters: the specific, high-confidence shapes (panic / uncaught / typed error) are checked
/// before the generic uppercase `ERROR`/`FATAL` catch-all so a typed error keeps its `error` level +
/// stack rather than being swallowed by the log-line rule.
fn classify_head(line: &str) -> Option<(String, &'static str, bool)> {
    let t = line.trim();
    if t.is_empty() {
        return None;
    }
    // Rust panic (`thread 'main' panicked at src/x.rs:1:1:`), and Go/generic `panic:`.
    if t.contains("panicked at") || t.starts_with("panic:") {
        return Some((t.to_string(), "fatal", true));
    }
    // Node uncaught exception / unhandled promise rejection.
    if contains_any(t, &["uncaughtException", "UnhandledPromiseRejection", "unhandledRejection", "Uncaught ", "Unhandled Rejection"]) {
        return Some((t.to_string(), "fatal", true));
    }
    // A typed JS/TS error/exception head: `TypeError: x is undefined`, `Error: boom`.
    if is_typed_error_head(t) {
        return Some((t.to_string(), "error", true));
    }
    // Generic uppercase log level — lowest confidence, no stack (it's a single log line).
    if has_word(t, "FATAL") {
        return Some((t.to_string(), "fatal", false));
    }
    if has_word(t, "ERROR") {
        return Some((t.to_string(), "error", false));
    }
    None
}

/// A `Something(Error|Exception): message` head — a single leading identifier ending in `Error`/
/// `Exception` before the first colon. Matches the typed-error line Node/V8, Python, and the JVM
/// print; rejects `note:`, `at x: y`, `GET /a: 200` (the pre-colon token has whitespace) and plain
/// lowercase words.
fn is_typed_error_head(t: &str) -> bool {
    let Some((head, _)) = t.split_once(':') else {
        return false;
    };
    let head = head.trim();
    if head.is_empty() || head.contains(char::is_whitespace) {
        return false;
    }
    let starts_upper = head.chars().next().is_some_and(|c| c.is_ascii_uppercase());
    starts_upper && (head.ends_with("Error") || head.ends_with("Exception"))
}

/// Whether a line looks like a stack frame / trailing note that belongs to the head above it.
fn is_frame_line(l: &str) -> bool {
    let t = l.trim_start();
    if t.is_empty() {
        return false;
    }
    t.starts_with("at ")            // JS/Node/JVM: "at foo (app.js:1:1)"
        || t.starts_with("note:")   // Rust: "note: run with RUST_BACKTRACE=1 ..."
        || t.starts_with("stack backtrace")
        || t.starts_with("goroutine ") // Go
        || t.contains(".go:")
        || t.contains(".rs:")
        || t.contains(".js:")
        || t.contains(".ts:")
        || t.contains(".py:")
        || is_numbered_frame(t)     // Rust backtrace "  12: core::..." / Python "File ..., line N"
}

/// A leading `<digits>:` frame (a Rust backtrace numbered frame), tolerating leading whitespace.
fn is_numbered_frame(t: &str) -> bool {
    let mut chars = t.chars();
    let mut saw_digit = false;
    for c in chars.by_ref() {
        if c.is_ascii_digit() {
            saw_digit = true;
        } else {
            return saw_digit && c == ':';
        }
    }
    false
}

fn contains_any(t: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| t.contains(n))
}

/// Whether `word` appears as a whole alphanumeric token in `t` (so `ERROR` matches `[x] ERROR: y` and
/// `level=ERROR` but not `errors` or the lowercase `error`).
fn has_word(t: &str, word: &str) -> bool {
    t.split(|c: char| !c.is_ascii_alphanumeric()).any(|tok| tok == word)
}

fn cap_title(t: &str) -> String {
    if t.len() <= TITLE_CAP {
        t.to_string()
    } else {
        // Cap on a char boundary at or below the byte cap.
        let mut end = TITLE_CAP;
        while end > 0 && !t.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &t[..end])
    }
}

/// Strip ANSI/VT escape sequences (CSI `\x1b[…`, OSC `\x1b]…` up to BEL/ST, and a lone two-char
/// escape) plus carriage returns, so pattern matching sees the plain text a human reads — dev servers
/// colorize their output, and a raw `\x1b[31m` would defeat a naive `starts_with`.
fn strip_ansi(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            0x1b => {
                if i + 1 >= bytes.len() {
                    break;
                }
                match bytes[i + 1] {
                    b'[' => {
                        // CSI: params/intermediates until a final byte in 0x40..=0x7E.
                        i += 2;
                        while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                            i += 1;
                        }
                        i += 1; // consume the final byte
                    }
                    b']' => {
                        // OSC: until BEL (0x07) or ST (ESC \).
                        i += 2;
                        while i < bytes.len() && bytes[i] != 0x07 {
                            if bytes[i] == 0x1b && i + 1 < bytes.len() && bytes[i + 1] == b'\\' {
                                i += 1;
                                break;
                            }
                            i += 1;
                        }
                        i += 1; // consume the terminator
                    }
                    _ => i += 2, // a lone two-char escape (e.g. ESC c)
                }
            }
            b'\r' => i += 1, // drop carriage returns (\r\n → \n, progress-bar redraws collapse)
            b => {
                out.push(b as char);
                // A non-ASCII byte pushed as `char` would mangle UTF-8; fall back to slicing the
                // original char when we're inside a multibyte sequence.
                if b >= 0x80 {
                    out.pop();
                    // Copy the whole char from the source string at this byte offset.
                    if let Some(ch) = s[i..].chars().next() {
                        out.push(ch);
                        i += ch.len_utf8();
                        continue;
                    }
                }
                i += 1;
            }
        }
    }
    out
}

/// Record one detected fault in the project's `error.db` — best-effort: any failure logs and is
/// dropped (this is a fallback signal, never allowed to disturb the session). Tagged
/// `source_hint = "pty-tap"` and stamped stage `runtime`.
fn record_fault(project_key: &str, fault: &DetectedFault) {
    let path = crate::error_db_path(project_key);
    let store = match errordb::Store::open(&path) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("pty-tap: open error.db {} failed: {e}", path.display());
            return;
        }
    };
    let input = errordb::FaultInput {
        stage: errordb::DEFAULT_STAGE.to_string(),
        level: fault.level.clone(),
        title: fault.title.clone(),
        stack: fault.stack.clone(),
        source_hint: Some("pty-tap".to_string()),
        release: None,
        context: None,
        ts: now_ms(),
    };
    if let Err(e) = store.record(&input) {
        log::warn!("pty-tap[{project_key}]: record failed: {e}");
    }
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_rust_panic_with_its_note() {
        let out = "\
Compiling app v0.1.0
thread 'main' panicked at src/main.rs:42:9:
called `Option::unwrap()` on a `None` value
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace
Listening on 127.0.0.1:3000
";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 1, "one fault from the panic");
        assert!(faults[0].title.contains("panicked at"), "title is the panic head");
        assert_eq!(faults[0].level, "fatal");
        assert!(
            faults[0].stack.as_deref().unwrap().contains("note:"),
            "the note line is collected as the frame"
        );
    }

    #[test]
    fn extracts_a_js_stack_trace() {
        let out = "\
TypeError: Cannot read properties of undefined (reading 'id')
    at getUser (/app/src/user.js:12:20)
    at handler (/app/src/routes.js:8:5)
    at Layer.handle (/app/node_modules/express/lib/router/layer.js:95:5)
";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 1);
        assert!(faults[0].title.starts_with("TypeError:"));
        assert_eq!(faults[0].level, "error");
        let stack = faults[0].stack.as_deref().unwrap();
        assert!(stack.contains("at getUser"), "frames collected");
        assert_eq!(stack.lines().count(), 3, "all three at-frames");
    }

    #[test]
    fn extracts_an_uncaught_exception_as_fatal() {
        let out = "uncaughtException: Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap.afterConnect (node:net:1494:16)\n";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].level, "fatal");
        assert!(faults[0].stack.is_some(), "the following at-frame is captured");
    }

    #[test]
    fn extracts_a_plain_error_log_line_without_a_stack() {
        let out = "[2024-01-01T00:00:00Z] ERROR failed to bind to port 3000\n";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].level, "error");
        assert!(faults[0].stack.is_none(), "a bare log line has no stack");
        assert!(faults[0].title.contains("failed to bind"));
    }

    #[test]
    fn a_fatal_log_line_is_fatal() {
        let faults = extract_faults("myapp FATAL out of memory\n");
        assert_eq!(faults.len(), 1);
        assert_eq!(faults[0].level, "fatal");
    }

    #[test]
    fn benign_lines_never_match() {
        // A request log, a success line, a lowercase "errors" count, and a plain info line: none of
        // these is a fault — the extractor must stay quiet on ordinary dev-server chatter.
        let out = "\
  ready - started server on 0.0.0.0:3000, url: http://localhost:3000
GET /api/users 200 12ms
webpack compiled successfully with 0 errors
info: watching for file changes
✓ built in 1.2s
";
        assert!(extract_faults(out).is_empty(), "no benign line is a fault: {:?}", extract_faults(out));
    }

    #[test]
    fn strips_ansi_before_matching() {
        // A colorized panic line (red SGR + reset) must still be recognized.
        let out = "\x1b[31mthread 'main' panicked at src/x.rs:1:1:\x1b[0m\nboom\n";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 1, "ANSI-wrapped panic recognized");
        assert!(!faults[0].title.contains('\x1b'), "escape codes stripped from the title");
    }

    #[test]
    fn typed_error_head_is_specific() {
        assert!(is_typed_error_head("TypeError: x is undefined"));
        assert!(is_typed_error_head("Error: boom"));
        assert!(is_typed_error_head("SomeException: nope"));
        // Not typed-error heads:
        assert!(!is_typed_error_head("note: run with RUST_BACKTRACE=1"));
        assert!(!is_typed_error_head("at foo: bar"), "pre-colon token has whitespace");
        assert!(!is_typed_error_head("GET /api: 200"));
        assert!(!is_typed_error_head("warning: deprecated"));
    }

    #[test]
    fn has_word_is_boundary_aware() {
        assert!(has_word("[x] ERROR: y", "ERROR"));
        assert!(has_word("level=ERROR", "ERROR"));
        assert!(!has_word("0 errors found", "ERROR"), "lowercase / substring never matches");
        assert!(!has_word("MIRRORED", "ERROR"), "substring never matches");
    }

    #[test]
    fn multiple_distinct_faults_in_one_block() {
        let out = "\
TypeError: a\n    at f (x.js:1:1)\nGET /health 200\npanic: runtime error: index out of range\n";
        let faults = extract_faults(out);
        assert_eq!(faults.len(), 2, "the typed error and the go panic, not the request log");
        assert_eq!(faults[0].level, "error");
        assert_eq!(faults[1].level, "fatal");
    }

    #[test]
    fn tap_registry_gates_observe_and_tracks_enabled_count() {
        // Use a unique pane id so the test is independent of any other (the registry is process-global).
        let pane = format!("test-pane-{}", std::process::id());
        assert!(!is_app_runner(&pane));
        mark_app_runner(&pane, "test-project-key");
        assert!(is_app_runner(&pane));
        // Re-marking the same pane doesn't double-count (clearing once fully disables it).
        mark_app_runner(&pane, "test-project-key");
        clear_app_runner(&pane);
        assert!(!is_app_runner(&pane), "cleared after a single clear despite re-marking");
        // observe on an unmarked pane is a silent no-op.
        observe(&pane, "thread 'main' panicked at x.rs:1:1:\n");
        assert!(!is_app_runner(&pane));
    }

    #[test]
    fn feed_carries_an_incomplete_trailing_line_across_batches() {
        // A fault head split across two PTY reads is still assembled: the head arrives without its
        // newline in batch 1, completed by batch 2. We assert the carry mechanics via extract on the
        // reassembled text (feed's DB write is exercised end-to-end elsewhere).
        let mut tap = PtyFaultTap::new("k");
        tap.feed("TypeError: bo");
        assert!(!tap.carry.is_empty(), "an incomplete line is carried, not scanned");
        // The second batch completes the line + a newline; after feed the carry is drained past it.
        tap.feed("om: bad\n");
        assert!(tap.carry.is_empty(), "the completed line was consumed");
    }

    #[test]
    fn rate_limit_caps_recordings_per_window() {
        let mut tap = PtyFaultTap::new("k");
        let mut allowed = 0;
        for _ in 0..(RATE_MAX + 10) {
            if tap.allow() {
                allowed += 1;
            }
        }
        assert_eq!(allowed, RATE_MAX, "no more than RATE_MAX tokens per window");
    }
}
