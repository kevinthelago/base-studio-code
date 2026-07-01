// Authored PTY spawn ledger (#1049) — the crash safety net for child-process ownership.
//
// The live path is the per-session Job Object (Windows) / process-group (Unix): a CLEAN drop or
// `RunEvent::Exit` instantly tree-kills the shell → `claude` → `gh`/`git`/MCP children. But that hook
// only runs on a graceful shutdown. A crash, a force-kill, or `Ctrl+C` on `tauri dev` skips it, and
// the OS's `KILL_ON_JOB_CLOSE` is not reliable through every abrupt-exit path — so children can leak
// (observed: dozens of orphaned `claude`/`bash`, some spinning at 100% CPU, starving the machine).
//
// This module makes the app AUTHOR what it spawns: every shell pid is recorded to a flat ledger at
// `~/.base-studio-code/pty-ledger.json` (readable at the very start of boot, before heavier
// subsystems). On the NEXT launch we reconcile it — any entry whose owning app instance is gone, and
// whose child is still alive AND is verifiably the same process (start-time token, the PID-recycle
// guard), gets tree-killed. It can ONLY ever kill pids it recorded spawning under a now-dead owner —
// never the user's own terminals. Ties into #1041 (unclean-shutdown detection).

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

/// One recorded shell spawn. The tuple (owner_pid alive?, pid alive?, start_token match?) decides its
/// fate on the next boot.
#[derive(Clone, Serialize, Deserialize, PartialEq, Debug)]
pub(crate) struct LedgerEntry {
    pub pid: u32,
    pub pane_id: String,
    /// The app process that spawned this child. Reaped only once this owner is no longer alive, so a
    /// second concurrent app instance never reaps the first's children.
    pub owner_pid: u32,
    /// Process creation-time token of `pid` at spawn — the PID-recycle guard. `0` = the platform
    /// couldn't provide one (macOS), in which case reconcile falls back to liveness-only.
    pub start_token: u64,
}

// Serializes concurrent ledger mutations (pty_create / pty_kill happen on different threads).
static LEDGER_LOCK: Mutex<()> = Mutex::new(());

fn ledger_path() -> PathBuf {
    crate::bsc_base_dir().join("pty-ledger.json")
}

fn load_unlocked() -> Vec<LedgerEntry> {
    match std::fs::read_to_string(ledger_path()) {
        Ok(s) => serde_json::from_str(&s).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_unlocked(entries: &[LedgerEntry]) {
    let path = ledger_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(s) = serde_json::to_string(entries) {
        // Write-then-rename so a crash mid-write can't leave a truncated/corrupt ledger.
        let tmp = path.with_extension("json.tmp");
        if std::fs::write(&tmp, s).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }
}

/// Record a freshly spawned shell. Called from `pty_create` right after the pid is known.
pub(crate) fn record(pid: u32, pane_id: &str) {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = load_unlocked();
    v.retain(|e| e.pane_id != pane_id); // a re-used pane replaces its stale entry
    v.push(LedgerEntry {
        pid,
        pane_id: pane_id.to_string(),
        owner_pid: std::process::id(),
        start_token: os_start_token(pid),
    });
    save_unlocked(&v);
}

/// Drop a pane's entry. Called from `pty_kill` (the session is being torn down cleanly).
pub(crate) fn forget_pane(pane_id: &str) {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = load_unlocked();
    let before = v.len();
    v.retain(|e| e.pane_id != pane_id);
    if v.len() != before {
        save_unlocked(&v);
    }
}

/// The project key a ledger pane id belongs to: everything before the first `:` of an identity
/// id (`<key>:<stream>` / `<key>:director` / `<key>:<repo>:triage`). `None` for a manual scratch
/// pane (`man:…`, never project-owned) or a key-less positional id (`t<idx>p<idx>`).
pub(crate) fn project_key_of(pane_id: &str) -> Option<&str> {
    if pane_id.starts_with("man:") {
        return None;
    }
    match pane_id.split_once(':') {
        Some((key, _)) if !key.is_empty() => Some(key),
        _ => None,
    }
}

/// Pure split of a project's reap (#1279): of every ledger entry, partition out the ones belonging
/// to `key` (`<key>:…` identity panes) — return the live pids to tree-kill and the survivors to keep.
/// A dead pid is simply dropped (nothing to kill). Manual/positional panes never match a project key.
pub(crate) fn select_project_shells(
    entries: &[LedgerEntry],
    key: &str,
    probe: &impl ProcProbe,
) -> (Vec<u32>, Vec<LedgerEntry>) {
    let mut kill = Vec::new();
    let mut keep = Vec::new();
    for e in entries {
        if project_key_of(&e.pane_id) == Some(key) {
            if probe.alive(e.pid) {
                kill.push(e.pid);
            }
            // forgotten either way (killed or already dead) — not pushed to `keep`
        } else {
            keep.push(e.clone());
        }
    }
    (kill, keep)
}

/// Reap a deleted project's still-running shells (#1279): tree-kill every live pid whose ledger
/// pane id is `<key>:…` and forget all of the project's ledger entries, so a deleted project's
/// shells can't survive as orphaned pids that discovery would surface as unrestorable. Returns the
/// count of live shells killed (for logging). Best-effort: a missing/empty ledger is a no-op.
pub(crate) fn reap_project_shells(key: &str) -> usize {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = load_unlocked();
    if entries.is_empty() {
        return 0;
    }
    let (kill, keep) = select_project_shells(&entries, key, &OsProbe);
    for pid in &kill {
        log::warn!("[pty-reaper] reaping shell pid={pid} of deleted project {key:?}");
        tree_kill(*pid);
    }
    if keep.len() != entries.len() {
        save_unlocked(&keep);
    }
    kill.len()
}

/// Pure split for reaping ONE session by its identity pane id (#1266 "Discard"): return its live pid
/// to tree-kill (if any) and the survivors to keep. A dead/absent pid kills nothing. Testable with a
/// fake probe.
pub(crate) fn select_session_shell(
    entries: &[LedgerEntry],
    pane_id: &str,
    probe: &impl ProcProbe,
) -> (Option<u32>, Vec<LedgerEntry>) {
    let mut kill = None;
    let mut keep = Vec::new();
    for e in entries {
        if e.pane_id == pane_id {
            if probe.alive(e.pid) {
                kill = Some(e.pid);
            }
            // dropped from `keep` either way (killed or already dead → forgotten)
        } else {
            keep.push(e.clone());
        }
    }
    (kill, keep)
}

/// Reap ONE discovered session by its identity pane id (#1266 "Discard"): tree-kill its still-running
/// shell (if any) and forget its ledger entry. Backs the recovery panel's Discard action for an
/// orphaned/unwanted session. Returns true if a live shell was killed. Best-effort: an unknown pane id
/// is a no-op (returns false).
pub(crate) fn reap_session(pane_id: &str) -> bool {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = load_unlocked();
    let (kill, keep) = select_session_shell(&entries, pane_id, &OsProbe);
    if let Some(pid) = kill {
        log::warn!("[pty-reaper] reaping discarded session pid={pid} pane={pane_id:?}");
        tree_kill(pid);
    }
    if keep.len() != entries.len() {
        save_unlocked(&keep);
    }
    kill.is_some()
}

/// Drop every entry this app instance owns. Called from `kill_all_pty_sessions` (clean exit), so a
/// graceful shutdown leaves the ledger clean and the next boot has nothing to reconcile.
pub(crate) fn forget_all_owned() {
    let me = std::process::id();
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut v = load_unlocked();
    v.retain(|e| e.owner_pid != me);
    save_unlocked(&v);
}

/// A snapshot of every recorded ledger entry — the *running-session* source for session
/// discovery (#1266). Each entry's `pane_id` is the stable identity id, so a live session
/// can be recovered from its name even when the persisted store has forgotten it.
pub(crate) fn ledger_entries() -> Vec<LedgerEntry> {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_unlocked()
}

/// Whether `pid` is currently alive (OS-native probe) — reused by discovery to tell a
/// running session from a stale ledger entry (#1266).
pub(crate) fn is_pid_alive(pid: u32) -> bool {
    os_alive(pid)
}

/// Boot reconcile: tree-kill any straggler from a prior run whose owner is gone, then persist the
/// survivors (entries still owned by a live instance). Returns the count reaped, for logging.
pub(crate) fn reconcile_on_boot() -> usize {
    let _g = LEDGER_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let entries = load_unlocked();
    if entries.is_empty() {
        return 0;
    }
    let (kill, keep) = select_orphans(&entries, &OsProbe);
    for pid in &kill {
        log::warn!("[pty-reaper] reaping orphaned PTY child pid={pid} (owning app instance is gone)");
        tree_kill(*pid);
    }
    save_unlocked(&keep);
    kill.len()
}

/// Probe of OS process state — the only impurity; mocked in tests.
pub(crate) trait ProcProbe {
    fn alive(&self, pid: u32) -> bool;
    /// Process creation-time token, or `None` if the process can't be opened (gone / no access).
    fn start_token(&self, pid: u32) -> Option<u64>;
}

/// Pure reconcile decision — split entries into (pids to tree-kill, entries to keep):
/// - owner still alive → KEEP (another instance owns it; never reap a live owner's children).
/// - owner gone, child alive, same process (token) → KILL (a true orphan).
/// - owner gone, child gone, or a recycled pid → drop (neither kill nor keep).
pub(crate) fn select_orphans(
    entries: &[LedgerEntry],
    probe: &impl ProcProbe,
) -> (Vec<u32>, Vec<LedgerEntry>) {
    let mut kill = Vec::new();
    let mut keep = Vec::new();
    for e in entries {
        if probe.alive(e.owner_pid) {
            keep.push(e.clone());
        } else if probe.alive(e.pid) && token_ok(probe.start_token(e.pid), e.start_token) {
            kill.push(e.pid);
        }
    }
    (kill, keep)
}

/// Whether the live process at this pid is the SAME one we recorded. A recorded token of `0` means we
/// never had one (macOS) → reap on liveness alone; otherwise the live token must match exactly, so a
/// recycled pid (different process now holding the number) is left untouched.
fn token_ok(now: Option<u64>, recorded: u64) -> bool {
    if recorded == 0 {
        return true;
    }
    matches!(now, Some(t) if t == recorded)
}

// ── OS-native probe + tree-kill ──────────────────────────────────────────────

struct OsProbe;

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
fn os_alive(pid: u32) -> bool {
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
fn os_start_token(pid: u32) -> u64 {
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
fn tree_kill(pid: u32) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // `taskkill /T` kills the whole tree; `/F` forces. We've already verified (owner dead + same
    // process via token) that this pid is our orphan, so a forced tree-kill is safe.
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

#[cfg(not(windows))]
fn os_alive(pid: u32) -> bool {
    // SAFETY: signal 0 performs only the permission/existence check, no delivery.
    let r = unsafe { libc::kill(pid as i32, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(target_os = "linux")]
fn os_start_token(pid: u32) -> u64 {
    // /proc/<pid>/stat field 22 = starttime (jiffies since boot). The comm field (2) can contain
    // spaces/parens, so split after its closing ')': the remainder starts at state (field 3), making
    // starttime the 20th token (index 19).
    let Ok(s) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { return 0 };
    let Some(after) = s.rfind(')').map(|i| &s[i + 1..]) else { return 0 };
    after.split_whitespace().nth(19).and_then(|f| f.parse().ok()).unwrap_or(0)
}

#[cfg(all(unix, not(target_os = "linux")))]
fn os_start_token(_pid: u32) -> u64 {
    // macOS/BSD: no cheap creation-time read here → `0` sentinel; reconcile falls back to
    // liveness-only (still gated on the owner being dead), accepting the rare boot-window recycle.
    0
}

#[cfg(not(windows))]
fn tree_kill(pid: u32) {
    // The shell is a setsid group leader (pgid == pid), so signalling the group reaps the tree.
    // SAFETY: killpg has no memory effects; ESRCH (group already gone) is a benign no-op.
    unsafe {
        libc::killpg(pid as i32, libc::SIGKILL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    struct Fake {
        alive: HashSet<u32>,
        tokens: HashMap<u32, u64>,
    }
    impl ProcProbe for Fake {
        fn alive(&self, pid: u32) -> bool {
            self.alive.contains(&pid)
        }
        fn start_token(&self, pid: u32) -> Option<u64> {
            if self.alive.contains(&pid) {
                Some(self.tokens.get(&pid).copied().unwrap_or(0))
            } else {
                None
            }
        }
    }

    fn entry(pid: u32, owner: u32, token: u64) -> LedgerEntry {
        LedgerEntry { pid, pane_id: format!("t0p{pid}"), owner_pid: owner, start_token: token }
    }

    #[test]
    fn reaps_only_orphans_whose_owner_is_gone() {
        let entries = vec![
            entry(100, 9, 5000), // owner 9 DEAD, child alive, token matches → KILL
            entry(101, 8, 6000), // owner 8 ALIVE → KEEP (never touch a live owner's children)
            entry(102, 9, 7000), // owner dead, child DEAD → drop
        ];
        let probe = Fake {
            alive: HashSet::from([100, 101, 8]), // 9 dead, 102 dead
            tokens: HashMap::from([(100, 5000), (101, 6000)]),
        };
        let (kill, keep) = select_orphans(&entries, &probe);
        assert_eq!(kill, vec![100]);
        assert_eq!(keep.iter().map(|e| e.pid).collect::<Vec<_>>(), vec![101]);
    }

    #[test]
    fn recycled_pid_is_not_killed() {
        // Owner dead, pid alive, but the live process has a DIFFERENT creation token than recorded —
        // the number was recycled by an unrelated process. Must NOT kill it.
        let entries = vec![entry(200, 9, 5000)];
        let probe = Fake { alive: HashSet::from([200]), tokens: HashMap::from([(200, 9999)]) };
        let (kill, keep) = select_orphans(&entries, &probe);
        assert!(kill.is_empty());
        assert!(keep.is_empty()); // dropped, neither killed nor retained
    }

    #[test]
    fn zero_token_reaps_on_liveness_alone() {
        // macOS path: recorded token 0 → can't recycle-guard, reap if owner gone + child alive.
        let entries = vec![entry(300, 9, 0)];
        let probe = Fake { alive: HashSet::from([300]), tokens: HashMap::new() };
        let (kill, _) = select_orphans(&entries, &probe);
        assert_eq!(kill, vec![300]);
    }

    #[test]
    fn token_ok_rules() {
        assert!(token_ok(Some(0), 0)); // both unknown → liveness-only
        assert!(token_ok(None, 0)); // recorded unknown → reap regardless of now
        assert!(token_ok(Some(42), 42)); // exact match
        assert!(!token_ok(Some(43), 42)); // mismatch (recycled)
        assert!(!token_ok(None, 42)); // had a token, can't read now → conservative skip
    }

    #[test]
    fn project_key_of_parses_identity_ids() {
        assert_eq!(project_key_of("proj:auth-ui"), Some("proj"));
        assert_eq!(project_key_of("proj:director"), Some("proj"));
        assert_eq!(project_key_of("proj:own/web:triage"), Some("proj"));
        assert_eq!(project_key_of("man:scratch:p0"), None); // manual — never project-owned
        assert_eq!(project_key_of("t0p1"), None); // positional — no key
        assert_eq!(project_key_of(":bad"), None); // empty key
    }

    /// #1279: reaping a deleted project's shells kills its LIVE pids and forgets ALL its ledger
    /// entries (live or dead), while every other project's entries are kept untouched.
    #[test]
    fn select_project_shells_kills_and_forgets_only_the_deleted_project() {
        let entries = vec![
            LedgerEntry { pid: 100, pane_id: "gone:auth".into(), owner_pid: 1, start_token: 0 }, // live → KILL + forget
            LedgerEntry { pid: 101, pane_id: "gone:director".into(), owner_pid: 1, start_token: 0 }, // dead → forget only
            LedgerEntry { pid: 102, pane_id: "keep:api".into(), owner_pid: 1, start_token: 0 }, // other project → KEEP
            LedgerEntry { pid: 103, pane_id: "man:s:p0".into(), owner_pid: 1, start_token: 0 }, // manual → KEEP
        ];
        let probe = Fake {
            alive: HashSet::from([100, 102, 103]), // 101 (gone's director) is dead
            tokens: HashMap::new(),
        };
        let (kill, keep) = select_project_shells(&entries, "gone", &probe);
        assert_eq!(kill, vec![100]); // only the deleted project's LIVE shell is killed
        // Both of "gone"'s entries are dropped; the other project + manual survive.
        assert_eq!(
            keep.iter().map(|e| e.pane_id.as_str()).collect::<Vec<_>>(),
            vec!["keep:api", "man:s:p0"],
        );
    }

    #[test]
    fn select_session_shell_kills_live_and_forgets_only_that_pane() {
        let entries = vec![
            LedgerEntry { pid: 200, pane_id: "proj:auth".into(), owner_pid: 1, start_token: 0 }, // target, live → KILL + forget
            LedgerEntry { pid: 201, pane_id: "proj:api".into(), owner_pid: 1, start_token: 0 },  // other pane → KEEP
        ];
        let probe = Fake { alive: HashSet::from([200, 201]), tokens: HashMap::new() };
        let (kill, keep) = select_session_shell(&entries, "proj:auth", &probe);
        assert_eq!(kill, Some(200));
        assert_eq!(keep.iter().map(|e| e.pane_id.as_str()).collect::<Vec<_>>(), vec!["proj:api"]);

        // A dead target is forgotten without a kill; an unknown pane id is a pure no-op (keeps all).
        let dead = Fake { alive: HashSet::new(), tokens: HashMap::new() };
        assert_eq!(select_session_shell(&entries, "proj:auth", &dead).0, None);
        let (k, keep_all) = select_session_shell(&entries, "proj:nope", &probe);
        assert_eq!(k, None);
        assert_eq!(keep_all.len(), 2);
    }

    #[test]
    fn entry_json_roundtrips() {
        let e = entry(123, 456, 789);
        let s = serde_json::to_string(&e).unwrap();
        let back: LedgerEntry = serde_json::from_str(&s).unwrap();
        assert_eq!(e, back);
    }
}
