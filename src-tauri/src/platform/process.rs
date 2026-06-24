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
