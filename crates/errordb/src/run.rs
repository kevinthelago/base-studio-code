//! `bsc errors run` — run a command, pass it through untouched, and file a fault if it fails.
//!
//! The producer the stage taxonomy never had. A build or a launch that fails leaves its evidence in
//! whichever shell happened to run it, and when that shell is gone so is the failure; this makes the
//! same failure a fingerprinted row that outlives the terminal, that an external session can read
//! without the app running, and that Glance already knows how to render (#4008 proved the whole
//! downstream: one `record` call turns a project node amber, with the title as its reason and the count
//! as its badge).
//!
//! ## It is a tee, never a gate
//!
//! Three properties, none of them optional:
//!
//! 1. **The child's exit code is propagated exactly.** Not "1 on failure" — cargo exits 101, a signal
//!    exits 130, and a caller chaining on `&&` must see what it would have seen unwrapped. That is why
//!    this exits the process itself rather than returning an `Err` the CLI frame would flatten to 1.
//! 2. **The output still streams, live.** Both pipes are forwarded as they arrive, not replayed at the
//!    end: a five-minute cargo build that prints nothing until it fails is indistinguishable from a
//!    hang, and nobody would keep the wrapper.
//! 3. **Recording is fail-open, always.** No store, an unopenable db, a write error — none of them may
//!    change the exit code, the output, or the timing. `record_supply_fault` states this rule for the
//!    same store and is the precedent being copied.
//!
//! ## The cost, stated rather than hidden
//!
//! Forwarding means the child's stdout/stderr are PIPES, so a tool that colorizes only for a terminal
//! will stop (`CARGO_TERM_COLOR=always` re-enables it), and a tool that wants a TTY for interactive
//! keys will not get one. That is why this belongs on batch commands — a build, a typecheck, a launch —
//! and not on an interactive dev server. stdin is left INHERITED, so a child that prompts still can.

use crate::detect;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};

/// Windows' `STATUS_CONTROL_C_EXIT` (0xC000013A) as `ExitStatus::code` reports it — the raw `u32`
/// reinterpreted as `i32`, which is what it becomes on the way through. Written as the cast rather
/// than the decimal so it is recognizable as the documented NTSTATUS and not a magic number.
const WINDOWS_CTRL_C: i32 = 0xC000013A_u32 as i32;

/// Exit codes that mean INTERRUPTED rather than failed, on the platforms that report it as a code.
/// 130 = 128+SIGINT and 143 = 128+SIGTERM, which is how a shell relays a signal it caught for you.
const INTERRUPT_CODES: [i32; 3] = [130, 143, WINDOWS_CTRL_C];

/// What a finished run amounts to — everything the caller needs to decide, with no I/O left in it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    /// The child's exit code, or `None` if it was killed by a signal without one.
    pub code: Option<i32>,
    /// Killed by a signal, or exited with a code that means the same thing.
    pub interrupted: bool,
}

impl Outcome {
    /// Did this run FAIL, in the sense that is worth recording?
    ///
    /// An interrupt is not a failure. `vite` under a dev server exits 130 on Ctrl-C, and a wrapper that
    /// filed a fault every time a developer stopped their dev server would train everyone to ignore the
    /// store — which is the only way this feature actually dies.
    pub fn is_fault(&self) -> bool {
        !self.interrupted && self.code != Some(0)
    }
    /// Did it SUCCEED, in the sense that clears what this source recorded before?
    ///
    /// Deliberately not `!is_fault()`: an interrupted run proves nothing either way, so it must not
    /// clear a real fault recorded by the last real run.
    pub fn is_clean(&self) -> bool {
        self.code == Some(0)
    }
    /// The code to exit this process with. A signal death has no code of its own; 130 is the
    /// conventional stand-in and is what a shell would have reported.
    pub fn exit_code(&self) -> i32 {
        self.code.unwrap_or(130)
    }
}

/// Classify a finished child. Split out from the spawn so the signal rule is testable without one.
fn classify(status: &std::process::ExitStatus) -> Outcome {
    #[cfg(unix)]
    let signalled = {
        use std::os::unix::process::ExitStatusExt;
        status.signal().is_some()
    };
    #[cfg(not(unix))]
    let signalled = false;

    let code = status.code();
    let interrupted = signalled || code.is_some_and(|c| INTERRUPT_CODES.contains(&c));
    Outcome { code, interrupted }
}

/// Spawn `cmd`, forwarding both streams live while accumulating them, and return the outcome plus the
/// combined output.
///
/// The two streams are merged into ONE buffer in arrival order, which is what the extractor wants: a
/// cargo diagnostic is on stderr while a bundler's is on stdout, and a producer that captured only one
/// would silently see nothing for half the tools it wraps.
fn spawn_and_tee(cmd: &[String]) -> Result<(Outcome, String), String> {
    let (prog, rest) = cmd.split_first().ok_or("run: no command given")?;
    let mut child = Command::new(prog)
        .args(rest)
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("run: cannot start `{prog}`: {e}"))?;

    let buf = Arc::new(Mutex::new(String::new()));
    let out = child.stdout.take().map(|s| pump(s, buf.clone(), false));
    let err = child.stderr.take().map(|s| pump(s, buf.clone(), true));

    let status = child.wait().map_err(|e| format!("run: waiting for `{prog}`: {e}"))?;
    // Join AFTER the wait: the pumps end when their pipes close, and joining first would deadlock on a
    // child that outlives its own output.
    for t in [out, err].into_iter().flatten() {
        let _ = t.join();
    }
    let text = buf.lock().unwrap_or_else(|e| e.into_inner()).clone();
    Ok((classify(&status), text))
}

/// Forward one pipe line-by-line to our own stream while appending it to the shared buffer.
fn pump<R: std::io::Read + Send + 'static>(
    r: R,
    buf: Arc<Mutex<String>>,
    to_stderr: bool,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(r);
        let mut line = String::new();
        loop {
            line.clear();
            // read_line, not lines(): a build tool's last line may have no newline, and `lines()`
            // would still yield it but a `read_to_string` at the end would have shown nothing until
            // the process died. Lossy on purpose — a build log is not guaranteed UTF-8 and a decode
            // error must not lose the diagnostic.
            let mut raw = Vec::new();
            match reader.read_until(b'\n', &mut raw) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let text = String::from_utf8_lossy(&raw).to_string();
            if to_stderr {
                let mut h = std::io::stderr().lock();
                let _ = h.write_all(text.as_bytes());
                let _ = h.flush();
            } else {
                let mut h = std::io::stdout().lock();
                let _ = h.write_all(text.as_bytes());
                let _ = h.flush();
            }
            if let Ok(mut b) = buf.lock() {
                b.push_str(&text);
            }
        }
    })
}

/// The title for a failure the extractor could not read — a command that printed nothing recognizable,
/// or nothing at all (a missing binary, a killed helper).
///
/// It names the COMMAND, which everywhere else is forbidden in a title: `fingerprint` is
/// `stage + title + frame`, so a varying command splits one fault into many. It is right here and only
/// here, because there is nothing else to say — this run's identity IS the command, and merging two
/// different commands that both failed silently under one fault would be a lie about what broke.
fn opaque_title(cmd: &[String], code: i32) -> String {
    let joined = cmd.join(" ");
    let short: String = joined.chars().take(120).collect();
    format!("`{short}` failed with no readable diagnostic (exit {code})")
}

/// What [`decide`] concluded should happen to the store — pure, so the whole policy is testable
/// without spawning anything or opening a db.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Record this fault.
    Record { title: String, detail: Option<String> },
    /// The run succeeded — clear whatever this source recorded before.
    Clear,
    /// Do nothing (an interrupt).
    Nothing,
}

/// The whole store-side policy, as a function of the outcome and the output.
pub fn decide(outcome: &Outcome, output: &str, cmd: &[String]) -> Action {
    if outcome.is_clean() {
        return Action::Clear;
    }
    if !outcome.is_fault() {
        return Action::Nothing;
    }
    match detect::extract(output) {
        Some(d) => Action::Record { title: d.title, detail: Some(d.detail) },
        None => Action::Record { title: opaque_title(cmd, outcome.exit_code()), detail: None },
    }
}

/// Apply one [`Action`] to the store at `path`, returning the one-line note to print (or `None` when
/// there is nothing to say).
///
/// **Every failure here is a silent no-op, deliberately.** The child has already run and its exit code
/// is already decided; an unopenable db, a failed write or a missing directory must never surface as
/// anything the caller could mistake for the command's own failure. This is the same fail-open rule
/// `record_supply_fault` states for this store, and it is why this returns a note rather than a Result.
pub fn apply_to_store(
    path: &std::path::Path,
    action: &Action,
    stage: &str,
    source: &str,
    level: &str,
    cmd: &[String],
    now_ms: i64,
) -> Option<String> {
    match action {
        Action::Nothing => None,
        Action::Record { title, detail } => {
            let store = crate::Store::open(path).ok()?;
            let input = crate::FaultInput {
                stage: stage.to_string(),
                level: level.to_string(),
                title: title.clone(),
                stack: detail.clone(),
                // The command rides HERE, not in the title (#4008's lesson): the source is the
                // producer's identity, is not part of the fingerprint, and is what a green run clears
                // by.
                source_hint: Some(source.to_string()),
                context: Some(cmd.join(" ")),
                release: None,
                ts: now_ms,
            };
            let f = store.record(&input).ok()?;
            Some(format!(
                "bsc errors: recorded {stage} fault {} (x{}) — read it with `bsc errors get {}`",
                f.fingerprint, f.count, f.fingerprint
            ))
        }
        Action::Clear => {
            let store = crate::Store::open(path).ok()?;
            let n = store.resolve_by_source(stage, source, now_ms).ok()?;
            (n > 0).then(|| format!("bsc errors: cleared {n} {stage} fault(s) this command had recorded"))
        }
    }
}

/// Run `cmd`, apply [`decide`] against the store at `db`, and exit with the child's own code.
///
/// Never returns on success — the exit is the point, and it is done here rather than by returning a
/// code because the CLI frame maps every `Err` to 1, which would erase the distinction between cargo's
/// 101, a missing binary's 127 and an ordinary failure. It returns `Err` only for a failure to START
/// the child, which is the caller's error rather than the child's.
pub fn run_and_record(
    cmd: &[String],
    db: Option<&std::path::Path>,
    stage: &str,
    source: &str,
    level: &str,
    now_ms: i64,
) -> Result<std::convert::Infallible, String> {
    let (outcome, output) = spawn_and_tee(cmd)?;
    // Everything from here is best-effort: the child has run, and nothing below may change what the
    // caller sees beyond one extra line on stderr saying where the fault went.
    if let Some(path) = db {
        let action = decide(&outcome, &output, cmd);
        if let Some(note) = apply_to_store(path, &action, stage, source, level, cmd, now_ms) {
            let _ = writeln!(std::io::stderr(), "{note}");
        }
    }
    let _ = std::io::stdout().flush();
    let _ = std::io::stderr().flush();
    std::process::exit(outcome.exit_code());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(code: Option<i32>, interrupted: bool) -> Outcome {
        Outcome { code, interrupted }
    }
    fn cmd() -> Vec<String> {
        vec!["cargo".into(), "build".into()]
    }

    /// The rule that keeps the store readable: stopping a dev server is not a defect.
    #[test]
    fn an_interrupt_records_nothing_and_clears_nothing() {
        for o in [out(None, true), out(Some(130), true), out(Some(143), true)] {
            assert_eq!(decide(&o, "error: boom", &cmd()), Action::Nothing, "{o:?}");
        }
        // An interrupt must not CLEAR either — it proves nothing about whether the last real failure
        // is fixed, and clearing on it would quietly erase a live fault.
        assert!(!out(Some(130), true).is_clean());
    }

    /// Every non-zero code is a failure — including cargo's 101, which is the common one here.
    #[test]
    fn a_real_failure_records_the_extracted_diagnostic() {
        let o = out(Some(101), false);
        let a = decide(&o, "   Compiling x\nerror[E0308]: mismatched types\n --> a.rs:1:1", &cmd());
        match a {
            Action::Record { title, detail } => {
                assert_eq!(title, "error[E0308]: mismatched types");
                assert!(detail.unwrap().contains("a.rs"), "the location rides in the detail");
            }
            other => panic!("expected a record, got {other:?}"),
        }
    }

    /// A failure with nothing readable still records — naming the command, because there is genuinely
    /// nothing else to say and silence here would be the same as not having the feature.
    #[test]
    fn an_unreadable_failure_records_the_command_rather_than_nothing() {
        let a = decide(&out(Some(127), false), "", &cmd());
        match a {
            Action::Record { title, detail } => {
                assert!(title.contains("cargo build") && title.contains("127"), "{title}");
                assert_eq!(detail, None, "there is no detail to invent");
            }
            other => panic!("expected a record, got {other:?}"),
        }
    }

    #[test]
    fn a_clean_run_clears_what_this_source_recorded() {
        assert_eq!(decide(&out(Some(0), false), "", &cmd()), Action::Clear);
    }

    /// The exit code is the child's, exactly — a caller chaining on `&&` must see what it would have
    /// seen unwrapped.
    #[test]
    fn the_exit_code_is_the_childs_own() {
        assert_eq!(out(Some(101), false).exit_code(), 101);
        assert_eq!(out(Some(0), false).exit_code(), 0);
        // A signal death has no code; 130 is what a shell would have reported.
        assert_eq!(out(None, true).exit_code(), 130);
    }

    /// The tee really runs a process, forwards it, and captures both streams merged — the property
    /// the extractor depends on, since cargo diagnoses on stderr and bundlers on stdout.
    #[test]
    fn spawn_captures_both_streams_and_the_real_exit_code() {
        let sh = if cfg!(windows) { "cmd" } else { "sh" };
        let args: Vec<String> = if cfg!(windows) {
            vec!["cmd".into(), "/C".into(), "echo out& echo err 1>&2& exit 3".into()]
        } else {
            vec![sh.into(), "-c".into(), "echo out; echo err 1>&2; exit 3".into()]
        };
        let (o, text) = spawn_and_tee(&args).expect("spawns");
        assert_eq!(o.code, Some(3), "the child's real code");
        assert!(!o.interrupted);
        assert!(text.contains("out") && text.contains("err"), "both streams captured: {text:?}");
    }

    /// The write path end to end: a failing run lands ONE row, a second identical failure bumps its
    /// count rather than adding a row, and a passing run clears it.
    #[test]
    fn record_then_clear_round_trips_against_a_real_store() {
        let dir = std::env::temp_dir().join(format!("errordb-run-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("error.db");
        let _ = std::fs::remove_file(&path);
        let c = cmd();
        let fail = out(Some(101), false);
        let log = "error[E0308]: mismatched types\n --> a.rs:1:1";

        let note = apply_to_store(&path, &decide(&fail, log, &c), "compile", "build:plan", "error", &c, 10);
        assert!(note.unwrap().contains("recorded compile fault"));
        // The same break at another line is the SAME fault — count 2, still one row.
        apply_to_store(&path, &decide(&fail, "error[E0308]: mismatched types\n --> a.rs:9:9", &c), "compile", "build:plan", "error", &c, 20);
        let store = crate::Store::open(&path).unwrap();
        let open = store.list(&crate::Filter { unresolved: true, ..Default::default() }).unwrap();
        assert_eq!(open.len(), 1, "one fault row");
        assert_eq!(open[0].count, 2, "a repeat bumps the count");
        assert_eq!(open[0].source_hint.as_deref(), Some("build:plan"));
        assert!(open[0].title.starts_with("error[E0308]"), "the title is the diagnostic, not the command");

        // ...and the fix clears it.
        let note = apply_to_store(&path, &decide(&out(Some(0), false), "", &c), "compile", "build:plan", "error", &c, 30);
        assert!(note.unwrap().contains("cleared 1"));
        assert!(store.list(&crate::Filter { unresolved: true, ..Default::default() }).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A green run clears ONLY what its own source recorded. Two producers writing the same stage must
    /// not clear each other, or a passing build would silently resolve a failing typecheck.
    #[test]
    fn a_clean_run_never_clears_another_sources_fault() {
        let dir = std::env::temp_dir().join(format!("errordb-run-src-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("error.db");
        let _ = std::fs::remove_file(&path);
        let c = cmd();
        let fail = decide(&out(Some(1), false), "error: boom", &c);
        apply_to_store(&path, &fail, "build", "mine", "error", &c, 10);
        apply_to_store(&path, &decide(&out(Some(1), false), "error: other", &c), "build", "theirs", "error", &c, 11);

        apply_to_store(&path, &Action::Clear, "build", "mine", "error", &c, 20);
        let store = crate::Store::open(&path).unwrap();
        let open = store.list(&crate::Filter { unresolved: true, ..Default::default() }).unwrap();
        assert_eq!(open.len(), 1, "only the other source's fault is left");
        assert_eq!(open[0].source_hint.as_deref(), Some("theirs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The first failure on a machine that has never had this project creates its hub, rather than
    /// silently recording nothing.
    ///
    /// Worth pinning because the fail-open rule above makes the opposite indistinguishable from
    /// working: a missing `projects/<key>/` directory would just mean no note and no row, forever, on
    /// exactly the fresh checkout where the first build failure is most likely.
    #[test]
    fn the_first_fault_creates_a_hub_that_does_not_exist_yet() {
        let base = std::env::temp_dir().join(format!("errordb-run-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let path = base.join("projects").join("brand-new").join("error.db");
        assert!(!path.exists());
        let c = cmd();
        let a = decide(&out(Some(1), false), "error: boom", &c);
        assert!(apply_to_store(&path, &a, "build", "s", "error", &c, 1).is_some(), "it recorded");
        assert!(path.is_file(), "the hub and its store were created: {}", path.display());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Fail-open: a store that genuinely cannot be opened is silent. It cannot panic, and it cannot
    /// produce a note that would read as if something had been recorded.
    ///
    /// (Unopenable, not merely absent — the path below is under a root nothing may create in. An absent
    /// directory is created, which is the test above.)
    #[test]
    fn an_unopenable_store_records_nothing_and_says_nothing() {
        let bad = std::path::Path::new("/definitely/not/a/directory/9f3a/error.db");
        let c = cmd();
        let a = decide(&out(Some(1), false), "error: boom", &c);
        assert_eq!(apply_to_store(bad, &a, "build", "s", "error", &c, 1), None);
        assert_eq!(apply_to_store(bad, &Action::Clear, "build", "s", "error", &c, 1), None);
    }

    /// A command that cannot START is the caller's error, not a fault: there is no failing build to
    /// record, and filing one would attribute a typo in the wrapper to the project.
    #[test]
    fn a_command_that_cannot_start_is_an_error_not_a_fault() {
        let err = spawn_and_tee(&["definitely-not-a-real-binary-9f3a".to_string()]).unwrap_err();
        assert!(err.contains("cannot start"), "{err}");
    }
}
