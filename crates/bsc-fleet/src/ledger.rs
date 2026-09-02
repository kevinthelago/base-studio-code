//! The PTY spawn ledger's ON-DISK SHAPE, and the OS primitives that act on it.
//!
//! This lives in a crate rather than in the app because a reader that is not the app needs it. The
//! ledger at `~/.base-studio-code/pty-ledger.json` is the only record of what the app spawned, and
//! after an UNCLEAN death it is the only thing that can find the survivors — at which point, by
//! definition, the app is not running to be asked.
//!
//! # What survives an unclean death, and what does not
//!
//! On a CLEAN exit nothing survives: `kill_all_pty_sessions` drops every `PtyJob`, whose `Drop` does
//! `killpg`, and `forget_all_owned` empties the ledger. There is nothing left to enforce against, so
//! a warden that outlives a graceful shutdown would have no subject.
//!
//! On SIGKILL / OOM / panic, `Drop` never runs. `portable_pty` calls `setsid()`, so each shell LEADS
//! ITS OWN PROCESS GROUP and is not in the dying app's group — it is orphaned and keeps executing,
//! unsupervised, until the next app launch reconciles the ledger. That window is the whole reason
//! `a-warden-survives-the-app-that-restarts-under-it` exists, and it is bounded by
//! unclean-death → next launch: overnight, not indefinitely.
//!
//! # The kill handle is the pid itself
//!
//! `setsid()` makes pgid == pid, so `killpg(-pid)` reaps the shell and everything it spawned. That is
//! the same mechanism `PtyJob::drop` and the boot reconcile already use — this module is where that
//! one definition now lives, so a sweep run from `bsc` and a reap run from the app cannot drift into
//! two different ideas of what killing a session means.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// One recorded shell spawn. The tuple (owner_pid alive?, pid alive?, start_token match?) decides its
/// fate on the next boot.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub struct LedgerEntry {
    pub pid: u32,
    pub pane_id: String,
    /// The app process that spawned this child. Reaped only once this owner is no longer alive, so a
    /// second concurrent app instance never reaps the first's children.
    pub owner_pid: u32,
    /// Process creation-time token of `pid` at spawn — the PID-recycle guard. `0` = the platform
    /// couldn't provide one (macOS), in which case reconcile falls back to liveness-only.
    pub start_token: u64,
}

/// `<base>/pty-ledger.json`. `base` is passed rather than resolved so a test never has to repoint
/// `HOME` — env mutation is process-global, which behaves differently under `cargo test` (one shared
/// process) and `cargo nextest` (one per test).
pub fn ledger_path(base: &Path) -> PathBuf {
    base.join("pty-ledger.json")
}

/// Read the ledger. A missing or corrupt file is an EMPTY ledger, never an error: this is read on the
/// recovery path, and refusing to run because the file is unreadable would mean no enforcement at
/// exactly the moment enforcement is wanted.
pub fn load(base: &Path) -> Vec<LedgerEntry> {
    match std::fs::read_to_string(ledger_path(base)) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// The project key a ledger pane id belongs to: everything before the first `:` of an identity id
/// (`<key>:<stream>` / `<key>:director` / `<key>:<repo>:triage`). `None` for a manual scratch pane
/// (`man:…`, never project-owned) or a key-less positional id (`t<idx>p<idx>`).
pub fn project_key_of(pane_id: &str) -> Option<&str> {
    if pane_id.starts_with("man:") {
        return None;
    }
    match pane_id.split_once(':') {
        Some((key, _)) if !key.is_empty() => Some(key),
        _ => None,
    }
}

/// Probe of OS process state — the only impurity; mocked in tests.
pub trait ProcProbe {
    fn alive(&self, pid: u32) -> bool;
    /// Process creation-time token, or `None` if the process can't be opened (gone / no access).
    fn start_token(&self, pid: u32) -> Option<u64>;
}

/// The real probe.
pub struct OsProbe;

impl ProcProbe for OsProbe {
    fn alive(&self, pid: u32) -> bool {
        os_alive(pid)
    }
    fn start_token(&self, pid: u32) -> Option<u64> {
        if os_alive(pid) {
            Some(os_start_token(pid))
        } else {
            None
        }
    }
}

#[cfg(windows)]
pub fn os_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: OpenProcess returns a valid handle or NULL; we close it before returning.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code);
        CloseHandle(h);
        ok != 0 && code == STILL_ACTIVE
    }
}

#[cfg(windows)]
pub fn os_start_token(pid: u32) -> u64 {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: handle is closed before returning; the FILETIMEs are zero-inited out-params.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return 0;
        }
        let mut c: FILETIME = std::mem::zeroed();
        let mut e: FILETIME = std::mem::zeroed();
        let mut k: FILETIME = std::mem::zeroed();
        let mut u: FILETIME = std::mem::zeroed();
        let ok = GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u);
        CloseHandle(h);
        if ok == 0 {
            return 0;
        }
        ((c.dwHighDateTime as u64) << 32) | (c.dwLowDateTime as u64)
    }
}

#[cfg(windows)]
pub fn tree_kill(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `taskkill /T` kills the whole tree; `/F` forces. The caller has already verified this pid is a
    // genuine orphan (owner dead + same process via token), so a forced tree-kill is safe.
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
pub fn os_alive(pid: u32) -> bool {
    // SAFETY: signal 0 performs only the permission/existence check, no delivery.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "linux")]
pub fn os_start_token(pid: u32) -> u64 {
    // /proc/<pid>/stat field 22 = starttime (jiffies since boot). The comm field (2) can contain
    // spaces/parens, so split after its closing ')': the remainder starts at state (field 3), making
    // starttime the 20th token (index 19).
    let Ok(s) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return 0 };
    let Some(after) = s.rfind(')').map(|i| &s[i + 1..]) else { return 0 };
    after.split_whitespace().nth(19).and_then(|f| f.parse().ok()).unwrap_or(0)
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn os_start_token(_pid: u32) -> u64 {
    // macOS/BSD: no cheap creation-time read here → `0` sentinel; reconcile falls back to
    // liveness-only (still gated on the owner being dead), accepting the rare boot-window recycle.
    0
}

#[cfg(not(windows))]
pub fn tree_kill(pid: u32) {
    // The shell is a setsid group leader (pgid == pid), so signalling the group reaps the tree.
    // SAFETY: killpg has no memory effects; ESRCH (group already gone) is a benign no-op.
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-ledger-{tag}-{}", bsc_util::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_missing_or_corrupt_ledger_is_empty_never_an_error() {
        let d = scratch("missing");
        assert!(load(&d).is_empty(), "no file at all");

        std::fs::write(ledger_path(&d), "{not json").unwrap();
        assert!(load(&d).is_empty(), "a corrupt ledger degrades to empty rather than refusing");

        // Refusing here would mean NO ENFORCEMENT at exactly the moment it is wanted — the recovery
        // path after an unclean death is where this file is read.
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn the_on_disk_shape_round_trips() {
        let d = scratch("roundtrip");
        let rows = vec![
            LedgerEntry { pid: 42, pane_id: "proj:api".into(), owner_pid: 7, start_token: 99 },
            LedgerEntry { pid: 43, pane_id: "man:s:p0".into(), owner_pid: 7, start_token: 0 },
        ];
        std::fs::write(ledger_path(&d), serde_json::to_string(&rows).unwrap()).unwrap();
        assert_eq!(load(&d), rows, "what the app writes is what a reader outside it reads");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_pane_ids_project_is_read_off_its_prefix() {
        assert_eq!(project_key_of("proj:api"), Some("proj"));
        assert_eq!(project_key_of("proj:repo:triage"), Some("proj"));
        assert_eq!(project_key_of("man:build:p2"), None, "a manual pane is never project-owned");
        assert_eq!(project_key_of("t0p1"), None, "a positional id carries no key");
        assert_eq!(project_key_of(":api"), None, "an empty key is not a key");
    }

    /// The probe must not claim a pid is alive when it is not — the sweep gates every action on it.
    #[test]
    fn liveness_is_true_for_this_process_and_false_for_an_impossible_pid() {
        assert!(os_alive(std::process::id()), "this process is alive");
        // 0 is never a real pid to probe; on unix `kill(0, 0)` addresses the caller's whole group, so
        // use a pid that cannot exist instead of trusting 0 to be a sentinel.
        assert!(!os_alive(u32::MAX - 1), "an impossible pid is not alive");
    }
}
