//! Child-process spawning helpers (#1300). Extracted verbatim from `lib.rs`.

/// Suppress the console window Windows pops for each child process (#432).
///
/// A GUI-subsystem Tauri build has no console, so every `std::process::Command`
/// it spawns (git, the readiness-probe shell, …) would otherwise flash — or, on
/// Windows 10, *persist* — its own `cmd`/`conhost` window with no way to close it.
/// The `CREATE_NO_WINDOW` (0x0800_0000) creation flag spawns the child detached
/// from any console. No-op on non-Windows. Call it on the `Command` right before
/// `.status()`/`.output()`/`.spawn()`. (The PTY path is unaffected — it goes
/// through portable_pty's headless ConPTY, not `std::process`.)
pub(crate) fn no_window(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

// ── the command-runner (#1867) ────────────────────────────────────────────────────
// One place that applies `no_window` before every `std::process` spawn, so a caller can never
// forget the Windows no-console-window flag, and the few shapes the codebase actually needs
// (run-for-status, run-and-capture) live behind named helpers instead of being re-hand-rolled at
// each git/gh/pnpm site. These preserve `std::io::Result`/exit-status semantics verbatim — they
// only fold in the `no_window` call — so callers keep their exact error mapping.

/// Run `cmd` to completion (console window suppressed) and return its exit status. Equivalent to
/// `no_window(cmd).status()` — the io error (e.g. program missing) is propagated, not swallowed.
pub(crate) fn run_status(cmd: &mut std::process::Command) -> std::io::Result<std::process::ExitStatus> {
    no_window(cmd).status()
}

/// Run `cmd` (console window suppressed) and return its captured output. Equivalent to
/// `no_window(cmd).output()` — stdout/stderr are buffered and the io error is propagated.
pub(crate) fn run_output(cmd: &mut std::process::Command) -> std::io::Result<std::process::Output> {
    no_window(cmd).output()
}

/// Did `cmd` spawn AND exit successfully? A spawn error (program missing) or a non-zero exit both
/// yield `false` — the common status-only check (`…status().map(|s| s.success()).unwrap_or(false)`).
pub(crate) fn run_ok(cmd: &mut std::process::Command) -> bool {
    run_status(cmd).map(|s| s.success()).unwrap_or(false)
}

/// Run `cmd`, capturing output: `Ok(trimmed stdout)` on a successful exit, else `Err` carrying the
/// trimmed stderr (on a non-zero exit) or the io error string (when the spawn itself failed).
pub(crate) fn run_capture(cmd: &mut std::process::Command) -> Result<String, String> {
    match run_output(cmd) {
        Ok(o) if o.status.success() => Ok(String::from_utf8_lossy(&o.stdout).trim().to_string()),
        Ok(o) => Err(String::from_utf8_lossy(&o.stderr).trim().to_string()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    /// `run_ok` is true only for a clean exit; a non-zero exit and a missing program are both
    /// `false` (and never panic). Uses `git`, which the test suite already requires.
    #[test]
    fn run_ok_true_on_success_false_on_failure_or_missing() {
        assert!(run_ok(Command::new("git").arg("--version")), "git --version exits 0");
        assert!(
            !run_ok(Command::new("git").arg("definitely-not-a-subcommand")),
            "unknown subcommand exits non-zero"
        );
        assert!(
            !run_ok(&mut Command::new("bsc-no-such-binary-xyz-1867")),
            "missing program ⇒ false, not a panic"
        );
    }

    /// `run_capture` returns trimmed stdout on success, and an `Err` (stderr or io error) otherwise.
    #[test]
    fn run_capture_returns_stdout_on_success_err_otherwise() {
        let out = run_capture(Command::new("git").arg("--version")).expect("git --version ok");
        assert!(out.contains("git version"), "captured stdout: {out:?}");
        assert!(
            run_capture(Command::new("git").arg("definitely-not-a-subcommand")).is_err(),
            "non-zero exit ⇒ Err"
        );
        assert!(
            run_capture(&mut Command::new("bsc-no-such-binary-xyz-1867")).is_err(),
            "missing program ⇒ Err, not a panic"
        );
    }
}
