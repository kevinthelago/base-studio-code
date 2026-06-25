// PTY session lifecycle: state registry, process-tree-kill Job Object, the
// pty_* commands, the session env, and the mobile-tunnel bridge
// (extracted from lib.rs, #758).

use crate::{
    bsc_base_dir, to_bash_path, to_native_path, nearest_existing_ancestor, split_utf8_at_boundary,
};
use crate::bsc::{
    BSC_CHECKPOINT_RC, BSC_DECISIONS_RC, BSC_AUDIT_RC, BSC_SKILL_RC, BSC_HOOK_RC, BSC_MCP_RC,
    BSC_TOKENS_RC, BSC_CONFINE_RC, BSC_SCOPE_RC, BSC_TAINT_RC, BSC_COORD_EMIT_RC, BSC_DEFER_RC, BSC_FLEET_RC, BSC_PLAN_RC,
};
use crate::{perf, tunnel};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

// ── PTY state ────────────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Owns the shell + its descendants so dropping the session reclaims the
    /// whole tree — `claude`, any `gh`/`git`/MCP child, etc. On Windows this is a
    /// kill-on-close Job Object; on Unix it is the shell's process-group id, which
    /// `killpg(pgid, SIGKILL)` reaps on drop (#118). `None` only when setup failed
    /// at spawn time (logged; falls back to plain child kill, which leaves
    /// grandchildren orphaned).
    _job: Option<PtyJob>,
}

pub(crate) struct PtyState(Mutex<HashMap<String, PtySession>>);

impl PtyState {
    /// Fresh empty session registry, managed by Tauri (`run()`); the field stays
    /// private so the map is only reachable from this module.
    pub(crate) fn new() -> Self {
        PtyState(Mutex::new(HashMap::new()))
    }
}

// ── Process tree kill (Windows Job Object) ───────────────────────────────────

/// RAII wrapper around a Windows Job Object configured to kill every assigned
/// process when the last handle closes. We give each PTY shell its own job and
/// assign the shell's PID right after spawn, so dropping the session on
/// `pty_kill` / app exit terminates the whole tree (shell → `claude` → any
/// `gh`/`git`/MCP child). Without this, `portable_pty::Child::kill()` only
/// reaches the immediate shell — observed in the field as ~28 orphan
/// `bash`/`claude`/WebView children holding cwd locks after app exit.
#[cfg(windows)]
struct PtyJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

/// Unix counterpart of the Job Object: the process-group id of the PTY shell.
/// `portable_pty` runs `setsid()` in the spawned shell, so the shell leads a new
/// session and a process group whose pgid equals the shell's pid. Every child it
/// spawns (`claude`, `gh`, `git`, MCP servers) stays in that group unless it
/// re-`setsid`s, so `killpg(pgid, SIGKILL)` on drop terminates the whole tree —
/// the same orphan-leak fix the Windows job provides. Stored in an atomic so
/// `assign_pid(&self, …)` can record the pid through the shared `new()`/
/// `assign_pid` call site without `&mut`; `PtyJob` stays `Send + Sync`.
#[cfg(not(windows))]
struct PtyJob {
    pgid: std::sync::atomic::AtomicI32,
}

#[cfg(windows)]
impl PtyJob {
    /// Create a kill-on-close job. Returns `Err` if the kernel refuses; the
    /// caller logs and proceeds without tree-kill rather than failing the spawn.
    fn new() -> std::io::Result<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: NULL attributes + NULL name is the documented anonymous-job
        // form; the call returns a valid HANDLE or NULL on failure.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // Zero-init is the documented way to start an EXTENDED_LIMIT_INFORMATION
        // and then set only the flags we care about.
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: pointer + size match the JobObjectExtendedLimitInformation
        // information class.
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            let err = std::io::Error::last_os_error();
            // Don't leak the handle when configuration fails.
            unsafe { CloseHandle(handle); }
            return Err(err);
        }
        Ok(Self { handle })
    }

    /// Assign the process identified by `pid` to this job. The process's later
    /// descendants inherit job membership (modern Windows nested-job default),
    /// so the whole tree shares the job's kill-on-close fate. Opens a transient
    /// process handle with `PROCESS_SET_QUOTA | PROCESS_TERMINATE` — the minimum
    /// access `AssignProcessToJobObject` requires.
    fn assign_pid(&self, pid: u32) -> std::io::Result<()> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };
        // SAFETY: OpenProcess returns a valid HANDLE or NULL on failure.
        let proc = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if proc.is_null() {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: both handles are valid until we close `proc` below.
        let ok = unsafe { AssignProcessToJobObject(self.handle, proc) };
        let err = if ok == 0 { Some(std::io::Error::last_os_error()) } else { None };
        unsafe { CloseHandle(proc); }
        match err { Some(e) => Err(e), None => Ok(()) }
    }
}

#[cfg(windows)]
impl Drop for PtyJob {
    fn drop(&mut self) {
        // Closing the last handle on a KILL_ON_JOB_CLOSE job terminates every
        // process still in the job — that's the actual tree kill.
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle); }
    }
}

// SAFETY: a job HANDLE is an opaque OS-side reference; the kernel handles
// cross-thread access. We never expose the raw handle outside this module.
#[cfg(windows)]
unsafe impl Send for PtyJob {}
#[cfg(windows)]
unsafe impl Sync for PtyJob {}

#[cfg(not(windows))]
impl PtyJob {
    /// Create an unbound job. The shell's process group isn't known until after
    /// spawn, so `pgid` starts at 0 (no-op on drop) and is filled by `assign_pid`.
    /// Infallible — the `Result` mirrors the Windows signature for a shared call
    /// site.
    fn new() -> std::io::Result<Self> {
        Ok(Self { pgid: std::sync::atomic::AtomicI32::new(0) })
    }

    /// Record the shell's pid as the group to reap. Because `portable_pty`
    /// `setsid`s the child, the shell IS its group leader, so pgid == pid — no
    /// `getpgid` round-trip (which could race the child's `setsid`). Infallible;
    /// the `Result` mirrors the Windows signature.
    fn assign_pid(&self, pid: u32) -> std::io::Result<()> {
        self.pgid.store(pid as i32, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }
}

#[cfg(not(windows))]
impl Drop for PtyJob {
    fn drop(&mut self) {
        let pgid = self.pgid.load(std::sync::atomic::Ordering::Relaxed);
        if pgid > 0 {
            // SAFETY: `killpg` takes a pgid + signal and has no memory effects.
            // A negative-or-zero pgid is excluded above; ESRCH (group already
            // gone — every member exited and was reaped) is the benign no-op
            // case, so we ignore the return value. SIGKILL (not SIGTERM) matches
            // the Windows job's unconditional kill-on-close and can't be trapped,
            // guaranteeing no surviving `claude`/`gh`/`git` descendants.
            unsafe { libc::killpg(pgid, libc::SIGKILL); }
        }
    }
}

/// Drain every active PTY session, killing each shell (which on Windows kills
/// its whole tree via the per-session Job Object that drops with the session).
/// Called from the Tauri `RunEvent::Exit` hook so closing the app reclaims its
/// orphan `bash` / `claude` / WebView children and releases the cwd locks they
/// hold on `~/.base-studio-code`.
pub(crate) fn kill_all_pty_sessions(state: &PtyState) {
    // Drain inside the lock, then kill outside — child.kill() can block (the
    // OS may take milliseconds per process), and we don't want to stall every
    // other PtyState consumer while shutdown rolls through N sessions.
    let drained: Vec<(String, PtySession)> = {
        let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
        map.drain().collect()
    };
    let n = drained.len();
    for (pane_id, mut session) in drained {
        if let Err(e) = session.child.kill() {
            log::warn!("pty[{pane_id}] exit-kill child failed: {e}");
        }
        // Dropping `session` runs `PtyJob::drop`, which closes the job handle
        // and tells the kernel to terminate every descendant still in the job.
    }
    // Clean exit: clear this instance's ledger entries (#1049) so the next boot has nothing to reap.
    crate::pty_ledger::forget_all_owned();
    log::info!("killed {n} PTY session(s) on exit");
}

/// The project hub's `plan.db` for a session whose cwd lives under a project hub
/// (`~/.base-studio-code/projects/<key>/...`), or None for a non-project session (#plan-db).
/// Workers run in `projects/<key>/.worktrees/...` and the director/planner in `projects/<key>/` —
/// both resolve to the same hub db, so the whole fleet shares one canonical plan store.
fn plan_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let projects_root = bsc_base_dir().join("projects");
    let rel = std::path::Path::new(cwd).strip_prefix(&projects_root).ok()?;
    let key = rel.components().next()?.as_os_str();
    Some(projects_root.join(key).join("plan.db"))
}

/// The absolute path of the `bsc-plan` CLI — the binary sitting beside the running app exe (the
/// cargo target dir in dev; a bundled sidecar in a release), or None if it isn't there (#plan-db).
/// Exposed to sessions as `$BSC_PLAN_BIN` for the `bsc-plan` shell helper to exec — no PATH change.
fn bsc_plan_bin_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "bsc-plan.exe" } else { "bsc-plan" };
    let p = std::env::current_exe().ok()?.with_file_name(exe);
    p.exists().then_some(p)
}

/// The absolute path of the `bsc-agent` runtime — the sidecar beside the running app exe (cargo
/// target dir in dev; bundled sidecar in a release), or None if absent. Exposed as `$BSC_AGENT_BIN`
/// for the `bsc-agent` shell helper to exec when a session runs on the bsc-agent harness (#1078 P3).
fn bsc_agent_bin_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "bsc-agent.exe" } else { "bsc-agent" };
    let p = std::env::current_exe().ok()?.with_file_name(exe);
    p.exists().then_some(p)
}

/// The absolute path of the bundled `bsc-research-mcp` server — the sidecar beside the running app
/// exe (cargo target dir in dev; bundled sidecar in a release), or None if absent (#1196). Used to
/// rewrite the Research server's `.mcp.json` command to the real binary path, since Claude Code
/// spawns `.mcp.json` commands directly (no PATH/shell-rc), unlike the `$BSC_*_BIN` shell helpers.
pub(crate) fn bsc_research_mcp_bin_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "bsc-research-mcp.exe" } else { "bsc-research-mcp" };
    let p = std::env::current_exe().ok()?.with_file_name(exe);
    p.exists().then_some(p)
}

/// The absolute path of the bundled `bsc-compliance-mcp` server — the sidecar beside the running app
/// exe (cargo target dir in dev; bundled sidecar in a release), or None if absent (#1005). Used to
/// rewrite the built-in Compliance server's `.mcp.json` command to the real binary path, since Claude
/// Code spawns `.mcp.json` commands directly (no PATH/shell-rc), like `bsc_research_mcp_bin_path`.
pub(crate) fn bsc_compliance_mcp_bin_path() -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { "bsc-compliance-mcp.exe" } else { "bsc-compliance-mcp" };
    let p = std::env::current_exe().ok()?.with_file_name(exe);
    p.exists().then_some(p)
}

/// Build the environment for a session shell.
///
/// The embedded xterm is a full xterm-256color terminal, but `TERM`/`COLORTERM`
/// were previously never set on the spawned shell — so `claude` (and other TUIs)
/// could fall back to a degraded terminal type, breaking inline features like the
/// ghost-text autocomplete and truecolor output. We advertise sensible defaults
/// here; caller-supplied vars (e.g. `GH_TOKEN`, or an explicit `TERM`) win.
pub(crate) fn session_env(caller: &HashMap<String, String>) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = vec![
        ("TERM".to_string(), "xterm-256color".to_string()),
        ("COLORTERM".to_string(), "truecolor".to_string()),
    ];
    for (k, v) in caller {
        if let Some(slot) = env.iter_mut().find(|(ek, _)| ek == k) {
            slot.1 = v.clone(); // caller overrides a default
        } else {
            env.push((k.clone(), v.clone()));
        }
    }
    env
}

/// What a session should auto-launch (#1240). Pure so the fresh-only intro suppression is testable
/// without a PTY or a harness.
#[derive(Debug, PartialEq)]
pub(crate) enum LaunchPlan {
    /// Bake the startup prompt as claude's initial message (`resume` ⇒ launch with `--continue`).
    Prompt { resume: bool },
    /// Run a literal init command (e.g. `claude --continue || claude`).
    Init(String),
    /// Nothing to auto-launch — a bare shell.
    None,
}

/// Decide what a session launches. A non-empty `startup_prompt` wins and is baked as claude's first
/// message — UNLESS it is `fresh_only` and a prior conversation exists, in which case a resumed
/// session must NOT be re-greeted (#1240): fall through to `init_cmd` (e.g. `claude --continue ||
/// claude`) so the user resumes quietly. `resume` (add `--continue`) holds only when the caller
/// opted in AND there's actually history to continue.
pub(crate) fn plan_launch(
    startup_prompt: Option<&str>,
    init_cmd: Option<&str>,
    has_history: bool,
    continue_session: bool,
    fresh_only: bool,
) -> LaunchPlan {
    let suppress = fresh_only && has_history;
    match startup_prompt.filter(|s| !s.is_empty() && !suppress) {
        Some(_) => LaunchPlan::Prompt { resume: continue_session && has_history },
        None => match init_cmd.filter(|s| !s.is_empty()) {
            Some(s) => LaunchPlan::Init(s.to_string()),
            None => LaunchPlan::None,
        },
    }
}

/// Returns `true` when a new session is created, `false` when reconnecting to
/// an existing one (e.g. after a tab switch). The caller should send `\n` on
/// reconnect so the shell re-displays its prompt in the fresh terminal.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn pty_create(
    pane_id: String,
    cols: u16,
    rows: u16,
    cwd: String,
    init_cmd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    startup_prompt: Option<String>,
    continue_session: Option<bool>,
    // A FRESH-ONLY startup prompt (#1240): deliver `startup_prompt` only when there's no prior
    // conversation for this cwd; on a resume, drop it and fall through to `init_cmd` so a returning
    // user isn't re-greeted. None/false ⇒ the prompt always fires (triage/fleet behavior).
    startup_prompt_fresh_only: Option<bool>,
    checkpoint_doc: Option<String>,
    model: Option<String>,
    // Console provider id (e.g. "claude", "gemini") — informational; logged so traces
    // identify which CLI is running. The frontend has already baked init_cmd from it.
    provider_id: Option<String>,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<bool, String> {
    // If a session already exists for this pane (e.g. user switched tabs and
    // switched back), reconnect rather than recreating.
    if state.0.lock().unwrap().contains_key(&pane_id) {
        log::info!("pty[{pane_id}] reconnect to existing session");
        return Ok(false);
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| { log::error!("pty[{pane_id}] openpty failed: {e}"); e.to_string() })?;

    // Honor the user's console-shell selection (#447); bash stays the default and
    // keeps the full bsc-* helper experience, PowerShell/cmd run degraded.
    let resolved_shell = crate::shell::resolve_interactive_shell();
    let shell = resolved_shell.program.clone();
    let mut cmd = CommandBuilder::new(&shell);

    // The session-harness adapter (#1078 P0/P3) — owns the launch + pre-launch host setup. Selected
    // from the console provider id: "bsc-agent" runs the model-agnostic runtime, everything else
    // (incl. None) keeps Claude Code, the default. Boxed so both impls share the call sites below.
    let harness: Box<dyn crate::harness::HarnessAdapter> = match provider_id.as_deref() {
        Some("bsc-agent") => Box::new(crate::harness::BscAgentAdapter),
        _ => Box::new(crate::harness::ClaudeCodeAdapter),
    };

    // Self-heal a corrupt ~/.claude.json before this session can launch claude.
    // The repair (drop trailing junk, keep the leading valid object) already runs
    // at workspace setup, but a session launched later (e.g. triage) would hit a
    // config corrupted in the meantime; claude aborts on invalid JSON. Mutex-
    // guarded + atomic, so it's safe alongside trust_claude_dir and concurrent
    // launches, and a no-op when the config is already valid.
    harness.prepare_config();

    // Hardening (#367): never silently fall back to $HOME when a session's configured
    // directory is missing — a failed clone/worktree or a stale persisted cwd would
    // otherwise have the agent quietly working in the wrong place. Detect the missing
    // dir, start in its nearest existing ancestor instead, and surface it loudly in the
    // pane (see cd_prefix below) so a misplaced session can't go unnoticed.
    // Normalize a git-bash drive path (`/c/Users/...`, as a bash shell reports via OSC-7 and the
    // app persists) back to native (`C:/Users/...`) so `is_dir` / `Command::cwd` resolve it on
    // Windows — otherwise an EXISTING worktree/dir reads as "missing" on restore (#979). No-op off
    // Windows and for already-native paths.
    let cwd = to_native_path(&cwd);
    let cwd_missing = !cwd.is_empty() && !std::path::Path::new(&cwd).is_dir();
    if cwd_missing {
        log::error!("pty[{pane_id}] configured cwd does not exist: {cwd} — refusing the silent home fallback");
    }
    let effective_cwd: String = if cwd_missing { nearest_existing_ancestor(&cwd) } else { cwd.clone() };
    if !effective_cwd.is_empty() {
        cmd.cwd(&effective_cwd);
        // Pre-accept Claude Code's folder-trust prompt for this directory so the
        // auto-launched `claude` starts already trusted instead of blocking on
        // the "Do you trust the files in this folder?" dialog.
        harness.trust_dir(&effective_cwd);
    }
    // Terminal-type defaults (so claude's TUI gets full xterm capabilities) plus
    // any caller-supplied environment (e.g. GH_TOKEN), which takes precedence.
    let env_map = env.unwrap_or_default();
    for (k, v) in session_env(&env_map) {
        cmd.env(k, v);
    }
    // Expose the triage checkpoint doc (resolved to an absolute, bash-style path)
    // so the `bsc-checkpoint` helper can write "where we left off" to it, and install
    // the helper itself. It must be reachable from the agent's OWN bash subprocesses:
    // Claude's Bash tool runs a non-interactive `bash -c`, a child that never saw the
    // interactive shell's functions, and the hyphenated name can't be `export -f`'d
    // (bash won't import non-identifier function names). So we drop the helper in a
    // stable rc file and point BASH_ENV at it — every non-interactive bash sources
    // BASH_ENV at startup — then source the same file in the interactive shell below.
    // Install the bsc-* shell helpers via an rc file pointed to by BASH_ENV (so the
    // agent's non-interactive `bash -c` subshells get them) and sourced into the
    // interactive shell below. The rc is universal — bsc-checkpoint (triage) and
    // bsc-note / bsc-blocked (fleet assume-and-log) cost nothing in sessions that
    // don't use them. Per-session doc paths the helpers read are exposed as env
    // vars when applicable; bsc-note/bsc-blocked default to a DECISIONS.md in cwd.
    let base = bsc_base_dir();
    let _ = std::fs::create_dir_all(&base);
    if let Some(rel) = checkpoint_doc.as_deref().filter(|s| !s.is_empty()) {
        let abs = base.join(rel);
        cmd.env("BSC_CHECKPOINT_DOC", to_bash_path(&abs.to_string_lossy()));
    }
    let rc = base.join("bsc-env.sh");
    let _ = std::fs::write(&rc, format!("{BSC_CHECKPOINT_RC}{BSC_DECISIONS_RC}{BSC_AUDIT_RC}{BSC_SKILL_RC}{BSC_HOOK_RC}{BSC_MCP_RC}{BSC_TOKENS_RC}{BSC_CONFINE_RC}{BSC_SCOPE_RC}{BSC_TAINT_RC}{BSC_COORD_EMIT_RC}{BSC_DEFER_RC}{BSC_FLEET_RC}{BSC_PLAN_RC}"));
    let rc_bash = to_bash_path(&rc.to_string_lossy());
    cmd.env("BASH_ENV", &rc_bash);
    // Agents audit log (#257): the `bsc-audit` PreToolUse hook (added to gated panes'
    // settings.json by the frontend) appends one redacted TSV line per tool attempt to
    // this app-wide log, tagged with the pane id. Set for every pane (harmless — only
    // panes whose settings install the hook actually write).
    cmd.env("BSC_AUDIT_LOG", to_bash_path(&base.join("audit.log").to_string_lossy()));
    cmd.env("BSC_AUDIT_PANE", &pane_id);
    // Skill usage log (#406): the `bsc-skill` Skill-tool hook (added to gated panes'
    // settings.json by the frontend) appends one TSV line per skill invocation to this
    // app-wide log, tagged with the pane id via BSC_AUDIT_PANE. Set for every pane
    // (harmless — only panes whose settings install the hook actually write).
    cmd.env("BSC_SKILL_LOG", to_bash_path(&base.join("skills.log").to_string_lossy()));
    // Hook-fire log (#867 follow-up): the `bsc-hook` wrapper around each USER hook (the
    // frontend wraps the command in toHookPayload) appends one TSV line per fire to this
    // app-wide log, for the Hook Analytics tab. Set for every pane (harmless — only panes
    // whose settings install wrapped user hooks write).
    cmd.env("BSC_HOOK_LOG", to_bash_path(&base.join("hooks.log").to_string_lossy()));
    // MCP-call log (#879 PR 2): the `bsc-mcp` PreToolUse+PostToolUse hook pair (added to gated
    // panes' settings.json by the frontend) appends one TSV line per MCP call — round-trip
    // latency + outcome — to this app-wide log, for the MCP Analytics tab. Set for every pane
    // (harmless — only panes whose settings install the hooks actually write).
    cmd.env("BSC_MCP_LOG", to_bash_path(&base.join("mcp.log").to_string_lossy()));
    // Token + cost accounting (#416): the `bsc-tokens` Stop/SubagentStop hook (added to
    // gated panes' settings.json by the frontend) pipes Claude Code's hook JSON — which
    // carries `session_id` + `transcript_path` — into this; it appends one TSV line
    // (`ts \t pane \t session_id \t transcript_path`) to this app-wide log, tagged with
    // the pane id via BSC_AUDIT_PANE. The transcript itself holds the per-message usage;
    // `read_token_usage` parses + prices it. Set for every pane (harmless — only panes
    // whose settings install the hook actually write). Claude Code hooks don't expose
    // token usage as a field, so the transcript is the only per-session source.
    cmd.env("BSC_TOKENS_LOG", to_bash_path(&base.join("tokens.log").to_string_lossy()));
    // Coordination log (#199): `bsc-blocked --on <ref>` appends a structured
    // blocked event here (tagged with the pane id via BSC_AUDIT_PANE); the director's
    // merge/close append satisfy events later. Set for every pane; only --on writes.
    cmd.env("BSC_COORD_LOG", to_bash_path(&base.join("coord.log").to_string_lossy()));
    // FS confinement (#158): the session's repo root (bash-style), against which the
    // `bsc-confine` hook (installed on gated panes) checks file-tool paths. The cwd is
    // the repo root. Set for every pane; only gated panes install the hook.
    if !cwd.is_empty() {
        cmd.env("BSC_REPO_ROOT", to_bash_path(&cwd));
    }
    // bsc-plan (#plan-db): point this session at its project's canonical plan store. Both vars feed
    // the `bsc-plan` shell helper (installed via the rc above, like every other bsc-*): $BSC_PLAN_DB
    // is the plan.db it reads/writes, $BSC_PLAN_BIN the absolute path of the CLI it execs — no PATH
    // changes, no copies. The DB is derived from the cwd — every project session runs under
    // `~/.base-studio-code/projects/<key>/...` (the director/planner at the hub, workers in a
    // worktree beneath it) — so the whole fleet shares one plan.db. Non-project sessions (a plain
    // console in some repo) get no BSC_PLAN_DB and never call bsc-plan.
    if let Some(db) = plan_db_for_cwd(&cwd) {
        cmd.env("BSC_PLAN_DB", to_bash_path(&db.to_string_lossy()));
    }
    if let Some(bin) = bsc_plan_bin_path() {
        cmd.env("BSC_PLAN_BIN", to_bash_path(&bin.to_string_lossy()));
    }
    // The bsc-agent runtime sidecar (#1078 P3) — the `bsc-agent` harness's shell helper execs it.
    if let Some(bin) = bsc_agent_bin_path() {
        cmd.env("BSC_AGENT_BIN", to_bash_path(&bin.to_string_lossy()));
    }
    // bsc-agent resume (#1144): hand the sidecar the per-cwd conversation file so it persists the
    // conversation (and, with --continue, resumes it). The app owns the keying; the sidecar just
    // reads/writes this native path via std::fs. Only meaningful for bsc-agent panes.
    if provider_id.as_deref() == Some("bsc-agent") {
        if let Some(p) = crate::bsc_agent_session_path(&cwd) {
            cmd.env("BSC_AGENT_SESSION", p.to_string_lossy().into_owned());
        }
    }

    let child = pair.slave.spawn_command(cmd)
        .map_err(|e| { log::error!("pty[{pane_id}] spawn '{shell}' failed: {e}"); e.to_string() })?;
    drop(pair.slave);

    // Box the shell into a Windows Job Object so killing the session also
    // terminates `claude` (and any `gh`/`git`/MCP child it spawns). Best-effort:
    // job/assign failures log and proceed with a None job — single-process kill
    // still works, we just lose tree-kill until the next launch.
    let job = match PtyJob::new() {
        Ok(j) => match child.process_id() {
            Some(pid) => match j.assign_pid(pid) {
                Ok(()) => Some(j),
                Err(e) => { log::warn!("pty[{pane_id}] assign shell {pid} to job failed: {e}"); None }
            },
            None => { log::warn!("pty[{pane_id}] shell pid unavailable; tree-kill disabled"); None }
        },
        Err(e) => { log::warn!("pty[{pane_id}] create job object failed: {e}"); None }
    };

    // Register the shell PID with the perf sampler so it can track this agent's
    // resource usage. Best-effort: if the PID is unavailable the sampler just
    // won't have a row for this pane (it already logged the warning above).
    if let Some(pid) = child.process_id() {
        app.state::<perf::PerfState>().register(&pane_id, pid);
        // Author this spawn in the crash-recovery ledger (#1049): if the app dies ungracefully
        // (skipping the Job Object's clean drop), the next boot reconciles the ledger and tree-kills
        // this orphan. Removed on a clean pty_kill / app exit.
        crate::pty_ledger::record(pid, &pane_id);
    }

    let mut writer = pair.master.take_writer()
        .map_err(|e| { log::error!("pty[{pane_id}] take_writer failed: {e}"); e.to_string() })?;
    let mut reader = pair.master.try_clone_reader()
        .map_err(|e| { log::error!("pty[{pane_id}] clone_reader failed: {e}"); e.to_string() })?;

    // Inject bash helpers into every new session.
    // Optional init_cmd is appended after the screen clear so callers can
    // auto-launch a process (e.g. "claude") inside the prepared shell.
    // A startup prompt (triage/console kickoff) is delivered the reliable way:
    // baked as claude's initial-message argument so claude submits it itself once
    // it's ready — no PTY-typing race against the animated TUI. ANSI-C ($'...')
    // quoting keeps arbitrary content (newlines, quotes, $, backticks) on a single
    // safe line and overrides any claude launch in init_cmd. With no prompt,
    // init_cmd runs as-is.
    // Only resume with `--continue` when Claude actually has a prior conversation
    // for this cwd; otherwise the CLI aborts ("No conversation found to continue")
    // and the baked startup prompt is dropped — so a fresh project would launch
    // into nothing. When there's no history we fall back to a fresh session, which
    // still delivers the prompt.
    // The session harness (#1078 P0): ClaudeCodeAdapter is the only impl today; it reproduces the
    // exact launch behavior this block had inline. bsc-agent becomes a second adapter (P2).
    let has_history = harness.detect_history(&cwd);
    let launch = match plan_launch(
        startup_prompt.as_deref(),
        init_cmd.as_deref(),
        has_history,
        continue_session.unwrap_or(false),
        startup_prompt_fresh_only.unwrap_or(false),
    ) {
        LaunchPlan::Prompt { resume } => Some(harness.launch_command(startup_prompt.as_deref().unwrap_or(""), resume)),
        LaunchPlan::Init(s) => Some(s),
        LaunchPlan::None => None,
    };
    // Whether the launch would start `claude` — the only command the degraded
    // non-bash path replays (an arbitrary bash init_cmd would be invalid there).
    let launch_claude = launch.as_deref().map(|s| harness.is_harness_launch(s)).unwrap_or(false);
    // The default `--model` alias for this session (per-pane override or global
    // default, mapped from the UI model id). None ⇒ the harness's own default.
    let model_alias = model.as_deref().and_then(|m| harness.model_flag(m));
    // The `claude()` shell wrapper: it emits the run/idle OSC markers AND injects the
    // session's default model, so BOTH the auto-launch below and anything the user
    // types pick it up. Skip the injection when the call already carries `--model`
    // (whole-word match, so prompt text containing the string can't trip it).
    let claude_fn = harness.shell_fn(model_alias.as_deref());
    let init_line = match resolved_shell.kind {
        crate::shell::ShellKind::Bash => {
            let init_suffix = launch.map(|s| format!("; {}", s)).unwrap_or_default();
            // Explicit cd after .bashrc runs so any `cd ~` in .bashrc doesn't win.
            // Uses a bash-compatible POSIX path so Git Bash on Windows handles it.
            let cd_prefix = if cwd.is_empty() {
                String::new()
            } else if cwd_missing {
                // Loud, visible warning instead of a silent home fallback, then sit in the
                // nearest existing ancestor (not $HOME) so the agent is at least near the project.
                format!(
                    "printf '\\033[1;31m[bsc] WARNING: configured directory %s does not exist; this session did NOT start in its project directory.\\033[0m\\n' \"{disp}\"; cd \"{anc}\" 2>/dev/null; ",
                    disp = to_bash_path(&cwd), anc = to_bash_path(&effective_cwd),
                )
            } else {
                format!("cd \"{}\" 2>/dev/null; ", to_bash_path(&cwd))
            };
            // Source the checkpoint helper into the interactive shell too: BASH_ENV only
            // covers non-interactive subshells (the agent's Bash tool), so a human typing
            // `bsc-checkpoint` in the console pane would otherwise not have it.
            let helpers_src = format!("source \"{}\" 2>/dev/null; ", rc_bash);
            format!(
                "{cd_prefix}__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
                 __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
                 {claude_fn}\
                 {helpers_src}\
                 PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}__bsc_osc7; __bsc_state idle\"; \
                 __bsc_osc7; __bsc_state idle; printf '\\033[2J\\033[H'{init_suffix}\n"
            )
        }
        // PowerShell / cmd: bsc-* helpers, OSC7/state markers, and startup-prompt baking
        // are bash-only, so run a degraded init that cd's, clears, and prints a visible
        // notice (no silent breakage, #447).
        crate::shell::ShellKind::PowerShell | crate::shell::ShellKind::Cmd => {
            crate::shell::non_bash_init(resolved_shell.kind, &cwd, cwd_missing, &effective_cwd, launch_claude, model_alias.as_deref())
        }
    };
    writer.write_all(init_line.as_bytes()).ok();

    // Stream PTY output to the frontend, COALESCED to ~one event per frame.
    //
    // A reader thread decodes bytes and forwards complete UTF-8 chunks over a
    // channel; an emitter thread batches them and emits at most once per ~16ms.
    // With many sessions streaming at once, emitting per read floods the Tauri
    // IPC boundary and the main thread (xterm writes) — the dominant source of
    // UI lag. Batching collapses that to one event per frame per session.
    //
    // The `leftover` buffer holds any trailing incomplete multi-byte sequence
    // (e.g. ✓, →, box-drawing) so we never split a character across reads.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let pane_id_rd = pane_id.clone();
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { log::info!("pty[{pane_id_rd}] reader EOF"); break; }
                Err(e) => { log::warn!("pty[{pane_id_rd}] reader error: {e}"); break; }
                Ok(n) => {
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

    let pane_id_em = pane_id.clone();
    let app_em = app.clone();
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::{Duration, Instant};
        const FLUSH: Duration = Duration::from_millis(16);
        const MAX_PENDING: usize = 64 * 1024;
        let evt = format!("pty_data_{}", pane_id_em);
        // Tee PTY output to the mobile tunnel (#242) when a client is connected.
        // Looked up once; `broadcast_output` is a no-op while nobody is paired.
        let tunnel_state = app_em.try_state::<tunnel::TunnelState>();
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
                    ts.broadcast_output(&pane_id_em, &data);
                }
                let _ = app_em.emit(&evt, data);
                win_emits += 1;
                last_emit = Instant::now();
            }
            let secs = win_start.elapsed().as_secs_f64();
            if secs >= 2.0 {
                let eps = win_emits as f64 / secs;
                let bps = win_bytes as f64 / secs;
                if eps > 60.0 || bps > 128_000.0 {
                    log::warn!("pty[{pane_id_em}] high output: {eps:.0} emits/s, {bps:.0} B/s");
                }
                win_start = Instant::now();
                win_bytes = 0;
                win_emits = 0;
            }
        }
        let _ = app_em.emit(&format!("pty_exit_{}", pane_id_em), ());
        log::info!("pty[{pane_id_em}] session ended ({total} bytes)");
    });

    log::info!(
        "pty[{}] created · {}x{} · provider={} · shell={} · cwd={} · init={}",
        pane_id, cols, rows,
        provider_id.as_deref().unwrap_or("claude"),
        shell,
        if cwd.is_empty() { "<none>" } else { cwd.as_str() },
        init_cmd.as_deref().filter(|s| !s.is_empty()).unwrap_or("<none>"),
    );

    // Tell the mobile tunnel this pane's grid size so it renders at the desktop width
    // (before pane_id is moved into the session map).
    tunnel_set_pane_size(&app, &pane_id, cols, rows);

    let active = {
        let mut map = state.0.lock().unwrap();
        map.insert(pane_id, PtySession { writer, master: pair.master, child, _job: job });
        map.len()
    };
    // Concurrency is the dominant memory driver — each session is a claude (node)
    // process + a terminal. Surface it so a 4×4 triage's footprint is visible.
    log::info!("pty: {active} active session(s)");
    if active >= 12 {
        log::warn!("pty: {active} concurrent sessions — high memory pressure (each spawns a claude process + terminal)");
    }
    Ok(true)
}

#[tauri::command]
pub(crate) async fn pty_write(
    pane_id: String,
    data: String,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let mut sessions = state.0.lock().unwrap();
    match sessions.get_mut(&pane_id) {
        Some(s) => s.writer.write_all(data.as_bytes())
            .map_err(|e| { log::error!("pty[{pane_id}] write failed: {e}"); e.to_string() })?,
        // Can happen during teardown races; the bytes are simply dropped.
        None => log::debug!("pty[{pane_id}] write to missing session ({} bytes dropped)", data.len()),
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn pty_broadcast(
    pane_ids: Vec<String>,
    data: String,
    state: State<'_, PtyState>,
) {
    let mut sessions = state.0.lock().unwrap();
    let mut hit = 0usize;
    for id in &pane_ids {
        if let Some(s) = sessions.get_mut(id) {
            match s.writer.write_all(data.as_bytes()) {
                Ok(_)  => hit += 1,
                Err(e) => log::warn!("pty[{id}] broadcast write failed: {e}"),
            }
        }
    }
    log::debug!("pty broadcast → {hit}/{} panes", pane_ids.len());
}

#[tauri::command]
pub(crate) async fn pty_resize(
    pane_id: String,
    cols: u16,
    rows: u16,
    app: AppHandle,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    {
        let sessions = state.0.lock().unwrap();
        if let Some(s) = sessions.get(&pane_id) {
            s.master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| { log::warn!("pty[{pane_id}] resize to {cols}x{rows} failed: {e}"); e.to_string() })?;
        }
    }
    // Mirror the new grid size to any paired phone so it re-fits to the desktop width.
    tunnel_set_pane_size(&app, &pane_id, cols, rows);
    Ok(())
}

#[tauri::command]
pub(crate) async fn pty_kill(
    pane_id: String,
    state: State<'_, PtyState>,
    perf_state: State<'_, perf::PerfState>,
) -> Result<(), String> {
    // Remove from perf tracker before killing the process.
    perf_state.unregister(&pane_id);
    // Drop the ledger entry (#1049) — a clean kill means there's nothing for the next boot to reap.
    crate::pty_ledger::forget_pane(&pane_id);
    let session = state.0.lock().unwrap().remove(&pane_id);
    match session {
        Some(mut s) => {
            // Belt-and-suspenders: ask the shell to terminate, then let the
            // session drop. On Windows the drop closes the per-session Job
            // Object, which kills any descendant (`claude`, `gh`, `git`, MCP
            // children) that survived the shell — the actual orphan-leak fix.
            if let Err(e) = s.child.kill() {
                log::warn!("pty[{pane_id}] child kill failed: {e}");
            }
            log::info!("pty[{pane_id}] kill");
        }
        None => log::info!("pty[{pane_id}] kill (no-op; session absent)"),
    }
    Ok(())
}

// ── Tunnel ⇄ PTY bridge (#242b) ─────────────────────────────────────────────────

/// Write mobile keystrokes into a pane's PTY. Called from the tunnel's relay client
/// task (`tunnel.rs`); keeps `PtyState`/`PtySession` private to this module. Missing
/// panes are silently dropped (teardown race), matching `pty_write`.
pub(crate) fn tunnel_write_pty(app: &AppHandle, pane_id: &str, data: &str) {
    use std::io::Write;
    let state = app.state::<PtyState>();
    let mut sessions = state.0.lock().unwrap();
    match sessions.get_mut(pane_id) {
        Some(s) => match s.writer.write_all(data.as_bytes()) {
            // Confirms mobile keystrokes reached the PTY (debug-level; enable to trace).
            Ok(()) => log::debug!("tunnel: pane[{pane_id}] input {} byte(s) written", data.len()),
            Err(e) => log::warn!("tunnel: pane[{pane_id}] write failed: {e}"),
        },
        // The #1 silent failure: mobile sent a pane id with no live PTY (wrong/stale id,
        // or a pane that isn't running). Warn so it surfaces without debug logging.
        None => log::warn!(
            "tunnel: input for unmatched pane '{pane_id}' ({} byte(s) dropped) — mobile sent a pane id with no live PTY",
            data.len()
        ),
    }
}

/// Resize a pane's PTY from a mobile client. No-op for a missing pane.
pub(crate) fn tunnel_resize_pty(app: &AppHandle, pane_id: &str, cols: u16, rows: u16) {
    {
        let state = app.state::<PtyState>();
        let sessions = state.0.lock().unwrap();
        if let Some(s) = sessions.get(pane_id) {
            let _ = s
                .master
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        }
    }
    // Keep the broadcast size in sync so all viewers agree on the current grid.
    tunnel_set_pane_size(app, pane_id, cols, rows);
}

/// Record + broadcast a pane's PTY grid size to the mobile tunnel so it can render at
/// the same width as the desktop (the byte stream's wrapping + cursor moves are baked
/// for this size). No-op when the tunnel state isn't present (#…).
pub(crate) fn tunnel_set_pane_size(app: &AppHandle, pane_id: &str, cols: u16, rows: u16) {
    if let Some(ts) = app.try_state::<tunnel::TunnelState>() {
        ts.set_pane_size(pane_id, cols, rows);
    }
}

#[cfg(test)]
mod tests {
    use super::session_env;
    use super::plan_db_for_cwd;
    use super::{plan_launch, LaunchPlan};

    const INIT: &str = "claude --continue 2>/dev/null || claude";

    #[test]
    fn plan_launch_fresh_only_fires_the_prompt_when_there_is_no_history() {
        // #1240 planner intro: fresh session (no prior conversation) ⇒ bake the intro, no --continue.
        assert_eq!(
            plan_launch(Some("intro"), Some(INIT), false, false, true),
            LaunchPlan::Prompt { resume: false },
        );
    }

    #[test]
    fn plan_launch_fresh_only_is_suppressed_on_resume_and_falls_to_init() {
        // History exists ⇒ a returning user must NOT be re-greeted; fall to init_cmd (resume quietly).
        assert_eq!(
            plan_launch(Some("intro"), Some(INIT), true, false, true),
            LaunchPlan::Init(INIT.to_string()),
        );
    }

    #[test]
    fn plan_launch_non_fresh_only_prompt_always_fires() {
        // Triage/fleet (fresh_only = false): the prompt fires regardless of history, with --continue
        // when the caller opted into continuation and there's history to continue.
        assert_eq!(
            plan_launch(Some("triage"), Some(INIT), true, true, false),
            LaunchPlan::Prompt { resume: true },
        );
        assert_eq!(
            plan_launch(Some("triage"), Some(INIT), false, true, false),
            LaunchPlan::Prompt { resume: false },
        );
    }

    #[test]
    fn plan_launch_no_prompt_uses_init_then_bare_shell() {
        assert_eq!(plan_launch(None, Some(INIT), true, false, false), LaunchPlan::Init(INIT.to_string()));
        assert_eq!(plan_launch(Some(""), None, false, false, true), LaunchPlan::None);
    }
    use crate::bsc_base_dir;
    #[cfg(any(windows, unix))]
    use super::PtyJob;
    use std::collections::HashMap;

    /// Loadbearing claim of the orphan-kill fix: dropping the job handle kills
    /// every assigned process (and its descendants). Spawn a ~30 s `ping` —
    /// without the kill we'd hit the deadline; with it the process exits in
    /// milliseconds. Windows-only; the Unix tree-kill is covered by
    /// `pty_job_drop_kills_process_group` below.
    #[cfg(windows)]
    #[test]
    fn pty_job_drop_kills_assigned_process() {
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        let mut child = Command::new("cmd")
            .args(["/c", "ping", "-n", "30", "127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn ping for job-kill test");

        let job = PtyJob::new().expect("create job object");
        job.assign_pid(child.id()).expect("assign ping pid to job");

        // Closing the only handle on a KILL_ON_JOB_CLOSE job must terminate
        // every assigned process — that's the orphan kill.
        drop(job);

        let mut exited = false;
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => {
                    exited = true;
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
        // Always reap before asserting so the test never leaks a Child handle
        // (satisfies clippy::zombie_processes); kill() is a harmless no-op once
        // the job already terminated it.
        let _ = child.kill();
        let _ = child.wait();
        assert!(
            exited,
            "ping survived 2s after job drop — kill-on-close not effective"
        );
    }

    /// Loadbearing claim of the Unix orphan-kill fix (#118): dropping the job
    /// must reap the shell's WHOLE process group, not just the immediate child —
    /// otherwise `claude`/`gh`/`git` grandchildren leak and hold cwd locks. Mimic
    /// the real spawn: a shell that `setsid`s (so pgid == its pid, exactly what
    /// `portable_pty` does) and backgrounds a 30 s `sleep` GRANDCHILD in that same
    /// group. After `assign_pid` + drop, the grandchild — which `Child::kill()`
    /// alone would never reach — must be gone well inside its 30 s sleep.
    #[cfg(unix)]
    #[test]
    fn pty_job_drop_kills_process_group() {
        use std::io::{BufRead, BufReader};
        use std::os::unix::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        // `echo $!` prints the backgrounded sleep's pid (the grandchild), then the
        // shell `wait`s so it stays group leader while we operate on the group.
        let mut child = {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30 & echo $!; wait"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            // SAFETY: pre_exec runs in the forked child before exec; `setsid` only
            // creates a new session/process group and has no async-signal-unsafe
            // allocation. This reproduces portable_pty's child setup so pgid == pid.
            unsafe {
                c.pre_exec(|| {
                    if libc::setsid() == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            c.spawn().expect("spawn sh for group-kill test")
        };

        let grandchild: i32 = {
            let stdout = child.stdout.take().expect("piped stdout");
            let mut line = String::new();
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read grandchild pid");
            line.trim().parse().expect("parse grandchild pid")
        };

        let job = PtyJob::new().expect("create job");
        job.assign_pid(child.id()).expect("assign shell pid to job");

        // Drop must `killpg(pgid, SIGKILL)` the whole group — shell AND the
        // backgrounded sleep grandchild.
        drop(job);
        // Reap the direct child so it doesn't linger as a zombie; the grandchild
        // is reparented to init, which reaps it once SIGKILL lands.
        let _ = child.wait();

        // SAFETY: `kill(pid, 0)` performs only an existence/permission check, no
        // signal delivery; returns 0 while the process exists (incl. zombie) and
        // -1/ESRCH once it's gone. Poll until the grandchild disappears.
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if unsafe { libc::kill(grandchild, 0) } == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        // Best-effort cleanup before failing so we don't leak a 30 s sleep.
        unsafe { libc::kill(grandchild, libc::SIGKILL); }
        panic!("grandchild {grandchild} survived job drop — process-group kill not effective");
    }

    #[test]
    fn session_env_sets_xterm_term_by_default() {
        // TERM/COLORTERM were previously unset on the spawned shell; default them
        // so claude's TUI (ghost-text autocomplete, truecolor) works.
        let env = session_env(&HashMap::new());
        assert!(env.iter().any(|(k, v)| k == "TERM" && v == "xterm-256color"));
        assert!(env.iter().any(|(k, v)| k == "COLORTERM" && v == "truecolor"));
    }

    #[test]
    fn session_env_lets_caller_override_term_and_appends_extras() {
        let mut caller = HashMap::new();
        caller.insert("TERM".to_string(), "screen-256color".to_string());
        caller.insert("GH_TOKEN".to_string(), "secret".to_string());
        let env = session_env(&caller);
        // caller TERM wins, with no duplicate entry
        assert_eq!(env.iter().filter(|(k, _)| k == "TERM").count(), 1);
        assert!(env.iter().any(|(k, v)| k == "TERM" && v == "screen-256color"));
        // unrelated caller vars still flow through
        assert!(env.iter().any(|(k, v)| k == "GH_TOKEN" && v == "secret"));
    }

    #[test]
    fn plan_db_for_cwd_resolves_the_hub_db_from_a_project_session() {
        let projects = bsc_base_dir().join("projects");
        // Director/planner at the hub root → projects/<key>/plan.db.
        let hub = projects.join("my-app");
        assert_eq!(plan_db_for_cwd(&hub.to_string_lossy()), Some(hub.join("plan.db")));
        // A worker in a worktree beneath the hub resolves to the SAME db.
        let wt = projects.join("my-app").join(".worktrees").join("web--auth");
        assert_eq!(plan_db_for_cwd(&wt.to_string_lossy()), Some(hub.join("plan.db")));
    }

    #[test]
    fn plan_db_for_cwd_is_none_outside_a_project_hub() {
        assert_eq!(plan_db_for_cwd(""), None);
        assert_eq!(plan_db_for_cwd(&bsc_base_dir().join("bin").to_string_lossy()), None);
        // A plain repo somewhere on disk is not a project session.
        let elsewhere = std::path::Path::new("C:/code/some-repo");
        assert_eq!(plan_db_for_cwd(&elsewhere.to_string_lossy()), None);
    }
}

