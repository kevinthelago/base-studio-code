use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

mod tunnel;

// ── PTY state ────────────────────────────────────────────────────────────────

struct PtySession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Windows Job Object that owns the shell + its descendants. Dropping it
    /// closes the handle, which (with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)
    /// terminates every still-running process in the tree — `claude`, any
    /// `gh`/`git`/MCP child, etc. `None` only when job creation failed at spawn
    /// time (logged; falls back to plain child kill, which leaves grandchildren
    /// orphaned). No-op stub on non-Windows builds (#118 covers Unix tree-kill).
    _job: Option<PtyJob>,
}

struct PtyState(Mutex<HashMap<String, PtySession>>);

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

#[cfg(not(windows))]
struct PtyJob;

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
    /// No-op stub: Unix tree-kill via process groups / `setsid` is tracked in
    /// #118 alongside per-OS PTY correctness.
    fn new() -> std::io::Result<Self> { Ok(Self) }
    #[allow(dead_code)]
    fn assign_pid(&self, _pid: u32) -> std::io::Result<()> { Ok(()) }
}

/// Drain every active PTY session, killing each shell (which on Windows kills
/// its whole tree via the per-session Job Object that drops with the session).
/// Called from the Tauri `RunEvent::Exit` hook so closing the app reclaims its
/// orphan `bash` / `claude` / WebView children and releases the cwd locks they
/// hold on `~/.base-studio-code`.
fn kill_all_pty_sessions(state: &PtyState) {
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
    log::info!("killed {n} PTY session(s) on exit");
}

// ── Logging / performance ────────────────────────────────────────────────────

/// ANSI color for a log level, used by the custom log format. Pure.
fn level_color(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "\x1b[31m", // red
        log::Level::Warn  => "\x1b[33m", // yellow
        log::Level::Info  => "\x1b[32m", // green
        log::Level::Debug => "\x1b[36m", // cyan
        log::Level::Trace => "\x1b[90m", // bright black
    }
}

/// RAII timer: logs how long a scope took when it drops, but only if the elapsed
/// time crosses `threshold_ms` — so it surfaces slow operations without noise.
/// Lives across `.await` points, so wrapping an async command times the whole call.
struct PerfSpan {
    label: &'static str,
    start: std::time::Instant,
    threshold_ms: u128,
}

impl PerfSpan {
    fn new(label: &'static str) -> Self {
        Self { label, start: std::time::Instant::now(), threshold_ms: 50 }
    }
}

impl Drop for PerfSpan {
    fn drop(&mut self) {
        let ms = self.start.elapsed().as_millis();
        if ms >= self.threshold_ms {
            log::info!("perf · {} took {}ms", self.label, ms);
        }
    }
}

// ── PTY commands ─────────────────────────────────────────────────────────────

/// Splits `bytes` at the last complete UTF-8 character boundary.
/// Returns `(valid_string, leftover_bytes)` where `leftover_bytes` is any
/// trailing incomplete multi-byte sequence to prepend to the next read.
fn split_utf8_at_boundary(bytes: &[u8]) -> (String, Vec<u8>) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(e) => {
            let valid_up_to = e.valid_up_to();
            if e.error_len().is_none() {
                // Incomplete sequence at end of buffer — hold the trailing
                // bytes for the next read rather than replacing with U+FFFD.
                let text = unsafe { std::str::from_utf8_unchecked(&bytes[..valid_up_to]) }.to_string();
                (text, bytes[valid_up_to..].to_vec())
            } else {
                // Genuinely invalid bytes mid-stream — keep going with lossy.
                (String::from_utf8_lossy(bytes).into_owned(), Vec::new())
            }
        }
    }
}

/// Converts a native OS path to a bash-compatible POSIX path.
/// On Windows (Git Bash): `C:\Users\foo` → `/c/Users/foo`.
/// On Unix: returns the path unchanged.
fn to_bash_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let s = p.replace('\\', "/");
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let drive = s[..1].to_lowercase();
            return format!("/{}{}", drive, &s[2..]);
        }
        s
    }
    #[cfg(not(windows))]
    p.to_string()
}

/// Root of the flat, reusable document library: `~/.base-studio-code/documents`.
/// Holds standalone markdown blocks (`*.md`) plus the library's own `CLAUDE.md`
/// and `.claude/settings.json`. These are reusable across every project — they
/// are referenced from a project's `kb_index.md` via a relative path.
fn documents_dir() -> std::path::PathBuf {
    bsc_base_dir().join("documents")
}

/// The project hub directory and the planner session's CWD:
/// `~/.base-studio-code/projects/<sanitized-project-key>`. Holds the project's
/// `CLAUDE.md` (ancestor-loaded context for repo sessions), plan sections
/// (`goal.md`…`risks.md`), control files, `prompts/`, and the cloned repos as
/// subdirectories.
fn project_dir(project_key: &str) -> std::path::PathBuf {
    bsc_base_dir()
        .join("projects")
        .join(sanitize_project_key(project_key))
}

/// The on-disk clone location of a repo within its project hub:
/// `projects/<sanitized-project-key>/<short-repo-name>`, where the short name is
/// the part of `owner/name` after the `/`. Each repo clone is a repo session's CWD.
fn repo_dir(project_key: &str, repo_full_name: &str) -> std::path::PathBuf {
    let short = repo_full_name.rsplit('/').next().unwrap_or(repo_full_name);
    project_dir(project_key).join(short)
}

/// Absolute on-disk location of a project's plan section files, which live FLAT
/// in the project hub: `~/.base-studio-code/projects/<sanitized-project-key>`.
/// Plan sections sit alongside the control files (CLAUDE.md, kb_index.md, …) in
/// the planner's CWD.
fn plan_dir_for(project_key: &str) -> std::path::PathBuf {
    project_dir(project_key)
}

/// Delete a project's on-disk hub (`projects/<sanitized-key>`) and everything in
/// it — plan sections, prompts, cloned repos. Best-effort: a missing dir is fine.
/// Refuses an empty key so it can never wipe the `projects/` root.
#[tauri::command]
fn delete_project_dir(project_key: String) -> Result<(), String> {
    if sanitize_project_key(&project_key).is_empty() {
        return Err("delete_project_dir: empty project_key".to_string());
    }
    let dir = project_dir(&project_key);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("delete_project_dir: {e}"))?;
        log::info!("deleted project hub {:?}", dir);
    }
    Ok(())
}

/// Quote an arbitrary string as a single bash ANSI-C token (`$'...'`).
///
/// Used to bake a startup prompt into `claude <token>` safely: ANSI-C quoting
/// keeps the whole value on one physical line (newlines become `\n`) and `$`,
/// backticks, and double quotes are literal — so no shell expansion, no PS2
/// continuation, and any prompt content survives intact.
fn bash_ansi_c_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    out.push_str("$'");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\'' => out.push_str("\\'"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('\'');
    out
}

/// Build the shell command that launches `claude` with the baked startup prompt.
/// Triage sessions pass `continue_session = true` to resume the repo's most recent
/// conversation (`--continue`) instead of starting a fresh one.
fn claude_launch(prompt: &str, continue_session: bool) -> String {
    let flag = if continue_session { "--continue " } else { "" };
    format!("claude {}{}", flag, bash_ansi_c_quote(prompt))
}

/// Claude Code's on-disk directory name for a launch cwd. Conversations live at
/// `~/.claude/projects/<dir>/<session>.jsonl`, where `<dir>` is the cwd with every
/// non-alphanumeric character replaced by `-`
/// (e.g. `C:\Users\Kevin\foo` → `C--Users-Kevin-foo`).
fn claude_project_dir_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// Whether Claude has a prior conversation for `cwd`. `--continue` aborts with
/// "No conversation found to continue" (and never delivers the baked startup
/// prompt) when there's no history, so we only pass the flag when this is true.
/// Fail-safe: any uncertainty (empty cwd, unreadable dir) returns `false`, which
/// launches a fresh session so the prompt is always delivered.
fn has_claude_history(cwd: &str) -> bool {
    if cwd.is_empty() {
        return false;
    }
    let dir = home_dir()
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(cwd));
    let Ok(entries) = std::fs::read_dir(&dir) else { return false };
    entries
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("jsonl"))
}

/// Resolve the shell to spawn for a session. The injected bash helpers
/// (OSC7/OSC100, the `claude()` wrapper, `PROMPT_COMMAND`) need a real bash.
///
/// On Windows a bare `"bash"` on PATH resolves to `C:\Windows\System32\bash.exe`
/// — the WSL launcher — which fails with `execvpe(/bin/bash)` when there's no WSL
/// distro (the production-build failure). So we honor an explicit `$SHELL`, then
/// locate Git Bash explicitly, and only then fall back to bare `"bash"`.
fn resolve_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            return s;
        }
    }
    #[cfg(windows)]
    if let Some(b) = find_git_bash() {
        return b;
    }
    "bash".to_string()
}

/// Locate Git Bash's `bash.exe` (never WSL's System32 stub) from known install
/// roots plus any Git dir derived from `git.exe` on PATH.
#[cfg(windows)]
fn find_git_bash() -> Option<String> {
    use std::path::PathBuf;
    let mut roots: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Ok(p) = std::env::var(var) {
            roots.push(PathBuf::from(p).join("Git"));
        }
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(p).join("Programs").join("Git"));
    }
    roots.push(PathBuf::from(r"C:\Program Files\Git"));
    // git.exe on PATH lives in <Git>\cmd or <Git>\bin — its parent is the Git root.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if dir.join("git.exe").exists() {
                if let Some(root) = dir.parent() {
                    roots.push(root.to_path_buf());
                }
            }
        }
    }
    bash_in_roots(&roots, &|p| p.exists())
}

/// First existing `bash.exe` under any root (checking `bin\` then `usr\bin\`).
/// The `exists` predicate is injected so the path logic is testable without a
/// real Git install.
#[cfg(windows)]
fn bash_in_roots(roots: &[std::path::PathBuf], exists: &dyn Fn(&std::path::Path) -> bool) -> Option<String> {
    for root in roots {
        let bin = root.join("bin").join("bash.exe");
        if exists(&bin) {
            return Some(bin.to_string_lossy().into_owned());
        }
        let usr = root.join("usr").join("bin").join("bash.exe");
        if exists(&usr) {
            return Some(usr.to_string_lossy().into_owned());
        }
    }
    None
}

/// Build the environment for a session shell.
///
/// The embedded xterm is a full xterm-256color terminal, but `TERM`/`COLORTERM`
/// were previously never set on the spawned shell — so `claude` (and other TUIs)
/// could fall back to a degraded terminal type, breaking inline features like the
/// ghost-text autocomplete and truecolor output. We advertise sensible defaults
/// here; caller-supplied vars (e.g. `GH_TOKEN`, or an explicit `TERM`) win.
fn session_env(caller: &HashMap<String, String>) -> Vec<(String, String)> {
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

/// Returns `true` when a new session is created, `false` when reconnecting to
/// an existing one (e.g. after a tab switch). The caller should send `\n` on
/// reconnect so the shell re-displays its prompt in the fresh terminal.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn pty_create(
    pane_id: String,
    cols: u16,
    rows: u16,
    cwd: String,
    init_cmd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    startup_prompt: Option<String>,
    continue_session: Option<bool>,
    checkpoint_doc: Option<String>,
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

    let shell = resolve_shell();
    let mut cmd = CommandBuilder::new(&shell);

    // Self-heal a corrupt ~/.claude.json before this session can launch claude.
    // The repair (drop trailing junk, keep the leading valid object) already runs
    // at workspace setup, but a session launched later (e.g. triage) would hit a
    // config corrupted in the meantime; claude aborts on invalid JSON. Mutex-
    // guarded + atomic, so it's safe alongside trust_claude_dir and concurrent
    // launches, and a no-op when the config is already valid.
    sanitize_claude_config();

    if !cwd.is_empty() {
        cmd.cwd(&cwd);
        // Pre-accept Claude Code's folder-trust prompt for this directory so the
        // auto-launched `claude` starts already trusted instead of blocking on
        // the "Do you trust the files in this folder?" dialog.
        trust_claude_dir(&cwd);
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
    let _ = std::fs::write(&rc, format!("{BSC_CHECKPOINT_RC}{BSC_DECISIONS_RC}{BSC_AUDIT_RC}{BSC_CONFINE_RC}{BSC_COORD_EMIT_RC}"));
    let rc_bash = to_bash_path(&rc.to_string_lossy());
    cmd.env("BASH_ENV", &rc_bash);
    // Agents audit log (#257): the `bsc-audit` PreToolUse hook (added to gated panes'
    // settings.json by the frontend) appends one redacted TSV line per tool attempt to
    // this app-wide log, tagged with the pane id. Set for every pane (harmless — only
    // panes whose settings install the hook actually write).
    cmd.env("BSC_AUDIT_LOG", to_bash_path(&base.join("audit.log").to_string_lossy()));
    cmd.env("BSC_AUDIT_PANE", &pane_id);
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
    let resume = continue_session.unwrap_or(false) && has_claude_history(&cwd);
    let launch = match startup_prompt.as_deref().filter(|s| !s.is_empty()) {
        Some(p) => Some(claude_launch(p, resume)),
        None => init_cmd.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string()),
    };
    let init_suffix = launch.map(|s| format!("; {}", s)).unwrap_or_default();
    // Explicit cd after .bashrc runs so any `cd ~` in .bashrc doesn't win.
    // Uses a bash-compatible POSIX path so Git Bash on Windows handles it.
    let cd_prefix = if !cwd.is_empty() {
        format!("cd \"{}\" 2>/dev/null; ", to_bash_path(&cwd))
    } else {
        String::new()
    };
    // Source the checkpoint helper into the interactive shell too: BASH_ENV only
    // covers non-interactive subshells (the agent's Bash tool), so a human typing
    // `bsc-checkpoint` in the console pane would otherwise not have it.
    let helpers_src = format!("source \"{}\" 2>/dev/null; ", rc_bash);
    let osc7 = format!(
        "{cd_prefix}__bsc_osc7() {{ printf $'\\033]7;file://localhost%s\\a' \"$(pwd)\"; }}; \
         __bsc_state() {{ printf $'\\033]100;%s\\a' \"$1\"; }}; \
         claude() {{ __bsc_state run; command claude \"$@\"; }}; \
         {helpers_src}\
         PROMPT_COMMAND=\"${{PROMPT_COMMAND:+$PROMPT_COMMAND; }}__bsc_osc7; __bsc_state idle\"; \
         __bsc_osc7; __bsc_state idle; printf '\\033[2J\\033[H'{init_suffix}\n"
    );
    writer.write_all(osc7.as_bytes()).ok();

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
        "pty[{}] created · {}x{} · shell={} · cwd={} · init={}",
        pane_id, cols, rows, shell,
        if cwd.is_empty() { "<none>" } else { cwd.as_str() },
        init_cmd.as_deref().filter(|s| !s.is_empty()).unwrap_or("<none>"),
    );

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
async fn pty_write(
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
fn pty_broadcast(
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
async fn pty_resize(
    pane_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = state.0.lock().unwrap();
    if let Some(s) = sessions.get(&pane_id) {
        s.master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| { log::warn!("pty[{pane_id}] resize to {cols}x{rows} failed: {e}"); e.to_string() })?;
    }
    Ok(())
}

#[tauri::command]
async fn pty_kill(pane_id: String, state: State<'_, PtyState>) -> Result<(), String> {
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
    if let Some(s) = sessions.get_mut(pane_id) {
        if let Err(e) = s.writer.write_all(data.as_bytes()) {
            log::warn!("tunnel: pty[{pane_id}] write failed: {e}");
        }
    }
}

/// Resize a pane's PTY from a mobile client. No-op for a missing pane.
pub(crate) fn tunnel_resize_pty(app: &AppHandle, pane_id: &str, cols: u16, rows: u16) {
    let state = app.state::<PtyState>();
    let sessions = state.0.lock().unwrap();
    if let Some(s) = sessions.get(pane_id) {
        let _ = s
            .master
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
    }
}

// ── File picker ───────────────────────────────────────────────────────────────

#[tauri::command]
async fn pick_directory() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| rfd::FileDialog::new().pick_folder())
        .await
        .ok()
        .flatten()
        .map(|p| p.to_string_lossy().into_owned())
}

// ── Claude API (knowledge store) ─────────────────────────────────────────────

#[tauri::command]
async fn kb_chat(
    messages: Vec<serde_json::Value>,
    system: String,
    tools: Vec<serde_json::Value>,
    api_key: String,
) -> Result<serde_json::Value, String> {
    if api_key.is_empty() {
        return Err("No API key configured. Add it in Settings → Integrations.".to_string());
    }
    let client = reqwest::Client::new();
    let body = serde_json::json!({
        "model": "claude-sonnet-4-6",
        "max_tokens": 4096,
        "system": system,
        "messages": messages,
        "tools": tools,
    });
    let response = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let err = json["error"]["message"]
            .as_str()
            .unwrap_or("Unknown error")
            .to_string();
        return Err(format!("API error ({}): {}", status, err));
    }
    Ok(json)
}

// ── GitHub proxy ──────────────────────────────────────────────────────────────

#[tauri::command]
async fn github_graphql(
    token: String,
    query: String,
    variables: Option<serde_json::Value>,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_graphql");
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let force = force.unwrap_or(false);
    // GraphQL has no ETag, so the cache is purely time-windowed (TTL): within
    // max_age serve the cached `data` with no network call; otherwise re-POST.
    // Keyed by query + variables. Reuses the REST cache map (etag stays None).
    let cache_key = format!(
        "graphql:{}|{}",
        query,
        variables.as_ref().map(|v| v.to_string()).unwrap_or_default(),
    );
    if !force {
        let cache = github_cache().lock().unwrap();
        if let Some(entry) = cache.get(&cache_key) {
            if cache_is_fresh(entry.fetched_at.elapsed(), max_age_secs, false) {
                return Ok(entry.body.clone());
            }
        }
    }

    let client = reqwest::Client::new();
    let mut body = serde_json::json!({ "query": query });
    if let Some(vars) = variables {
        body["variables"] = vars;
    }
    let response = client
        .post("https://api.github.com/graphql")
        .header("Authorization", format!("Bearer {}", token))
        .header("Content-Type", "application/json")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_graphql HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    if let Some(errors) = json.get("errors") {
        if errors.is_array() && !errors.as_array().unwrap().is_empty() {
            let msg = errors[0]["message"].as_str().unwrap_or("GraphQL error").to_string();
            log::warn!("github_graphql GraphQL error: {msg}");
            return Err(format!("GraphQL error: {}", msg));
        }
    }
    let data = json["data"].clone();
    github_cache().lock().unwrap().insert(
        cache_key,
        CachedGet { etag: None, body: data.clone(), fetched_at: std::time::Instant::now() },
    );
    Ok(data)
}

#[tauri::command]
async fn github_post(
    token: String,
    path: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_post");
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;
    let status = response.status();
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_post {path} HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    Ok(json)
}

// ── GitHub response cache (ETag-validated, in-memory) ──────────────────────────
//
// REST GETs are cached by endpoint path. On the next request we send the stored
// ETag as `If-None-Match`; GitHub answers `304 Not Modified` (cheap — it doesn't
// count against the primary rate limit) when nothing changed, and we serve the
// cached body. This makes the frontend's refetch-on-view nearly free while staying
// current. (GraphQL has no ETags — a separate TTL/version-probe pass covers it.)

struct CachedGet {
    etag: Option<String>,
    body: serde_json::Value,
    fetched_at: std::time::Instant,
}

fn github_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, CachedGet>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, CachedGet>>> =
        std::sync::OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Drop every cached GitHub response. Called when the token changes (connect /
/// disconnect / re-auth) so a new account never sees the previous one's bodies.
#[tauri::command]
fn github_cache_clear() {
    github_cache().lock().unwrap().clear();
}

/// Whether a cached entry of the given age can be served without even revalidating.
/// `force` always revalidates; with no `max_age_secs` we always revalidate (the
/// revalidation is a cheap conditional request, so the default is "revalidate-on-view").
fn cache_is_fresh(age: std::time::Duration, max_age_secs: Option<u64>, force: bool) -> bool {
    if force {
        return false;
    }
    match max_age_secs {
        Some(max) => age < std::time::Duration::from_secs(max),
        None => false,
    }
}

/// Fold a GET outcome into the cache and return the body to hand back. A 304
/// reuses the cached entry (timestamp refreshed); otherwise the fresh `body`
/// (with its `etag`) replaces the entry. Returns `None` only on a 304 with no
/// cached entry (shouldn't happen) or a non-304 with no body.
fn apply_github_response(
    cache: &mut std::collections::HashMap<String, CachedGet>,
    path: &str,
    not_modified: bool,
    etag: Option<String>,
    body: Option<serde_json::Value>,
) -> Option<serde_json::Value> {
    if not_modified {
        let entry = cache.get_mut(path)?;
        entry.fetched_at = std::time::Instant::now();
        return Some(entry.body.clone());
    }
    let b = body?;
    cache.insert(
        path.to_string(),
        CachedGet { etag, body: b.clone(), fetched_at: std::time::Instant::now() },
    );
    Some(b)
}

#[tauri::command]
async fn github_request(
    token: String,
    path: String,
    max_age_secs: Option<u64>,
    force: Option<bool>,
) -> Result<serde_json::Value, String> {
    let _perf = PerfSpan::new("github_request");
    if token.is_empty() {
        return Err("No GitHub token provided.".to_string());
    }
    let force = force.unwrap_or(false);

    // Within max_age: serve the cached body with no network call. Otherwise grab
    // the stored ETag so we can revalidate cheaply via If-None-Match.
    let cached_etag = {
        let cache = github_cache().lock().unwrap();
        match cache.get(&path) {
            Some(entry) if cache_is_fresh(entry.fetched_at.elapsed(), max_age_secs, force) => {
                return Ok(entry.body.clone());
            }
            Some(entry) if !force => entry.etag.clone(),
            _ => None,
        }
    };

    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/{}", path);
    let mut req = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", token))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "base-studio-code/0.2.0");
    if let Some(etag) = &cached_etag {
        req = req.header("If-None-Match", etag.clone());
    }
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            // Offline / transient: serve the last good body if we have one.
            if let Some(entry) = github_cache().lock().unwrap().get(&path) {
                log::warn!("github_request {path} request failed ({e}); serving cached body");
                return Ok(entry.body.clone());
            }
            return Err(format!("Request failed: {}", e));
        }
    };
    let status = response.status();

    // 304 Not Modified → the cached body is still current.
    if status == reqwest::StatusCode::NOT_MODIFIED {
        let mut cache = github_cache().lock().unwrap();
        return apply_github_response(&mut cache, &path, true, None, None)
            .ok_or_else(|| "GitHub returned 304 but no cached body is available".to_string());
    }

    // Capture the ETag before the body consumes the response.
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse response: {}", e))?;
    if !status.is_success() {
        let msg = json["message"].as_str().unwrap_or("Unknown error").to_string();
        log::warn!("github_request {path} HTTP {status}: {msg}");
        return Err(format!("GitHub API error ({}): {}", status, msg));
    }
    let mut cache = github_cache().lock().unwrap();
    apply_github_response(&mut cache, &path, false, etag, Some(json.clone()));
    Ok(json)
}

// ── Workspaces ───────────────────────────────────────────────────────────────
//
// Two roots under ~/.base-studio-code/:
//   documents/        — flat reusable markdown library; claude can Read/Write .md
//   projects/<key>/   — project hub + planner session CWD; references reusable
//                       blocks at ../../documents/{id}.md
//
// Each gets a .claude/settings.json (tool restrictions) and a CLAUDE.md
// (auto-loaded system prompt) written on every session start so the instructions
// stay in sync with the app without manual editing.

fn home_dir() -> std::path::PathBuf {
    let home = if cfg!(windows) {
        std::env::var("USERPROFILE")
            .unwrap_or_else(|_| std::env::var("HOME").unwrap_or_default())
    } else {
        std::env::var("HOME").unwrap_or_default()
    };
    std::path::PathBuf::from(home)
}

fn bsc_base_dir() -> std::path::PathBuf {
    home_dir().join(".base-studio-code")
}

/// The `bsc-checkpoint` helper: reads stdin and overwrites the per-repo checkpoint
/// doc named by `$BSC_CHECKPOINT_DOC` (creating its parent dir). Installed via an rc
/// file + `BASH_ENV` so it's reachable from the agent's non-interactive `bash -c`
/// subshells, not just the interactive PTY shell. The hyphenated name can't be
/// `export -f`'d — bash refuses to import functions whose names aren't valid
/// identifiers (post-Shellshock) — so it must be *defined* in each subshell.
const BSC_CHECKPOINT_RC: &str =
    "bsc-checkpoint() { mkdir -p \"$(dirname \"$BSC_CHECKPOINT_DOC\")\" 2>/dev/null; cat > \"$BSC_CHECKPOINT_DOC\"; }\n";

/// The `bsc-note` / `bsc-blocked` helpers: append a one-line entry read from stdin
/// to the assume-and-log journal named by `$BSC_DECISIONS_DOC` (default: a
/// `DECISIONS.md` in the session's cwd, creating its parent dir). Fleet workers use
/// these to record a reversible decision (note) or a genuine stop (blocked) and keep
/// moving instead of stalling on a human. Same rc + `BASH_ENV` install path as
/// bsc-checkpoint, so the agent's non-interactive Bash subshells can call them.
const BSC_DECISIONS_RC: &str = concat!(
    // `printf '%s' '- '` (not `printf '- '`): a format starting with `-` is parsed as
    // an option flag and the prefix is silently dropped.
    "bsc-note() { d=\"${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}\"; mkdir -p \"$(dirname \"$d\")\" 2>/dev/null; { printf '%s' '- '; cat; printf '\\n'; } >> \"$d\"; }\n",
    // bsc-blocked also accepts `--on <ref[,ref]>` (+ optional `--checkpoint <ref>`):
    // when present it appends a structured `blocked` event to $BSC_COORD_LOG (#199),
    // tagged with the pane id, alongside the human note. No --on => note only.
    r#"bsc-blocked() { on=""; cp=""; while [ $# -gt 0 ]; do case "$1" in --on) on="$2"; shift 2 ;; --checkpoint) cp="$2"; shift 2 ;; *) shift ;; esac; done; d="${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}"; mkdir -p "$(dirname "$d")" 2>/dev/null; m="$(cat)"; { printf '%s' '- BLOCKED: '; printf '%s' "$m"; [ -n "$on" ] && printf '%s' " (on $on)"; printf '\n'; } >> "$d"; l="${BSC_COORD_LOG:-}"; if [ -n "$on" ] && [ -n "$l" ]; then ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\tblocked\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$on" "$cp" >> "$l"; fi; }"#,
    "\n",
);

/// The `bsc-audit` helper (#257): the PreToolUse hook on a gated pane pipes Claude
/// Code's tool JSON into this; it extracts ONLY the tool name + a short target field
/// (never `content`/`new_string`, so file contents / secrets aren't written) and
/// appends one TAB-separated line — `ts \t pane \t toolName \t target` — to the
/// app-wide `$BSC_AUDIT_LOG`, tagged with `$BSC_AUDIT_PANE`. Best-effort + always exits
/// 0 so it never blocks a tool. A raw string keeps the embedded quotes/regex readable.
const BSC_AUDIT_RC: &str = concat!(
    r#"bsc-audit() { l="${BSC_AUDIT_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat)"; tn="$(printf '%s' "$j" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; tg="$(printf '%s' "$j" | grep -oE '"(command|file_path|notebook_path|url|query|pattern|path|description)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | tr '\t\n' '  ' | cut -c1-160)"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$tn" "$tg" >> "$l"; return 0; }"#,
    "\n",
);

/// The `bsc-confine` helper (#158): a PreToolUse hook for the file tools on a gated
/// pane. It reads Claude Code's tool JSON, extracts the target `file_path` /
/// `notebook_path`, and BLOCKS (return 2 + stderr) when the path escapes the session's
/// repo root (`$BSC_REPO_ROOT`) — any `..` segment, or an absolute path not under the
/// root. Mirrors `src/lib/fsConfine.ts` (the unit-tested decision). String-based + no
/// realpath so it's portable; `return 2` (not `exit`) so it never kills a shell that
/// sources it. Covers the AI's file tools only — Bash needs OS-level sandboxing.
const BSC_CONFINE_RC: &str = concat!(
    r#"bsc-confine() { local root="${BSC_REPO_ROOT:-}"; [ -z "$root" ] && return 0; local j fp; j="$(cat)"; fp="$(printf '%s' "$j" | grep -oE '"(file_path|notebook_path)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; [ -z "$fp" ] && return 0; fp="${fp//\\//}"; case "$fp" in ..|../*|*/../*|*/..) echo "blocked: '$fp' leaves the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac; case "$fp" in /*|~*|[A-Za-z]:*) case "$fp" in "$root"|"$root"/*) return 0 ;; *) echo "blocked: '$fp' is outside the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac ;; esac; return 0; }"#,
    "\n",
);

/// Satisfy / failure emitters for $BSC_COORD_LOG (#199): the director (or a producer
/// session) marks a dependency done (landed/merged/closed) or failed so parked
/// waiters can be woken. One TSV line per call, tagged with the pane id -- symmetric
/// to `bsc-blocked --on`. Quote `#`-refs (`bsc-merged '#42'`) so the shell doesn't
/// treat them as comments; a bare number works too. `bsc-failed` reads the reason
/// from stdin. A real newline separates each function inside the raw string.
const BSC_COORD_EMIT_RC: &str = r#"__bsc_coord() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; mkdir -p "$(dirname "$l")" 2>/dev/null; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf '%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" "$2" "$3" >> "$l"; }
bsc-landed() { __bsc_coord landed "$1" ""; }
bsc-merged() { __bsc_coord merged "$1" ""; }
bsc-closed() { __bsc_coord closed "$1" ""; }
bsc-failed() { r="$(cat)"; __bsc_coord failed "$1" "$r"; }
bsc-wait() { r="$(cat)"; __bsc_coord waiting "$r" "${BSC_CHECKPOINT_DOC:-}"; }
"#;

/// Read the Agents audit log (#257): the newest `limit` TSV lines, newest first.
#[tauri::command]
fn read_audit_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("audit.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    lines.reverse();
    lines.truncate(limit);
    lines
}

/// Read the coordination log (#199): up to the newest `limit` TSV lines, in
/// chronological (oldest-first) order so the coordinator can replay them.
#[tauri::command]
fn read_coord_log(limit: usize) -> Vec<String> {
    let path = bsc_base_dir().join("coord.log");
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = text.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect();
    if lines.len() > limit {
        lines = lines.split_off(lines.len() - limit);
    }
    lines
}

/// Append a `woke` event to the coordination log (#199): records that a parked
/// session was relaunched, so the coordinator won't re-wake it (idempotent across
/// polls + restarts). Same TSV shape + ISO-8601 UTC timestamp as the shell emitters.
#[tauri::command]
fn append_coord_woke(session: String) -> Result<(), String> {
    use std::io::Write;
    let path = bsc_base_dir().join("coord.log");
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let fmt = time::macros::format_description!(
        "[year]-[month]-[day]T[hour]:[minute]:[second]Z"
    );
    let ts = time::OffsetDateTime::now_utc().format(&fmt).unwrap_or_default();
    let line = format!("{ts}	{session}	woke		
");
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

// ── Git hooks (#265) ────────────────────────────────────────────────────────────

/// One git hook in a repo. `active` = the hook file is present (a `.sample` doesn't
/// count). `source` is where the hooks live (the default `.git/hooks` or a
/// `core.hooksPath` like `.githooks`). `preview` is the first meaningful line.
#[derive(serde::Serialize)]
struct GitHook {
    name: String,
    active: bool,
    source: String,
    preview: String,
}

/// The standard git hooks we surface, in rough lifecycle order.
const GIT_HOOK_NAMES: &[&str] = &[
    "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
    "pre-rebase", "post-checkout", "post-merge", "pre-push", "post-rewrite",
];

/// Extract `hooksPath` from a `.git/config` body (git honors it under `[core]`; we
/// accept it wherever it appears — close enough and avoids a full INI parser).
fn parse_hooks_path(cfg: &str) -> Option<String> {
    for line in cfg.lines() {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("hooksPath") {
            let v = rest.trim_start_matches(|c: char| c == '=' || c.is_whitespace()).trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// First non-shebang, non-comment, non-blank line of a hook script (truncated).
fn hook_preview(path: &std::path::Path) -> String {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    for line in content.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with("#!") || l.starts_with('#') {
            continue;
        }
        return l.chars().take(120).collect();
    }
    String::new()
}

/// Read a repo's git hooks. Honors `core.hooksPath`, else `.git/hooks`. Returns the
/// standard hooks with whether each is active + a one-line preview. Best-effort: a path
/// without a `.git` directory yields an empty list (e.g. not cloned).
#[tauri::command]
fn read_git_hooks(repo_path: String) -> Vec<GitHook> {
    let root = std::path::PathBuf::from(&repo_path);
    let git_dir = root.join(".git");
    if !git_dir.is_dir() {
        return Vec::new();
    }
    let (hooks_dir, source) = std::fs::read_to_string(git_dir.join("config"))
        .ok()
        .and_then(|cfg| parse_hooks_path(&cfg))
        .map(|hp| {
            let p = if std::path::Path::new(&hp).is_absolute() {
                std::path::PathBuf::from(&hp)
            } else {
                root.join(&hp)
            };
            (p, hp)
        })
        .unwrap_or_else(|| (git_dir.join("hooks"), ".git/hooks".to_string()));

    GIT_HOOK_NAMES
        .iter()
        .map(|name| {
            let path = hooks_dir.join(name);
            let active = path.is_file();
            let preview = if active { hook_preview(&path) } else { String::new() };
            GitHook { name: (*name).to_string(), active, source: source.clone(), preview }
        })
        .collect()
}

/// Serializes the app's read-modify-write of `~/.claude.json` so concurrent
/// session launches (each `pty_create` calls `trust_claude_dir`) don't interleave
/// writes with each other.
static CLAUDE_JSON_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Writes `content` to `path` atomically: write a sibling temp file, then rename
/// over the target (atomic on the same volume). A direct `fs::write` can be
/// observed half-written or interleaved with another process's write — the
/// failure mode that left trailing bytes after valid JSON and corrupted
/// `~/.claude.json` when many sessions launched at once.
fn atomic_write(path: &std::path::Path, content: &str) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_os_string();
    tmp.push(".tmp");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, path)
}

/// Returns valid, pretty-printed JSON for `content`: the content re-serialized if
/// it already parses; otherwise the leading JSON value with any trailing junk
/// dropped (the common `<valid JSON><junk>` corruption); otherwise `None`.
fn repair_claude_json(content: &str) -> Option<String> {
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(content) {
        return serde_json::to_string_pretty(&v).ok();
    }
    serde_json::Deserializer::from_str(content)
        .into_iter::<serde_json::Value>()
        .next()
        .and_then(|r| r.ok())
        .and_then(|v| serde_json::to_string_pretty(&v).ok())
}

/// Ensures `~/.claude.json` is valid JSON (Claude CLI aborts on startup when it
/// isn't). Rather than wiping the user's config to `{}`, this keeps the leading
/// valid object and drops trailing junk where possible, only resetting to `{}`
/// when nothing parses. Safe to call before any PTY session that runs claude.
fn sanitize_claude_config() {
    let path = home_dir().join(".claude.json");
    if !path.exists() { return; }
    let _guard = CLAUDE_JSON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Ok(content) = std::fs::read_to_string(&path) else { return; };
    if serde_json::from_str::<serde_json::Value>(&content).is_ok() { return; }
    let (json, what) = match repair_claude_json(&content) {
        Some(j) => (j, "repaired (dropped trailing junk)"),
        None    => ("{}".to_string(), "unrecoverable; reset to {}"),
    };
    let _ = atomic_write(&path, &json);
    log::warn!("sanitize_claude_config: ~/.claude.json {what}");
}

/// Normalises a filesystem path to the form Claude Code uses as a key in the
/// `projects` map of `~/.claude.json`: forward slashes, an upper-case Windows
/// drive letter, no `\\?\` verbatim prefix, and no trailing slash (e.g.
/// `C:\Users\Kevin\proj` → `C:/Users/Kevin/proj`). The key must match exactly
/// or Claude Code treats the directory as unseen and re-shows the trust prompt.
fn claude_project_key(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    if s.len() >= 2 && s.as_bytes()[1] == b':' && s.as_bytes()[0].is_ascii_alphabetic() {
        s = format!("{}{}", s[..1].to_uppercase(), &s[1..]);
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s
}

/// Sets `projects[key].hasTrustDialogAccepted = true` in a parsed `~/.claude.json`
/// value, creating the `projects` map and the per-directory entry if absent and
/// preserving every other field (history, allowedTools, sibling projects, …).
///
/// Returns `true` if the value was changed, `false` if `key` was already trusted
/// (so the caller can skip an unnecessary write and shrink the clobber window
/// against a concurrently-running `claude`).
fn mark_dir_trusted(config: &mut serde_json::Value, key: &str) -> bool {
    use serde_json::{Map, Value};
    let obj = match config.as_object_mut() {
        Some(o) => o,
        None => { *config = Value::Object(Map::new()); config.as_object_mut().unwrap() }
    };
    let projects = obj.entry("projects").or_insert_with(|| Value::Object(Map::new()));
    if !projects.is_object() { *projects = Value::Object(Map::new()); }
    let entry = projects.as_object_mut().unwrap()
        .entry(key.to_string()).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() { *entry = Value::Object(Map::new()); }
    let entry = entry.as_object_mut().unwrap();
    if entry.get("hasTrustDialogAccepted") == Some(&Value::Bool(true)) {
        return false;
    }
    entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
    true
}

/// Pre-accepts Claude Code's per-directory trust prompt for `cwd` so a `claude`
/// session auto-launched there starts already trusted (no blocking "Do you
/// trust the files in this folder?" dialog).
///
/// Merges into the existing `~/.claude.json` rather than replacing it, and
/// refuses to touch a non-empty file it can't parse (leaving recovery to
/// [`sanitize_claude_config`]) so a corrupt config is never clobbered here.
/// No-op for an empty `cwd` or when the directory is already trusted.
fn trust_claude_dir(cwd: &str) {
    if cwd.is_empty() { return; }
    // Serialize with sanitize_claude_config and other concurrent launches so the
    // read-modify-write can't interleave and corrupt the file.
    let _guard = CLAUDE_JSON_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = home_dir().join(".claude.json");
    let mut config = match std::fs::read_to_string(&path) {
        Ok(content) => match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(v) => v,
            Err(e) => { log::warn!("trust_claude_dir: ~/.claude.json unparseable ({e}); skipping"); return; }
        },
        Err(_) => serde_json::json!({}), // missing file → start fresh
    };
    let key = claude_project_key(cwd);
    if !mark_dir_trusted(&mut config, &key) { return; }
    match serde_json::to_string_pretty(&config) {
        Ok(s) => match atomic_write(&path, &s) {
            Ok(())  => log::info!("trust_claude_dir: pre-trusted {key}"),
            Err(e)  => log::warn!("trust_claude_dir: write {} failed: {e}", path.display()),
        },
        Err(e) => log::warn!("trust_claude_dir: serialize failed: {e}"),
    }
}

#[derive(serde::Deserialize)]
struct KbBlockData {
    id:      String,
    title:   String,
    tags:    Vec<String>,
    content: String,
}

#[derive(serde::Deserialize)]
struct AutomationData {
    id:       String,
    name:     String,
    command:  String,
    schedule: Option<String>,
}

#[derive(serde::Serialize)]
struct WorkspacePaths {
    kb_dir:       String,
    planning_dir: String,
}

const KB_CLAUDE_MD: &str = r#"# base-studio-code · Knowledge Base

You manage a library of markdown articles. Each article is a reusable piece of
context that gets injected into AI coding sessions based on the project's tech stack.

## Your role

Help the user create, edit, and organise articles. When asked to:
- **Create** an article — write a new `.md` file with a descriptive kebab-case filename.
- **Edit** an article — read the file first, then write the updated version.
- **List** what exists — use the Glob or Read tools to inspect the directory.

## Conventions

- One file per topic: `react-testing.md`, `rust-error-handling.md`, `postgres-migrations.md`
- No subdirectories — everything lives at the top level of this directory.
- Start each file with a `# Title` heading; the rest is freeform markdown.
- Write for a developer reading in a hurry: short, concrete, actionable.
- Keep articles focused — split broad topics into smaller targeted files.

## Constraints

Only `.md` files in this directory. No shell commands, no external URLs.
"#;

// ── Knowledge base workspace ──────────────────────────────────────────────────

/// Creates the flat reusable document library at `documents/`, writing CLAUDE.md
/// and .claude/settings.json. Safe to call on every mount — overwrites config
/// files but leaves articles alone. Returns the library path.
#[tauri::command]
async fn setup_kb_workspace() -> Result<String, String> {
    sanitize_claude_config();
    let kb_dir     = documents_dir();
    let claude_dir = kb_dir.join(".claude");
    std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    std::fs::write(
        claude_dir.join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","WebFetch","WebSearch","MultiEdit"]}}"#,
    ).map_err(|e| e.to_string())?;
    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;
    Ok(kb_dir.to_string_lossy().into_owned())
}

// ── Planning workspace CLAUDE.md templates ───────────────────────────────────
//
// The planner is guided but DYNAMIC: there is no fixed list of sections. Claude
// walks a curated checklist of every dimension of modern app development and,
// per dimension, either documents it (writes `{topic}.md`) or records it as
// skipped (in `_skipped.md`). Each documented topic is surfaced in the UI as its
// own section the moment the file appears.
//
// A template is assembled at runtime as INTRO + PROCESS. The INTRO differs by
// orientation (new vs. existing project) and carries the context placeholders
// ({PITCH}, {PROJECT_NAME}, {PROJECT_NUMBER}); the PROCESS block — channels,
// checklist, structured templates, publish flow, integration tags — is shared.
//
// repo_link tags are parsed by the frontend and trigger an automatic clone into
// ~/.base-studio-code/projects/<project>/<repo>/ so the app stays in sync.

const PLANNING_NEW_INTRO: &str = r#"# base-studio-code · New Project Planner

You are planning a brand-new software project. Your job is to understand it
deeply, create the GitHub repositories it needs, and produce a plan thorough
enough that a Claude coding session can start implementing without asking
clarifying questions.

## Pitch

{PITCH}

## How this planner works

This is a **guided but dynamic** process. There is no fixed list of sections to
fill. Instead you walk a curated checklist of every dimension of modern
application development (see "The discovery checklist" below) and, for each one,
make a deliberate decision:

- **Document it** — when it applies, write its section file and discuss it with
  the user (see "Filling sections").
- **Skip it** — when it genuinely does not apply, record it in `_skipped.md`
  with a one-line reason (see "Coverage — record what you skip"). Skipping is a
  first-class outcome: it proves the surface was considered, not forgotten.

You may also document **custom topics** the checklist doesn't name when the
project warrants them. The right panel reveals each section the moment you write
it, so the plan grows visibly as you work.

Plans have **two tiers** — project-wide topics and per-repository topics (see
"Two tiers"). Use the project tier for decisions that span the whole product and
the repo tier for choices that live in a single codebase.

## Discovery loop — one topic at a time, conversationally

Discovery is a guided conversation, not a form to rush. Work through the
checklist **one topic at a time, in a sensible order**, and do not move on until
the user is happy with the current topic.

1. Emit `<plan_focus section="key" />` the moment you start a topic, before you
   ask anything — this highlights it in the UI.
2. Ask 1–3 focused questions and genuinely discuss: dig into the *why*, surface
   trade-offs, and suggest options grounded in the knowledge base.
3. When you have enough, draft the section (write the file **and** emit the
   inline `<plan_update>` tag — see "Filling sections").
4. Ask the user to review: "Does this look right? Anything to add or change?"
   Refine and re-emit from their feedback.
5. **Stop and wait.** Do not draft the next topic. When the user approves it in
   the UI you receive a line like `[The user confirmed the "Goal" section … —
   continue to the next section.]` — that is your signal to advance.

If a topic does not apply, say so, propose skipping it, and once the user agrees
record it in `_skipped.md` and move on. Never race ahead to fill everything.

## Workflow

1. **Read the knowledge base.** Before asking anything, read every `.md` in
   `../kb/` (team standards, stack conventions, templates). Assign relevant
   blocks with `<kb_assign id="block-id" />`.
2. **Set up repositories first.** The Publish button stays disabled until at
   least one `<repo_link>` is registered, so do this before deep discovery:
   - `gh api user --jq .login` for the authenticated owner.
   - Ask what distinct codebases the project needs (name, purpose, language,
     visibility); skip what the pitch already makes obvious.
   - For each confirmed repo, immediately: create it
     (`gh repo create {owner}/{name} --private --description "..."`), clone it
     (`git clone https://github.com/{owner}/{name} {name}`), write an initial
     `{name}/CLAUDE.md`, and emit `<repo_link full_name="{owner}/{name}" />`.
3. **Walk the discovery checklist** using the loop above, documenting or skipping
   each dimension and capturing per-repo topics where they belong.
4. **Plan the agent fleet** — split the work into parallel, non-conflicting sessions
   and set the optimal session count (see "Plan the agent fleet").
5. **Publish to GitHub** once the user has confirmed the plan (see "Publish to
   GitHub").
"#;

const PLANNING_EXISTING_INTRO: &str = r#"# base-studio-code · Project Planner

You are planning an existing project. Your job is to read the codebase,
understand what has been built, decide what is next, and produce a plan thorough
enough that a Claude coding session can start implementing without asking
clarifying questions.

## Project context

- **Name**: {PROJECT_NAME}
- **GitHub Project**: #{PROJECT_NUMBER}

## How this planner works

This is a **guided but dynamic** process. There is no fixed list of sections to
fill. Instead you walk a curated checklist of every dimension of modern
application development (see "The discovery checklist" below) and, for each one,
make a deliberate decision:

- **Document it** — when it applies, write its section file grounded in what the
  code actually does, and confirm it with the user (see "Filling sections").
- **Skip it** — when it genuinely does not apply, record it in `_skipped.md`
  with a one-line reason (see "Coverage — record what you skip"). Skipping is a
  first-class outcome: it proves the surface was considered, not forgotten.

You may also document **custom topics** the checklist doesn't name when the
project warrants them. The right panel reveals each section the moment you write
it, so the plan grows visibly as you work.

Plans have **two tiers** — project-wide topics and per-repository topics (see
"Two tiers"). In a multi-repo project, put codebase-specific decisions in the
repo tier.

## Discovery loop — scan, propose, confirm (one topic at a time)

This project already exists, so discovery is not an interview from scratch — you
read the code and propose what is already true, then let the user correct and
extend it. Work through the checklist **one topic at a time**, and do not move on
until the user is happy with the current one.

1. Emit `<plan_focus section="key" />` the moment you start a topic.
2. **Scan the files that inform it** — manifests for `stack`, models/migrations
   for `schema`, route files for `api`, `.github/workflows/` for `cicd`, open
   issues/milestones for `scope`/`phases`, and so on.
3. Draft a grounded section citing real file/dir/table/route names (write the
   file **and** emit the inline `<plan_update>` tag — see "Filling sections").
4. Present it: "Here's what I found for <topic> — accurate? Anything to add or
   change going forward?" Refine and re-emit.
5. **Stop and wait.** When the user approves it in the UI you receive a line like
   `[The user confirmed the "Goal" section … — continue to the next section.]` —
   that is your signal to advance.

If a topic does not apply, propose skipping it and record it in `_skipped.md`
once the user agrees. Always scan before you propose; never race ahead.

## Workflow

1. **Link repositories.** Check whether `## Linked repositories` appears at the
   bottom of this file.
   - **If listed:** for each, emit `<repo_link full_name="owner/repo" />`, clone
     if the local path is missing, then read its `CLAUDE.md`, top-level
     manifests, and recent `gh issue list` / `gh pr list` for orientation.
   - **If none listed:** `gh api user --jq .login`, then
     `gh repo list --limit 100 --json nameWithOwner,description,pushedAt`,
     present the likely candidates for **{PROJECT_NAME}**, ask which belong, and
     emit `<repo_link>` for each confirmed repo before cloning.
2. **Read the knowledge base.** Read `kb_index.md`, read blocks whose tags match
   the stack, and assign relevant ones with `<kb_assign id="block-id" />`. Read
   `automations.md` and suggest automations that fit.
3. **Walk the discovery checklist** using the scan→propose→confirm loop above,
   documenting or skipping each dimension and capturing per-repo topics where
   they belong. Open with a 3–5 sentence orientation on what you found.
4. **Plan the agent fleet** — split the work into parallel, non-conflicting sessions
   and set the optimal session count (see "Plan the agent fleet").
5. **Publish to GitHub** once the user has confirmed the plan (see "Publish to
   GitHub").
"#;

const PLANNING_PROCESS_MD: &str = r##"
## Tools available

| Tool             | What you can do                                                         |
|------------------|-------------------------------------------------------------------------|
| **Read**         | Read any file on disk                                                   |
| **Write**        | Create or overwrite any file — section files, CLAUDE.md, workflow YAMLs |
| **Edit**         | Patch a single file in-place                                            |
| **WebFetch**     | Fetch any URL — package registries, docs, GitHub raw content            |
| **Bash(git \*)** | Any git subcommand — clone, commit, push, log, diff, status, etc.      |
| **Bash(gh \*)**  | Any gh CLI subcommand — repos, issues, PRs, labels, milestones, etc.   |

**Not available:** generic shell commands (`cp`, `ls`, `cat`, `mkdir`, etc.) and
WebSearch. Use **Read**/**Write** wherever you would reach for `cat`/`cp`, and
**WebFetch** for documentation or version lookups.

## Filling sections — two channels

Each documented topic is **its own file** in your current directory, named after
the topic. Whenever you draft or refine a section, do **both**:

**Channel 1 — write the section file** (reliable; survives restarts). The app
polls these files every 2 seconds and updates the right panel. Overwrite to
refine — each write replaces the previous version.

- Project-tier file: `{topic}.md` — e.g. `goal.md`, `stack.md`, `security.md`,
  `observability.md`, or a custom `feature_flags.md`.
- The roadmap is JSON: `phases.json` (see "Special sections").

**Channel 2 — emit an inline tag** for immediate display before the next poll:
```
<plan_update section="goal">content here</plan_update>
```
The `section` value is the file stem (no extension). Use the same key for both
channels so they refer to one section.

Mark the topic you are actively discussing so the UI highlights it:
```
<plan_focus section="key" />
```

## Coverage — record what you skip

Maintain `_skipped.md`: one line per checklist dimension you deliberately did
**not** document, each with a short reason. Keep it current as you decide to skip
things. The UI shows it as a collapsed "considered & skipped" list so the user
can see the whole surface was weighed.

Format (any of these per line works):
```
- **Schema** — no persistent datastore; all state is in-memory
- **Accessibility** — internal CLI, no UI surface
- Analytics: out of scope for v1
```

## Two tiers — project vs. per-repo

- **Project tier** — decisions that span the whole product. Bare key/file:
  `architecture.md`, `security.md`, …
- **Repo tier** — decisions that live in one codebase of a multi-repo project.
  Namespace the key `repo__{short}__{topic}`, where `{short}` is the repo name
  **without the owner** (for `acme/web`, short = `web`). File:
  `repo__web__api.md`; inline tag `<plan_update section="repo__web__api">…`.

Use the repo tier when a choice only applies to one repo (the web app's UX, the
API service's schema). For single-repo projects, stay in the project tier.

## Per-repo planning & starting scripts

After the project-level checklist, do a **per-repo pass** for every linked repo.
For each repo `{short}`:

1. **Walk the repo-relevant dimensions** as repo-tier sections — at least its
   role in the system, stack, the slice of the architecture/API/schema it owns,
   its testing approach, and the current phase's in-scope work for *this* repo.
   Write them as `repo__{short}__{topic}.md` (e.g. `repo__web__api.md`); they
   appear under that repo's group in the panel.
2. **Record the repo's toolchain commands** the moment you decide its stack — its
   build, test, run, and package-manager binaries (e.g. `cargo`, `npm`, `pnpm`,
   `pytest`, `docker`). Add them under that repo in `commands.json` and emit the
   `<allow_command>` tag (see "App integration tags"). Required, not optional, and
   don't just mention them in prose: without it the repo's console/triage sessions
   block on a permission prompt for every command. `gh`/`git` are always allowed.
3. **Write two starting scripts** into `prompts/` — these are the first messages
   future Claude sessions in that repo receive, so write them as direct
   instructions addressed to that session (not notes about it):
   - `prompts/{short}-kickoff.md` — the **dev** kickoff: this repo's role, its
     stack, the current phase's in-scope work here, the first concrete steps, and
     a reminder to read `CLAUDE.local.md` / the plan and stay aligned with it.
   - `prompts/{short}-triage.md` — the **triage** script: how to triage *this*
     repo's open issues (priority labels P0–P3, this repo's label/area
     conventions, what "stale" means here), grounded in the plan's priorities.
4. **Register both** so the app auto-assigns them as that repo's startup prompts
   (see `<startup_script>` under "App integration tags"). Once registered,
   opening this repo's console uses the kickoff and its triage pane uses the
   triage script — no manual assignment needed.

Keep the scripts plain and self-contained; the session has the repo checked out
and the plan available, but the script is what gets it moving.

## Plan the agent fleet

After the per-repo pass, design how multiple Claude sessions will build this project
in parallel — the **fleet**. The goal is maximum parallelism with minimum conflict:
several sessions working at once, each in its own lane, so they rarely touch the same
files and rarely need a human.

1. **Partition the current phase's in-scope work into streams.** A *stream* is one
   session with a focused role ("Auth UI", "API endpoints", "DB schema"). Split by
   concern so that two streams never write the same files.
2. **Give each stream a non-overlapping ownership boundary** — the dirs/globs it
   owns. No path may belong to two streams. A shared file (schema, shared types,
   config, a contract) must be owned by exactly ONE stream; any stream that needs it
   lists that stream in `depends_on` (interface-first: the owner lands it, then the
   dependents build on it).
3. **Assign each stream the issues it owns** — the deliverables from `phases`/scope
   for its area.
4. **Decide the optimal concurrent session count.** There is **no hard limit** on how
   many sessions can run at once: the app shows each session as a pane, a single tab
   holds up to **4×4 = 16** panes, and the user can open **many tabs**. So 16 is only
   a per-tab layout limit, never a ceiling on the fleet. The real bound is how many
   sessions the user can realistically **review and steer** — ask them, and set the
   recommended count to that. Recommend the largest number of genuinely independent
   (non-overlapping, dependency-free) streams they can keep up with, and explain the
   reasoning. (The one-click launch fills one build tab with up to 16 of them; run the
   rest from additional tabs.)
5. **Recommend a director** when the fleet is non-trivial (2+ streams, or multiple
   repos). The director is an *async-integrator* session at the project root: it
   reviews/merges PRs, resolves the cross-stream decisions workers log, and keeps
   milestones/issues/the board current. It does NOT write feature code.
6. **Write `fleet.json`** (authoritative — the app polls it) AND emit the inline
   `<fleet_plan>` + `<agent_assign>` tags (fast path). Keep both current as the fleet
   firms up. Shape:
   ```
   {
     "recommended": 4,
     "reasoning": "Phase 1 splits into four non-overlapping areas; the api-client lands the contract first, the rest are independent.",
     "director": { "enabled": true, "role": "async integrator: review/merge PRs, resolve logged decisions, keep milestones current" },
     "streams": [
       {"id":"auth-ui","name":"Auth UI","repo":"owner/web","owns":["src/auth/**","src/components/login/**"],"issues":["#12","#15"],"dependsOn":[],"prompt":"prompts/auth-ui-kickoff.md"},
       {"id":"api-client","name":"API client","repo":"owner/web","owns":["src/lib/api/**"],"issues":["#18"],"dependsOn":[],"prompt":"prompts/api-client-kickoff.md"}
     ]
   }
   ```
   Each stream may also carry **`"profile"`** — an AgentProfile id that scopes its
   session's auto-approved commands, per-tool permissions, and write-paths (least
   privilege, layered on top of the role). After the commands step has discovered the
   project's toolchain, either reuse an existing profile or, in the fleet card, click
   **Generate least-privilege profiles** to derive one per agent from its role + `owns`
   + the project's commands; `<agent_assign … profile="…">` assigns one inline.
7. **Write a kickoff script per stream** to `prompts/{id}-kickoff.md` (and
   `prompts/director-kickoff.md` if a director). These are the first messages those
   sessions receive — design them for autonomy (next).

**How agents run** (so you design ids + kickoffs right): at launch the app gives each
worker its own **git worktree** of its repo, checked out to a **branch named after the
stream `id`** — so make ids lowercase-hyphen slugs, since they become branch names.
Workers commit on their branch and open PRs; the director merges them. Because each
worker has its own worktree, several streams can share one repo without touching the
same working tree. (The worktree also carries the plan: `CLAUDE.local.md` is copied in.)

### Stream kickoff scripts — designed for autonomy

Each kickoff is the first message a worker session gets; its job is to let that
session run with as little human input as possible. Every worker kickoff must:

- State the stream's role and that the full plan is in `CLAUDE.local.md` — read it
  first; it is authoritative.
- State the ownership boundary: "you own <globs>; do not modify files outside them —
  another stream owns them; coordinate through the plan, not by editing their files."
- State that it runs in its **own git worktree on a branch named after the stream**:
  commit there and open a PR for the director to merge; never switch branches or edit
  another agent's worktree. (The app creates the worktree + branch at launch.)
- List the issues the stream owns and this phase's in-scope work for it.
- Carry the **autonomy rule**: *Do not stop to ask. When something is underspecified,
  make the smallest reversible choice consistent with the plan's goal and
  architecture, then record it — pipe a one-line note into `bsc-note` on stdin (e.g.
  `echo "used cursor pagination for /items per the api section" | bsc-note`). Only if
  you are genuinely blocked and cannot proceed, pipe a one-line reason into
  `bsc-blocked`. Verify against the repo's tests and CI rather than asking whether
  your work is correct.*
- Carry the **checkpoint rule** (so a relaunched session resumes where it left off):
  *When you pause or finish a work session, pipe a short "where I left off + the next
  step" into `bsc-checkpoint` on stdin.* The live conversation usually resumes too
  (each agent has its own worktree/cwd), but the checkpoint is the reliable carry.

The **director kickoff** instead tells it to watch each agent's branch/PR, the open
issues, and each repo's `DECISIONS.md`; merge the agents' branches via PRs (resolving
conflicts); resolve or escalate the cross-stream decisions workers log; and keep
milestones/the board current — never writing feature code itself.

## The discovery checklist

Walk these dimensions, documenting the ones that apply (project or repo tier) and
recording the rest in `_skipped.md`. Each line is the **structured template** for
that section — capture exactly what it asks for. `goal`, `phases`, and `risks`
apply to almost every project.

**Product**
- `goal` — what it does, who it's for, and the measurable signal of success
  (2–4 sentences). Drives the GitHub project title and description.
- `users` — primary personas, their jobs-to-be-done, and the one workflow each
  cares most about.
- `scope` — two lists: **In scope** (concrete deliverables) and **Out of scope**
  (explicit exclusions that prevent scope creep).
- `ux` — key screens/flows, navigation model, and empty/error/loading states.
  For non-UI projects, the CLI/API ergonomics instead.

**Engineering**
- `stack` — one line per layer (runtime, framework, datastore, cache/queue,
  auth, hosting) with versions and a justification for non-obvious picks. As soon
  as the toolchain is decided, record its build/test/run/package binaries in
  `commands.json` and emit `<allow_command>` (see "App integration tags") so the
  project's sessions run them without a prompt.
- `architecture` — named components + a one-sentence responsibility each, how
  they communicate (protocol, sync/async), and 2–3 key flows as step-by-step
  data paths.
- `schema` — per entity: table/collection, key fields + types, constraints,
  relationships, important enums; note the migrations strategy.
- `api` — per endpoint or exported contract: method+path (or signature),
  request/response shape, auth, the shared error format + status codes, plus
  versioning/pagination conventions.
- `integrations` — third-party services (payments, email, storage, LLM): purpose,
  auth model, failure handling, sandbox vs. production.
- `auth` — identity provider, session/token model, roles & permissions, and how
  authorization is enforced at each layer.

**Quality & operations**
- `security` — threat-model highlights, secret management, input
  validation/encoding, dependency & supply-chain controls, and encryption at
  rest/in transit. Note any legal-doc updates a data-handling change requires.
- `testing` — the unit/integration/E2E split: what each covers, frameworks,
  fixtures/mocks, the coverage target, and the CI gate that enforces it.
- `observability` — structured logging (levels, format, correlation ids),
  metrics/SLIs, tracing, dashboards, and alert thresholds.
- `performance` — target latency/throughput, expected load, capacity limits,
  caching, and the reliability budget (timeouts, retries, backpressure, graceful
  degradation).
- `infra` — environments (dev/staging/prod), provisioning (IaC), networking,
  scaling model, and backups/disaster recovery.
- `cicd` — pipeline stages per environment, deploy mechanism, secrets handling,
  and branching/release/versioning strategy.

**Lifecycle & governance**
- `data_lifecycle` — retention/deletion policies, PII handling, compliance
  (e.g. GDPR), migrations/backfills, and audit logging.
- `docs` — what docs exist and where (README, API reference, architecture,
  runbooks) and what changes trigger an update.
- `analytics` — product events/KPIs tracked, the tooling, and how the success
  metric from `goal` is measured.
- `accessibility` — the a11y target (e.g. WCAG level), keyboard/screen-reader
  support, and i18n/l10n approach.
- `cost` — expected cost drivers, budget guardrails, and resourcing/ownership.

**Planning**
- `phases` — the roadmap as a JSON array (see "Special sections"); each phase is
  a crisp "done when", no time estimates.
- `issues` — decompose each phase into granular, self-contained GitHub issues
  (see "Special sections"). **This is the most important output for execution.** A
  building agent picks up ONE issue and must be able to finish it WITHOUT asking, so
  each issue carries everything it needs: a concrete title, **acceptance criteria**
  (the done-when checklist), the **files/dirs it owns** (where to work), its
  **dependencies** (refs of issues that must land first), **labels**, and its
  **phase** (→ milestone). Size each to a single focused session; split anything an
  agent couldn't finish in one sitting. Don't stop at a high-level overview — the
  plan isn't done until the work is decomposed to this level.
- `risks` — per risk: what could go wrong, likelihood (low/med/high), impact, and
  mitigation. Add continuously as you spot them.
- `open_questions` — unresolved decisions shaping the plan. Drive this toward
  **zero** before the fleet launches: resolve each with the user, or record an
  explicit default ("agent decides; default = X") so a building session never has to
  stop and ask. Each remaining item names what's needed to resolve it.
- `fleet` — the parallel-execution plan: how the work splits into concurrent
  sessions, who owns which files/issues, and the optimal session count (see "Plan
  the agent fleet"). Written as `fleet.json`, not a prose section.

Document custom topics beyond this list when the project needs them — name the
file after the topic (`feature_flags.md`, `offline_sync.md`).

## Worked examples

```
<plan_update section="goal">
A CLI that runs Postgres migrations against any instance with zero local driver
setup. Users are backend engineers on CI and local dev. Success = migrations run
reliably across environments with no manual driver install.
</plan_update>
```
```
<plan_update section="api">
POST /v1/migrations/up   body {target?:string}  -> 200 {applied:[{version}]}
GET  /v1/migrations/status                       -> 200 {pending:[],applied:[]}
Auth: bearer service token. Errors: {error:{code,message}} with 4xx/5xx.
Pagination: cursor via ?after=; page size capped at 100.
</plan_update>
```
```
<plan_update section="security">
Secrets: DATABASE_URL from the runner's secret store, never logged. Input: DSNs
validated against a scheme allowlist. Supply chain: pinned go.mod + govulncheck in
CI. Transit: TLS-required connections. No PII stored — no legal-doc change.
</plan_update>
```
```
<plan_update section="observability">
Logging: structured JSON, levels error/warn/info/debug, request id propagated.
Metrics: migrations_applied_total, migration_duration_seconds (histogram).
Tracing: one span per migration. Alert: page on migration failure rate above 0.
</plan_update>
```
```
<plan_update section="phases">[
  {"name":"Phase 1 — Working CLI","description":"up/down/status work against a real Postgres; single binary builds cross-platform"},
  {"name":"Phase 2 — Production ready","description":"integration suite passes; release pipeline ships v1.0.0"}
]</plan_update>
```
```
<plan_update section="issues">[
  {"ref":"F1","title":"Add POST /v1/migrations/up","phase":1,"acceptance":["applies pending migrations in order","returns 200 {applied:[{version}]}","integration test against real Postgres"],"owns":["src/api/migrations.go"],"dependsOn":[],"labels":["scope:core","area:api"],"stream":"api"},
  {"ref":"F2","title":"Wire `status` to GET /v1/migrations/status","phase":1,"acceptance":["lists pending + applied","exit 0"],"owns":["src/cli/status.go"],"dependsOn":["F1"],"labels":["scope:core","area:cli"],"stream":"cli"}
]</plan_update>
```

## Special sections

- **`goal`** — always document it; its first sentence becomes the GitHub project
  board title and its opening line the description.
- **`phases`** — write `phases.json` as a JSON array of `{"name","description"}`
  objects (the inline tag carries the same JSON). Each phase needs a "done when"
  definition; never include time estimates or week numbers. The publish flow
  turns each phase into a milestone and a tracking issue per repo.
- **`issues`** — write `issues.json` as a JSON array of issue objects:
  `{"ref","title","phase","acceptance":[],"owns":[],"dependsOn":[],"labels":[],"stream"?,"repo"?}`.
  `ref` is a stable planner-local id used by `dependsOn` (NOT the GitHub number,
  which is assigned at publish); `phase` is the 1-based phase number or its name
  (→ that milestone). The publish flow creates ONE GitHub issue per entry — title,
  a body built from the acceptance checklist + owned paths + dependencies, pinned to
  its milestone, with its labels and a `stream:<id>` label. A fleet stream owns its
  issues by listing their refs. Define enough that the agent who picks one up needs
  nothing else.
- **`_skipped`** — the coverage record described under "Coverage" above.

## Publish to GitHub

After the user confirms the plan in the right panel, the **Publish** button
creates the repositories, the project board, one milestone per phase, and one
GitHub issue per `issues.json` entry (pinned to its milestone, with its labels;
falling back to a per-phase tracking issue when no issues are defined), and labels
each fleet stream's owned issues with `stream:<id>`. You can also push detail yourself with the
`gh` CLI — every step below is idempotent (check-then-create), so re-running is a
safe sync. Do this in order, per linked repository:

**Labels** (`--force` is idempotent):
```
gh label create "scope:core" --color "0075ca" --repo owner/repo --force
gh label create "phase:1"    --color "0e8a16" --repo owner/repo --force
gh label create "risk:high"  --color "b60205" --repo owner/repo --force
```
**Milestones** (one per phase):
```
gh api repos/owner/repo/milestones --method POST --field title="Phase 1 — <name>" --field description="<done-when>"
```
**Issues** (one per in-scope deliverable, pinned to its milestone):
```
gh issue create --repo owner/repo --title "<deliverable>" --body "<acceptance criteria>" --milestone <number> --label "scope:core,phase:1"
```
**Repo metadata + plan file:**
```
gh repo edit owner/repo --description "<one-line goal>" --add-topic "<language>" --add-topic "<framework>"
```
Write the consolidated plan to `{repo}/.github/PROJECT_PLAN.md`, then commit and
push it (new projects to `main`; existing projects via a `docs/project-plan`
branch and a PR).

## App integration tags

**Link a repository** (emit once per repo the moment it's confirmed — created,
listed, or discovered; duplicates are harmless):
```
<repo_link full_name="owner/repo" />
```
**Assign a knowledge block** (read `kb_index.md` for ids):
```
<kb_assign id="block-id" />
```
**Suggest an automation** (read `automations.md` first; omit `schedule` for
on-demand commands — otherwise it's a cron expression):
```
<automation_assign name="Daily audit" command="npm audit" schedule="0 9 * * 1-5" description="Runs every weekday morning" />
```
**Register a per-repo starting script** (emit once you've written the file to
`prompts/`; `mode` is `dev` or `triage`, `path` is relative to this directory).
The app auto-assigns it so that repo's future sessions launch with it:
```
<startup_script repo="owner/repo" mode="dev" path="prompts/web-kickoff.md" />
<startup_script repo="owner/repo" mode="triage" path="prompts/web-triage.md" />
```

**Allow shell commands** so the repo's future console/triage sessions run them
without a permission prompt — the stack's build, test, run, and package-manager
binaries (e.g. `cargo`, `npm`, `pnpm`, `pytest`, `docker`). `gh`/`git` are always
allowed, so don't list them. Use BOTH channels — the file is authoritative:

- **Write `commands.json`** in this directory — the reliable channel the app
  polls (an inline tag in the chat stream can be missed). Project-wide commands
  under `project`, per-repo under `repos` keyed by full_name. Overwrite the whole
  file as the stack firms up:
  ```
  {"project":["cargo"],"repos":{"owner/web":["npm","pnpm"],"owner/api":["pytest"]}}
  ```
- **Inline tag** (fast path; omit `repo` for project scope):
  ```
  <allow_command cmd="cargo" />
  <allow_command repo="owner/repo" cmd="npm" />
  ```

**Declare the agent fleet** (the parallel-execution plan). `fleet.json` is the
authoritative channel; these tags are the fast path. Emit the header once, then one
`agent_assign` per stream. List attributes (`owns`, `issues`, `depends_on`) are
comma-separated; `depends_on` is comma-separated stream ids. An optional `profile`
attribute carries an AgentProfile id that scopes the stream's session (commands +
tools + write-paths) — generate one per agent or reuse an existing profile.

Each stream also carries an optional **flow** (#297) — how it runs and pushes —
via four attributes, all defaulting if omitted:
- `autonomy` = `continuous` (never pause; default) | `checkpoint` (pause at stage/PR
  boundaries and wait) | `confirm` (ask before non-trivial decisions)
- `push` = `auto-pr` (commit+push+open PR on green; default) | `push-confirm`
  (commit+test, then wait for the user before pushing) | `commit-only` (commit, don't
  push) | `none` (read-only; no commit/push/PR)
- `trigger` = `per-issue` (default) | `per-stage` | `on-green` — when a push fires
- `gate` = `hard` (default; the push/PR command prompts for approval) | `soft` (the
  kickoff just instructs the agent to ask). `gate` only matters for `push-confirm`.
Default = `continuous` + `auto-pr` + `per-issue` + `hard`. Set a tighter flow for an
agent whose work you want to review before it lands (e.g. `push=push-confirm gate=hard`),
or `push=none` for a pure reviewer/explorer.
```
<fleet_plan recommended="4" reasoning="..." director="true" director_role="async integrator: review/merge PRs, resolve logged decisions, keep milestones current" />
<agent_assign id="auth-ui" name="Auth UI" repo="owner/web" owns="src/auth/**,src/components/login/**" issues="#12,#15" depends_on="" prompt="prompts/auth-ui-kickoff.md" profile="auth-ui-dev" autonomy="continuous" push="auto-pr" trigger="per-issue" gate="hard" />
```

## GitHub tools

`GH_TOKEN` is pre-loaded — use `gh` for all GitHub operations. Read
`github_context.md` for the authenticated login, linked repos, and command
examples.
```
gh api user --jq .login
gh repo create owner/name --private --description "..."
gh repo list --limit 100 --json nameWithOwner,description,pushedAt
gh issue list --repo owner/repo --state open --limit 20
gh api repos/owner/repo/milestones --method POST --field title="..."
gh issue create --repo owner/repo --title "..." --body "..." --milestone N --label "a,b"
gh repo edit owner/repo --description "..." --add-topic "..."
```
"##;

/// Turns an arbitrary project key into a filesystem-safe directory name.
/// Canonicalize a project key into a filesystem-safe slug.
///
/// Must stay byte-for-byte identical to the frontend's paneId sanitization in
/// Planning.tsx (`replace(/[^a-zA-Z0-9-]/g, '_').slice(0, 80)`) so the PTY id and
/// the planning directory always correspond. ASCII-only on purpose — Rust's
/// `char::is_alphanumeric` accepts Unicode letters, which the JS regex does not.
fn sanitize_project_key(key: &str) -> String {
    let s: String = key
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' })
        .collect();
    // Truncate so paths stay manageable.
    s.chars().take(80).collect()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn setup_workspaces(
    kb_blocks: Vec<KbBlockData>,
    repo_full_names: Vec<String>,
    automations: Vec<AutomationData>,
    is_existing: bool,
    project_name: String,
    project_number: u32,
    pitch: String,
    project_key: String,
    github_login: String,
    github_name: String,
) -> Result<WorkspacePaths, String> {
    let _perf = PerfSpan::new("setup_workspaces");
    sanitize_claude_config();
    // KB session CWD = the flat reusable document library (`documents/`).
    // Planner session CWD = the project hub (`projects/<key>`), holding plan
    // sections + control files FLAT alongside the project's CLAUDE.md.
    let kb_dir       = documents_dir();
    let safe_key     = sanitize_project_key(&project_key);
    // A blank key would resolve the project dir to `projects/` itself and scatter
    // `.claude/` and the plan sections across the parent — refuse it instead.
    if safe_key.is_empty() {
        return Err("setup_workspaces: empty project_key".to_string());
    }
    let planning_dir = project_dir(&project_key);

    for dir in &[
        kb_dir.join(".claude"),
        planning_dir.join(".claude"),
        planning_dir.join("prompts"),
    ] {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    // KB: read + write/edit markdown only; no web access or shell
    std::fs::write(
        kb_dir.join(".claude").join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit"],"deny":["Bash","MultiEdit","WebFetch","WebSearch"]}}"#,
    ).map_err(|e| e.to_string())?;

    // Planning: read/write markdown + WebFetch + git + gh CLI
    // git: clone/fetch/log/status for linked repos
    // gh:  issues, PRs, releases, workflows — full GitHub access via GH_TOKEN env var
    std::fs::write(
        planning_dir.join(".claude").join("settings.json"),
        r#"{"permissions":{"allow":["Read","Write","Edit","WebFetch","Bash(git *)","Bash(gh *)"],"deny":["MultiEdit","WebSearch"]}}"#,
    ).map_err(|e| e.to_string())?;

    std::fs::write(kb_dir.join("CLAUDE.md"), KB_CLAUDE_MD)
        .map_err(|e| e.to_string())?;

    // Assemble the template: orientation-specific INTRO + shared PROCESS block.
    let mut planning_md = if is_existing {
        format!(
            "{}{}",
            PLANNING_EXISTING_INTRO
                .replace("{PROJECT_NAME}", &project_name)
                .replace("{PROJECT_NUMBER}", &project_number.to_string()),
            PLANNING_PROCESS_MD,
        )
    } else {
        format!("{}{}", PLANNING_NEW_INTRO.replace("{PITCH}", &pitch), PLANNING_PROCESS_MD)
    };

    // Append linked repos section for existing projects (always, even when
    // empty, so Claude knows the current state and acts accordingly).
    if is_existing {
        planning_md.push_str("\n## Linked repositories\n\n");
        if repo_full_names.is_empty() {
            planning_md.push_str("No repositories are currently linked to this project.\n");
        } else {
            for full_name in &repo_full_names {
                let local_path = repo_dir(&project_key, full_name);
                planning_md.push_str(&format!(
                    "- **{full_name}**\n  - local path: `{local_path}`\n  - clone if missing: `git clone https://github.com/{full_name} {local_path}`\n",
                    full_name  = full_name,
                    local_path = local_path.display(),
                ));
            }
        }
    }

    std::fs::write(planning_dir.join("CLAUDE.md"), planning_md)
        .map_err(|e| e.to_string())?;

    // Sync every KB block to disk as a markdown file (overwrite on each call)
    for block in &kb_blocks {
        let content = format!(
            "---\nid: {}\ntitle: {}\ntags: [{}]\n---\n\n{}",
            block.id,
            block.title,
            block.tags.join(", "),
            block.content,
        );
        std::fs::write(kb_dir.join(format!("{}.md", block.id)), content)
            .map_err(|e| e.to_string())?;
    }

    // Write a KB index so Claude can quickly see what's available without
    // reading every individual block file. The planner's session CWD is this
    // project hub (`projects/<key>`), and reusable KB blocks live in the flat
    // library (`documents/`), so the relative reference is `../../documents/{id}.md`.
    let mut kb_index = String::from(
        "# Knowledge Base Index\n\n\
         Read any block file at `../../documents/{id}.md` for full content.\n\
         Assign a block to this project with: `<kb_assign id=\"{id}\" />`\n\n"
    );
    if kb_blocks.is_empty() {
        kb_index.push_str("_No knowledge blocks in the store yet._\n");
    } else {
        for block in &kb_blocks {
            kb_index.push_str(&format!(
                "- `{}` — **{}** (tags: {})\n",
                block.id,
                block.title,
                if block.tags.is_empty() { "none".to_string() } else { block.tags.join(", ") },
            ));
        }
    }
    std::fs::write(planning_dir.join("kb_index.md"), kb_index)
        .map_err(|e| e.to_string())?;

    // Write automations catalogue so Claude can reference and assign them.
    let mut auto_md = String::from(
        "# Automations Catalogue\n\n\
         Suggest assigning an automation to this project with a single-line tag:\n\
         `<automation_assign name=\"...\" command=\"...\" schedule=\"0 9 * * 1-5\" description=\"...\" />`\n\n\
         The `schedule` field is a cron expression (omit for one-shot commands).\n\n"
    );
    if automations.is_empty() {
        auto_md.push_str("_No saved automations yet — suggest new ones using the tag above._\n");
    } else {
        auto_md.push_str("## Saved automations\n\n");
        for a in &automations {
            auto_md.push_str(&format!("- **{}** (`{}`)", a.name, a.id));
            if let Some(sched) = &a.schedule {
                auto_md.push_str(&format!(" · cron: `{}`", sched));
            }
            auto_md.push_str(&format!("\n  command: `{}`\n", a.command));
        }
    }
    std::fs::write(planning_dir.join("automations.md"), auto_md)
        .map_err(|e| e.to_string())?;

    // Write a github_context.md so Claude knows the authenticated user and
    // what repos are available without needing to run `gh api user` first.
    let mut gh_ctx = String::from("# GitHub Context\n\n");
    if !github_login.is_empty() {
        gh_ctx.push_str("## Authenticated user\n\n");
        gh_ctx.push_str(&format!("- **Login**: `{}`\n", github_login));
        if !github_name.is_empty() {
            gh_ctx.push_str(&format!("- **Name**: {}\n", github_name));
        }
        gh_ctx.push_str(&format!("- **Profile**: https://github.com/{}\n\n", github_login));
    }
    if !repo_full_names.is_empty() {
        gh_ctx.push_str("## Linked repositories\n\n");
        for full_name in &repo_full_names {
            let local_path = repo_dir(&project_key, full_name);
            gh_ctx.push_str(&format!(
                "- `{}` — local path: `{}`\n",
                full_name, local_path.display(),
            ));
        }
        gh_ctx.push('\n');
    }
    gh_ctx.push_str(
        "## Useful gh commands\n\n\
         ```\n\
         gh api user                                    # confirm auth\n\
         gh repo list --limit 100 --json nameWithOwner  # all repos\n\
         gh repo create {login}/{name} --private        # new repo\n\
         gh issue list --repo {owner}/{repo}            # open issues\n\
         gh pr list   --repo {owner}/{repo}             # open PRs\n\
         ```\n"
    );
    std::fs::write(planning_dir.join("github_context.md"), gh_ctx)
        .map_err(|e| e.to_string())?;

    Ok(WorkspacePaths {
        kb_dir:       kb_dir.to_string_lossy().into_owned(),
        planning_dir: planning_dir.to_string_lossy().into_owned(),
    })
}

// ── Claude config file management ────────────────────────────────────────────
//
// Reads and writes CLAUDE.md + .claude/settings.json for two target types:
//   global   — local_path = "" → ~/.claude/CLAUDE.md and ~/.claude/settings.json
//   per-repo — local_path = repo root → {root}/CLAUDE.md and {root}/.claude/settings.json

fn claude_paths(local_path: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    if local_path.is_empty() {
        let global = home_dir().join(".claude");
        (global.join("CLAUDE.md"), global.join("settings.json"))
    } else {
        let base = std::path::PathBuf::from(local_path);
        (base.join("CLAUDE.md"), base.join(".claude").join("settings.json"))
    }
}

#[derive(serde::Serialize)]
struct ClaudeConfigData {
    instructions: String,
    allow:        Vec<String>,
    deny:         Vec<String>,
}

#[tauri::command]
async fn read_claude_config(local_path: String) -> Result<ClaudeConfigData, String> {
    let (md_path, settings_path) = claude_paths(&local_path);

    let instructions = std::fs::read_to_string(&md_path).unwrap_or_default();

    let (allow, deny) = if settings_path.exists() {
        let raw = std::fs::read_to_string(&settings_path).map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
        let parse_list = |key: &str| -> Vec<String> {
            v["permissions"][key].as_array()
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default()
        };
        (parse_list("allow"), parse_list("deny"))
    } else {
        (vec![], vec![])
    };

    Ok(ClaudeConfigData { instructions, allow, deny })
}

#[tauri::command]
async fn write_claude_config(
    local_path: String,
    instructions: String,
    allow: Vec<String>,
    deny: Vec<String>,
) -> Result<(), String> {
    let (md_path, settings_path) = claude_paths(&local_path);

    if let Some(parent) = md_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(parent) = settings_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    std::fs::write(&md_path, &instructions).map_err(|e| e.to_string())?;

    let settings = serde_json::json!({
        "permissions": { "allow": allow, "deny": deny }
    });
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;

    Ok(())
}

// ── Repository resolution ─────────────────────────────────────────────────────
//
// Repos live inside their project hub at `projects/<project>/<short-repo-name>`.
// clone_repo: clones there via HTTPS; idempotent if the dir already exists.

/// Clones `full_name` (an `owner/name` GitHub slug) into the project hub at
/// `projects/<sanitize(project)>/<short-repo-name>` and returns the clone path.
/// Idempotent: if the destination is already a git clone it is returned as-is.
/// After cloning, `CLAUDE.local.md` is appended to the clone's
/// `.git/info/exclude` so the planner-generated per-repo context file stays out
/// of `git status`.
#[tauri::command]
async fn clone_repo(project: String, full_name: String) -> Result<String, String> {
    let _perf = PerfSpan::new("clone_repo");
    let dest = repo_dir(&project, &full_name);
    if dest.is_dir() && dest.join(".git").exists() {
        return Ok(dest.to_string_lossy().into_owned());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let url = format!("https://github.com/{}.git", full_name);
    let status = std::process::Command::new("git")
        .args(["clone", &url, &dest.to_string_lossy()])
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        log::warn!("clone_repo: git clone failed for {full_name}");
        return Err(format!("git clone failed for {}", full_name));
    }
    // Keep app-managed files (per-repo CLAUDE.local.md, the .claude/ session
    // settings) out of the clone's `git status`.
    git_exclude(&dest, "CLAUDE.local.md");
    git_exclude(&dest, ".claude/");
    // The fleet assume-and-log journal (bsc-note / bsc-blocked) lives in the repo
    // root; keep it out of the clone's `git status`.
    git_exclude(&dest, "DECISIONS.md");
    log::info!("clone_repo: cloned {full_name} → {}", dest.display());
    Ok(dest.to_string_lossy().into_owned())
}

/// Branch/dir slug for a fleet agent — keeps only `[A-Za-z0-9._-]`, every other
/// char becomes `-`. Must match the frontend `worktreeSlug` so the computed
/// worktree cwd and the on-disk worktree path agree.
fn worktree_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '-' })
        .collect()
}

/// Create (idempotently) a git worktree for one fleet agent: an isolated checkout
/// of `repo` on a branch named after the agent, at
/// `projects/<key>/.worktrees/<repoShort>--<agentSlug>`. Each agent edits and
/// commits in its own worktree+branch, so co-located agents (several in one repo)
/// never share a working tree; the director merges the branches via PRs.
///
/// The repo's main clone must already exist (cloned during planning). A worktree or
/// branch left over from a prior run is reused. Returns the worktree's absolute path
/// (native form — mirrors `agentWorktreeCwd` so the launched pane's cwd matches).
#[tauri::command]
async fn ensure_worktree(project_key: String, repo: String, agent_id: String) -> Result<String, String> {
    let _perf = PerfSpan::new("ensure_worktree");
    let clone = repo_dir(&project_key, &repo);
    if !clone.join(".git").exists() {
        return Err(format!("ensure_worktree: repo not cloned: {}", clone.display()));
    }
    let slug  = worktree_slug(&agent_id);
    let short = repo.rsplit('/').next().unwrap_or(&repo);
    let wt    = project_dir(&project_key).join(".worktrees").join(format!("{short}--{slug}"));
    let wt_str = wt.to_string_lossy().into_owned();
    // A worktree's `.git` is a FILE pointing into the main repo; create it only if
    // it isn't there yet (reuse across re-runs).
    if !wt.join(".git").exists() {
        if let Some(parent) = wt.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let clone_str = clone.to_string_lossy().into_owned();
        // Reuse the branch if a prior run already created it; otherwise create it.
        let branch_exists = std::process::Command::new("git")
            .args(["-C", &clone_str, "rev-parse", "--verify", "--quiet", &format!("refs/heads/{slug}")])
            .status().map(|s| s.success()).unwrap_or(false);
        let mut args: Vec<String> = vec!["-C".into(), clone_str, "worktree".into(), "add".into()];
        if branch_exists {
            args.push(wt_str.clone());
            args.push(slug.clone());
        } else {
            args.push("-b".into());
            args.push(slug.clone());
            args.push(wt_str.clone());
        }
        let status = std::process::Command::new("git").args(&args).status().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(format!("ensure_worktree: git worktree add failed for {repo} / {agent_id}"));
        }
        log::info!("ensure_worktree: {repo} agent {agent_id} → {wt_str}");
    }
    // Carry the planner's app-managed per-repo context into the worktree. CLAUDE.local.md
    // is UNTRACKED in the main clone (git-excluded), so a fresh worktree wouldn't have it —
    // refresh it every launch. Copy CLAUDE.md only when the worktree lacks one, so a
    // tracked/checked-out CLAUDE.md isn't clobbered.
    let local = clone.join("CLAUDE.local.md");
    if local.is_file() {
        let _ = std::fs::copy(&local, wt.join("CLAUDE.local.md"));
    }
    let claude_md = clone.join("CLAUDE.md");
    if claude_md.is_file() && !wt.join("CLAUDE.md").exists() {
        let _ = std::fs::copy(&claude_md, wt.join("CLAUDE.md"));
    }
    Ok(wt_str)
}

/// Append `entry` to a clone's `.git/info/exclude` (idempotent) so app-managed
/// files stay out of `git status`. No-op when `repo_root` is not a git repo.
fn git_exclude(repo_root: &std::path::Path, entry: &str) {
    if !repo_root.join(".git").exists() { return; }
    let exclude = repo_root.join(".git").join("info").join("exclude");
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry) { return; }
    let next = if existing.trim().is_empty() {
        format!("{}\n", entry)
    } else {
        format!("{}\n{}\n", existing.trim_end(), entry)
    };
    let _ = std::fs::write(&exclude, next);
}

/// Shell commands every spawned repo/console session auto-approves regardless of
/// the user's allowlist — the app's GitHub workflow (triage, publish, repo ops)
/// depends on them. `gh` is required by triage; `git` by every repo session.
const MANDATORY_BASH: &[&str] = &["gh", "git"];

/// Dangerous command patterns denied in every spawned session by default.
///
/// The session allows the Bash tool broadly so ordinary work — including loops
/// and `&&` / `|` compound commands — runs without a prompt ("start and go").
/// These guard against the most catastrophic *direct* invocations; deny takes
/// precedence over allow in Claude Code. Best-effort: prefix matching can't catch
/// a dangerous command nested inside a loop or pipe, so this raises the bar
/// against accidents, not a true sandbox. Users extend it from the Knowledge Base
/// → Commands section (the per-session `denied_commands`).
const DEFAULT_DENY: &[&str] = &[
    "Bash(sudo *)",
    "Bash(rm -rf /*)",
    "Bash(rm -fr /*)",
    "Bash(rm -rf ~*)",
    "Bash(dd *)",
    "Bash(mkfs *)",
    "Bash(shutdown *)",
    "Bash(reboot *)",
    "Bash(git push --force*)",
    "Bash(git push -f *)",
    "Bash(curl *| sh)",
    "Bash(curl *| bash)",
    "Bash(wget *| sh)",
];

/// One MCP server an extension contributes to a session's `.mcp.json`. Field names
/// match the frontend `McpServerPayload`.
#[derive(serde::Deserialize, Clone)]
struct McpServerCfg {
    name: String,
    transport: String, // "stdio" | "http"
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    env: Vec<(String, String)>,
}

/// One lifecycle hook an extension contributes to a session's settings.json.
#[derive(serde::Deserialize, Clone)]
struct HookCfg {
    event: String,   // PreToolUse | PostToolUse | …
    #[serde(default)]
    matcher: String, // optional tool matcher; empty = all
    command: String,
}

/// Ensure the claude session rooted at `cwd` can run shell commands without a
/// permission prompt while blocking dangerous ones, and apply the session's
/// extensions (MCP servers → `.mcp.json`, hooks → settings.json), by merging into
/// `<cwd>/.claude/settings.json` and `<cwd>/.mcp.json`.
/// Markers the GitHub-readiness probe echoes when each check passes (#297). Plain
/// `echo` tokens so parsing is a locale-independent substring match, not coupled to
/// gh/git output formatting.
const GH_PATH_MARK: &str = "BSC_GH_PATH_OK";
const GIT_PATH_MARK: &str = "BSC_GIT_PATH_OK";
const GH_AUTH_MARK: &str = "BSC_GH_AUTH_OK";

/// Parse the probe shell's stdout into `(gh_on_path, git_on_path, gh_authed)`. Pure.
fn parse_github_probe(stdout: &str) -> (bool, bool, bool) {
    (
        stdout.contains(GH_PATH_MARK),
        stdout.contains(GIT_PATH_MARK),
        stdout.contains(GH_AUTH_MARK),
    )
}

/// Probe whether a session shell can actually reach GitHub (#297): is `git`/`gh`
/// on PATH, and is `gh` authenticated. Fleet agents are told to push branches and
/// open PRs, but a spawned shell can silently lack the tools; this lets the pane
/// warn the user up front. Runs the checks through the SAME resolved shell and
/// caller env (e.g. `GH_TOKEN`) the agent's `bash -c` subshells inherit, via a
/// login shell (`-lc`) so login-profile PATH additions are reflected. Best-effort:
/// returns all-false on spawn failure rather than erroring, so the caller can still
/// surface an actionable warning. Field names match the frontend `GithubProbe`.
#[tauri::command]
async fn github_readiness(
    cwd: String,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<serde_json::Value, String> {
    let shell = resolve_shell();
    let script = format!(
        "command -v git >/dev/null 2>&1 && echo {GIT_PATH_MARK}; \
         command -v gh  >/dev/null 2>&1 && echo {GH_PATH_MARK}; \
         gh auth status >/dev/null 2>&1 && echo {GH_AUTH_MARK}",
    );
    let mut cmd = std::process::Command::new(&shell);
    cmd.arg("-lc").arg(&script);
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let env_map = env.unwrap_or_default();
    for (k, v) in session_env(&env_map) {
        cmd.env(k, v);
    }
    let (gh, git, auth) = match cmd.output() {
        Ok(out) => parse_github_probe(&String::from_utf8_lossy(&out.stdout)),
        Err(e) => {
            log::warn!("github_readiness probe failed to spawn ({shell}): {e}");
            (false, false, false)
        }
    };
    Ok(serde_json::json!({ "ghOnPath": gh, "gitOnPath": git, "ghAuthed": auth }))
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ensure_session_settings(
    cwd: String,
    allowed_commands: Vec<String>,
    denied_commands: Vec<String>,
    mcp_servers: Option<Vec<McpServerCfg>>,
    hooks: Option<Vec<HookCfg>>,
    allow_tool_rules: Option<Vec<String>>,
    deny_tool_rules: Option<Vec<String>>,
    ask_tool_rules: Option<Vec<String>>,
) -> Result<(), String> {
    write_session_settings(
        &cwd, &allowed_commands, &denied_commands,
        &mcp_servers.unwrap_or_default(), &hooks.unwrap_or_default(),
        &allow_tool_rules.unwrap_or_default(), &deny_tool_rules.unwrap_or_default(),
        &ask_tool_rules.unwrap_or_default(),
    )
}

/// Synchronous core of [`ensure_session_settings`] (testable without a runtime).
///
/// Security model: the session ALLOWS the Bash tool broadly so normal commands
/// (loops, pipes, `&&` chains) run without a prompt. A curated default deny-list
/// ({@link DEFAULT_DENY}) plus any user/project `denied_commands` block the most
/// dangerous direct invocations (deny wins over allow). The configured
/// `allowed_commands` are still written as explicit prefix rules — harmless under
/// the broad allow, and meaningful if "Bash" is ever removed to go strict.
/// Merges into existing settings rather than clobbering; `.claude/` stays out of
/// the repo's `git status`.
#[allow(clippy::too_many_arguments)]
fn write_session_settings(
    cwd: &str,
    allowed_commands: &[String],
    denied_commands: &[String],
    mcp_servers: &[McpServerCfg],
    hooks: &[HookCfg],
    allow_tool_rules: &[String],
    deny_tool_rules: &[String],
    ask_tool_rules: &[String],
) -> Result<(), String> {
    if cwd.is_empty() { return Ok(()); }
    let root = std::path::PathBuf::from(cwd);
    let settings_path = root.join(".claude").join("settings.json");

    let mut config: serde_json::Value = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !config.is_object() { config = serde_json::json!({}); }

    // Allow: the Bash tool broadly (start-and-go) + mandatory gh/git + each
    // configured command as an explicit prefix rule (deduped).
    let mut allow_rules: Vec<String> = vec!["Bash".to_string()];
    for c in MANDATORY_BASH.iter().map(|s| (*s).to_string())
        .chain(allowed_commands.iter().map(|c| c.trim().to_string()))
    {
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !allow_rules.contains(&r) { allow_rules.push(r); }
        }
    }

    // Deny: curated dangerous defaults + user/project denies (deny > allow).
    let mut deny_rules: Vec<String> = DEFAULT_DENY.iter().map(|s| (*s).to_string()).collect();
    for c in denied_commands {
        let c = c.trim();
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !deny_rules.contains(&r) { deny_rules.push(r); }
        }
    }

    // Tool-permission rules (verbatim, NOT Bash-wrapped) — the role write-path guard
    // passes `Edit(<glob>)` / `Write` / … here to scope or deny the file-write tools.
    for r in allow_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !allow_rules.contains(&r) { allow_rules.push(r); }
    }
    for r in deny_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !deny_rules.contains(&r) { deny_rules.push(r); }
    }

    // Ask: rules that PROMPT the user before the command (Claude Code precedence
    // deny > ask > allow, so a specific ask overrides the broad Bash allow). The
    // flow's hard push-confirm gate (#297) passes `Bash(git push *)` / `Bash(gh pr
    // create *)` here so pushes/PRs require approval instead of auto-running.
    let mut ask_rules: Vec<String> = Vec::new();
    for r in ask_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !ask_rules.contains(&r) { ask_rules.push(r); }
    }

    merge_permission_list(&mut config, "allow", &allow_rules);
    merge_permission_list(&mut config, "deny", &deny_rules);
    merge_permission_list(&mut config, "ask", &ask_rules);

    // Hooks → settings.json `hooks` (overwritten with the resolved set, so toggling
    // a hook extension off and relaunching drops it). MCP servers → `.mcp.json`,
    // auto-approved for autonomous sessions via `enabledMcpjsonServers` (exactly the
    // resolved set — servers not listed aren't trusted, which is how removal lands).
    write_session_hooks(&mut config, hooks);
    {
        let obj = config.as_object_mut().unwrap();
        if mcp_servers.is_empty() {
            obj.remove("enabledMcpjsonServers");
        } else {
            obj.insert(
                "enabledMcpjsonServers".into(),
                serde_json::Value::Array(
                    mcp_servers.iter().map(|m| serde_json::Value::String(m.name.clone())).collect(),
                ),
            );
        }
    }

    std::fs::create_dir_all(root.join(".claude")).map_err(|e| e.to_string())?;
    std::fs::write(
        &settings_path,
        serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?,
    ).map_err(|e| e.to_string())?;
    write_mcp_json(&root, mcp_servers)?;
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}

/// Overwrite `config.hooks` with the resolved hooks, grouped by event:
/// `{event: [{matcher?, hooks: [{type:"command", command}]}]}`. Empty → key removed.
fn write_session_hooks(config: &mut serde_json::Value, hooks: &[HookCfg]) {
    let obj = config.as_object_mut().unwrap();
    if hooks.is_empty() { obj.remove("hooks"); return; }
    let mut by_event = serde_json::Map::new();
    for h in hooks {
        let inner = serde_json::json!({ "type": "command", "command": h.command });
        let entry = if h.matcher.is_empty() {
            serde_json::json!({ "hooks": [inner] })
        } else {
            serde_json::json!({ "matcher": h.matcher, "hooks": [inner] })
        };
        by_event
            .entry(h.event.clone())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut().unwrap()
            .push(entry);
    }
    obj.insert("hooks".into(), serde_json::Value::Object(by_event));
}

/// Merge the resolved MCP servers into `<cwd>/.mcp.json` by name (preserving any
/// repo-authored entries). Skips entirely when there are none and no file exists.
/// `enabledMcpjsonServers` in settings.json gates which are actually active.
fn write_mcp_json(root: &std::path::Path, mcp_servers: &[McpServerCfg]) -> Result<(), String> {
    let path = root.join(".mcp.json");
    if mcp_servers.is_empty() && !path.exists() { return Ok(()); }
    let mut doc: serde_json::Value = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}));
    if !doc.is_object() { doc = serde_json::json!({}); }
    let servers = doc.as_object_mut().unwrap()
        .entry("mcpServers").or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() { *servers = serde_json::json!({}); }
    let smap = servers.as_object_mut().unwrap();
    for m in mcp_servers {
        smap.insert(m.name.clone(), mcp_server_value(m));
    }
    std::fs::write(&path, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

/// One MCP server's `.mcp.json` value: stdio `{command,args,env?}` or http `{type,url}`.
fn mcp_server_value(m: &McpServerCfg) -> serde_json::Value {
    if m.transport == "http" {
        return serde_json::json!({ "type": "http", "url": m.url.clone().unwrap_or_default() });
    }
    let mut v = serde_json::Map::new();
    v.insert("command".into(), serde_json::Value::String(m.command.clone().unwrap_or_default()));
    v.insert("args".into(), serde_json::Value::Array(
        m.args.iter().map(|a| serde_json::Value::String(a.clone())).collect(),
    ));
    let env: serde_json::Map<String, serde_json::Value> = m.env.iter()
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, val)| (k.clone(), serde_json::Value::String(val.clone())))
        .collect();
    if !env.is_empty() { v.insert("env".into(), serde_json::Value::Object(env)); }
    serde_json::Value::Object(v)
}

/// Merge `rules` into `config.permissions.<key>` (an array), preserving existing
/// entries and order, deduped. Creates the objects/array as needed.
fn merge_permission_list(config: &mut serde_json::Value, key: &str, rules: &[String]) {
    let obj = config.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
    if !permissions.is_object() { *permissions = serde_json::json!({}); }
    let perm_obj = permissions.as_object_mut().unwrap();
    let list = perm_obj.entry(key).or_insert_with(|| serde_json::json!([]));
    if !list.is_array() { *list = serde_json::json!([]); }
    let arr = list.as_array_mut().unwrap();
    let mut seen: std::collections::HashSet<String> =
        arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    for r in rules {
        if seen.insert(r.clone()) { arr.push(serde_json::Value::String(r.clone())); }
    }
}

/// Reads plan section files from the project hub. They live FLAT in
/// `projects/<key>/<section>.{md|json}` (no `plans/` subdir).
/// Returns a map of section key → file content for every file that exists and
/// is non-empty. Callers poll this on a short interval to pick up sections that
/// Claude writes via its Write tool (more reliable than parsing PTY output).
#[tauri::command]
async fn read_plan_sections(project_key: String) -> Result<std::collections::HashMap<String, String>, String> {
    let _perf = PerfSpan::new("read_plan_sections");
    let safe_key  = sanitize_project_key(&project_key);
    if safe_key.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let plans_dir = plan_dir_for(&project_key);
    if !plans_dir.exists() {
        return Ok(std::collections::HashMap::new());
    }
    // Dynamic: every non-empty .md/.json section file the planner wrote, keyed by
    // file stem, excluding the workspace control files. Lets the planner document
    // any topic (guided-dynamic sections) with no fixed key list. `_skipped` (the
    // considered-but-skipped record) and `phases` (.json roadmap) ride along and
    // are handled specially by the UI.
    const CONTROL: &[&str] = &["CLAUDE.md", "kb_index.md", "automations.md", "github_context.md"];
    let mut sections = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&plans_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() { continue; }
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if CONTROL.contains(&name) { continue; }
            if !matches!(path.extension().and_then(|e| e.to_str()), Some("md") | Some("json")) { continue; }
            if let (Some(stem), Ok(content)) =
                (path.file_stem().and_then(|s| s.to_str()), std::fs::read_to_string(&path))
            {
                let content = content.trim().to_string();
                if !content.is_empty() {
                    sections.insert(stem.to_string(), content);
                }
            }
        }
    }
    Ok(sections)
}

// ── Document store listing ──────────────────────────────────────────────────
//
// The KB page enumerates three kinds of markdown across the on-disk layout:
//   - "reusable" — the flat library under `documents/**`
//   - "project"  — a project hub's own files under `projects/<p>/` (+ prompts/)
//   - "repo"     — only the managed CLAUDE.md / CLAUDE.local.md inside a clone
// `list_documents` walks the tree via `collect_documents`; per-document metadata
// (title, tags) is parsed from the same YAML-ish frontmatter setup_workspaces
// writes (`id`, `title`, `tags`).

/// Metadata for one markdown document surfaced to the KB page. Serialized to the
/// frontend with snake_case field names (Tauri's serde passes them through as-is).
#[derive(serde::Serialize)]
struct DocInfo {
    /// Posix path relative to `bsc_base_dir()` (forward slashes on every OS) so
    /// the frontend can pass it straight back to `read_document`/`write_document`.
    relpath:       String,
    /// File name including extension (e.g. `goal.md`).
    name:          String,
    /// Frontmatter `title:` if present, otherwise the file-name stem.
    title:         String,
    /// Taxonomy bucket: "reusable", "project", or "repo".
    kind:          String,
    /// Project key (the `projects/<proj>` segment) for "project" and "repo" kinds.
    project:       Option<String>,
    /// Repo short name (the `projects/<proj>/<repo>` segment) for the "repo" kind.
    repo:          Option<String>,
    /// Frontmatter `tags:` list, empty when absent.
    tags:          Vec<String>,
    size_bytes:    u64,
    modified_secs: u64,
}

/// Extracts `title` and `tags` from a document's leading YAML-ish frontmatter
/// block (a `---` fenced header as written by setup_workspaces). Returns
/// `(title, tags)` with `title` empty when no `title:` line is present so the
/// caller can fall back to the file-name stem. Best-effort and tolerant of
/// documents that have no frontmatter at all.
fn parse_frontmatter(content: &str) -> (String, Vec<String>) {
    let mut title = String::new();
    let mut tags: Vec<String> = Vec::new();
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (title, tags);
    }
    // Take the lines between the opening `---` and the next `---`.
    let mut lines = trimmed.lines();
    lines.next(); // opening fence
    for line in lines {
        let line = line.trim();
        if line == "---" {
            break;
        }
        if let Some(rest) = line.strip_prefix("title:") {
            title = rest.trim().to_string();
        } else if let Some(rest) = line.strip_prefix("tags:") {
            // Accept either `[a, b]` or a bare comma list.
            let rest = rest.trim().trim_start_matches('[').trim_end_matches(']');
            tags = rest
                .split(',')
                .map(|t| t.trim().trim_matches('"').trim().to_string())
                .filter(|t| !t.is_empty())
                .collect();
        }
    }
    (title, tags)
}

/// Builds a `DocInfo` for `path` whose store-relative posix `relpath` and
/// `kind`/`project`/`repo` taxonomy are already known. Returns `None` if the file
/// is missing or its metadata can't be read.
fn doc_info_for(
    path: &std::path::Path,
    relpath: String,
    kind: &str,
    project: Option<String>,
    repo: Option<String>,
) -> Option<DocInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let file_name = path.file_name().and_then(|n| n.to_str())?.to_string();
    let modified_secs = meta.modified().ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let (fm_title, tags) = parse_frontmatter(&content);
    // settings.json carries no frontmatter — give it a stable display title.
    let title = if file_name == "settings.json" {
        "settings.json".to_string()
    } else if fm_title.is_empty() {
        path.file_stem().and_then(|s| s.to_str()).unwrap_or(&file_name).to_string()
    } else {
        fm_title
    };
    Some(DocInfo {
        relpath,
        name: file_name,
        title,
        kind: kind.to_string(),
        project,
        repo,
        tags,
        size_bytes: meta.len(),
        modified_secs,
    })
}

/// Recursively pushes every `.md` file under `dir` into `out` with the given
/// `kind`/`project`, computing each one's posix relpath against `base`.
/// `.claude/` directories are not descended into (their settings.json is added
/// explicitly by the caller).
fn collect_md_tree(
    base: &std::path::Path,
    dir: &std::path::Path,
    kind: &str,
    project: &Option<String>,
    out: &mut Vec<DocInfo>,
) {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = match std::fs::read_dir(&d) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if path.is_dir() {
                if name == ".claude" {
                    continue; // settings.json handled explicitly
                }
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if let Some(rel) = relpath_posix(base, &path) {
                if let Some(info) = doc_info_for(&path, rel, kind, project.clone(), None) {
                    out.push(info);
                }
            }
        }
    }
}

/// Posix-joined path of `path` relative to `base`, or `None` if `path` is not
/// under `base`.
fn relpath_posix(base: &std::path::Path, path: &std::path::Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    Some(
        rel.iter()
            .filter_map(|s| s.to_str())
            .collect::<Vec<_>>()
            .join("/"),
    )
}

/// Collects every surfaced document under `base` (= `bsc_base_dir()`):
///   - `documents/**/*.md`                                   → kind "reusable"
///   - `documents/.claude/settings.json`                     → kind "reusable"
///   - `projects/<p>/*.md`, `projects/<p>/prompts/**/*.md`   → kind "project"
///   - `projects/<p>/.claude/settings.json`                  → kind "project"
///   - `projects/<p>/<repo>/{CLAUDE.md,CLAUDE.local.md}`     → kind "repo"
///   - `projects/<p>/<repo>/.claude/settings.json`           → kind "repo"
///
/// A `projects/<p>/<repo>/` subdir is treated as a repo clone (kind "repo") iff
/// it contains a `.git` entry; only its managed files are surfaced — the clone's
/// source tree is never recursed. Sorted most-recently-modified first.
/// Factored out of the command so it can be unit-tested against a temp tree.
fn collect_documents(base: &std::path::Path) -> Vec<DocInfo> {
    let mut out: Vec<DocInfo> = Vec::new();

    // 1. Flat reusable library: documents/**/*.md (+ its .claude/settings.json).
    let docs = base.join("documents");
    if docs.is_dir() {
        collect_md_tree(base, &docs, "reusable", &None, &mut out);
        let settings = docs.join(".claude").join("settings.json");
        if let Some(rel) = relpath_posix(base, &settings) {
            if let Some(info) = doc_info_for(&settings, rel, "reusable", None, None) {
                out.push(info);
            }
        }
    }

    // 2. Project hubs: projects/<p>/.
    let projects = base.join("projects");
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let pdir = entry.path();
            if !pdir.is_dir() {
                continue;
            }
            let pname = match pdir.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let proj = Some(pname.clone());

            // Project-level *.md sitting directly in the hub.
            if let Ok(items) = std::fs::read_dir(&pdir) {
                for item in items.flatten() {
                    let path = item.path();
                    if path.is_file()
                        && path.extension().and_then(|e| e.to_str()) == Some("md")
                    {
                        if let Some(rel) = relpath_posix(base, &path) {
                            if let Some(info) =
                                doc_info_for(&path, rel, "project", proj.clone(), None)
                            {
                                out.push(info);
                            }
                        }
                    }
                }
            }

            // Project prompts/ subtree.
            let prompts = pdir.join("prompts");
            if prompts.is_dir() {
                collect_md_tree(base, &prompts, "project", &proj, &mut out);
            }

            // Project .claude/settings.json.
            let psettings = pdir.join(".claude").join("settings.json");
            if let Some(rel) = relpath_posix(base, &psettings) {
                if let Some(info) =
                    doc_info_for(&psettings, rel, "project", proj.clone(), None)
                {
                    out.push(info);
                }
            }

            // Repo clones: subdirs that contain a `.git` entry. Surface only the
            // managed CLAUDE.md / CLAUDE.local.md plus .claude/settings.json.
            if let Ok(subs) = std::fs::read_dir(&pdir) {
                for sub in subs.flatten() {
                    let rdir = sub.path();
                    if !rdir.is_dir() {
                        continue;
                    }
                    let rname = match rdir.file_name().and_then(|n| n.to_str()) {
                        Some(n) => n.to_string(),
                        None => continue,
                    };
                    if rname == ".claude" || rname == "prompts" {
                        continue;
                    }
                    if !rdir.join(".git").exists() {
                        continue; // not a clone — skip (don't recurse its tree)
                    }
                    let repo = Some(rname.clone());
                    for managed in ["CLAUDE.md", "CLAUDE.local.md"] {
                        let path = rdir.join(managed);
                        if path.is_file() {
                            if let Some(rel) = relpath_posix(base, &path) {
                                if let Some(info) = doc_info_for(
                                    &path, rel, "repo", proj.clone(), repo.clone(),
                                ) {
                                    out.push(info);
                                }
                            }
                        }
                    }
                    let rsettings = rdir.join(".claude").join("settings.json");
                    if let Some(rel) = relpath_posix(base, &rsettings) {
                        if let Some(info) =
                            doc_info_for(&rsettings, rel, "repo", proj.clone(), repo.clone())
                        {
                            out.push(info);
                        }
                    }
                }
            }
        }
    }

    out.sort_by_key(|d| std::cmp::Reverse(d.modified_secs));
    out
}

/// Absolute path of the base-studio-code data dir, so the frontend can build
/// project/repo session paths: `<base>/projects/<sanitized project>/<repo>`.
#[tauri::command]
fn get_base_dir() -> String {
    bsc_base_dir().to_string_lossy().into_owned()
}

/// Lists every surfaced markdown/settings document across the reusable library
/// (`documents/`), the project hubs (`projects/<p>/`), and the managed files in
/// each project's repo clones. Sorted most-recently-modified first.
#[tauri::command]
async fn list_documents() -> Result<Vec<DocInfo>, String> {
    let _perf = PerfSpan::new("list_documents");
    Ok(collect_documents(&bsc_base_dir()))
}

/// Validates a base-relative posix path for read/write: rejects `..` segments,
/// rejects absolute paths, and only permits paths under `documents/` or
/// `projects/`. Returns the resolved absolute path on success.
fn resolve_store_path(relpath: &str) -> Result<std::path::PathBuf, String> {
    if relpath.contains("..") {
        return Err("invalid relpath: contains '..'".to_string());
    }
    let normalized = relpath.replace('\\', "/");
    // Reject absolute paths (unix `/x`, windows `C:/x` or `\\server`).
    let is_absolute = normalized.starts_with('/')
        || std::path::Path::new(relpath).is_absolute()
        || (normalized.len() >= 2 && normalized.as_bytes()[1] == b':');
    if is_absolute {
        return Err("invalid relpath: must be relative".to_string());
    }
    if !(normalized.starts_with("documents/") || normalized.starts_with("projects/")) {
        return Err("invalid relpath: must begin with documents/ or projects/".to_string());
    }
    Ok(bsc_base_dir().join(relpath))
}

/// Reads one document by its base-relative posix path (as returned in
/// `DocInfo::relpath`). Path must be under `documents/` or `projects/` and must
/// not contain `..` (see [`resolve_store_path`]).
#[tauri::command]
async fn read_document(relpath: String) -> Result<String, String> {
    let path = resolve_store_path(&relpath)?;
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Writes `content` to a document at its base-relative posix path, creating
/// parent directories as needed. Same path guards as [`read_document`].
#[tauri::command]
async fn write_document(relpath: String, content: String) -> Result<(), String> {
    let path = resolve_store_path(&relpath)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Writes a comprehensive project plan markdown file to `.claude/project-plan.md`
/// inside each linked repository. Console Claude sessions can `Read` this file
/// to get full project context without needing to ask the user for it.
#[tauri::command]
async fn write_project_plan(content: String, repo_paths: Vec<String>) -> Result<(), String> {
    for path in &repo_paths {
        let claude_dir = std::path::PathBuf::from(path).join(".claude");
        std::fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
        std::fs::write(claude_dir.join("project-plan.md"), &content)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Entry point ───────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // rustls 0.23 can't auto-determine a CryptoProvider from features at runtime, so
    // the relay dial's TLS handshake (tokio-tungstenite) would panic the tunnel thread
    // ("could not automatically determine the process-level CryptoProvider"). Install
    // `ring` explicitly before any TLS; Err just means one is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                // Keep noisy dependencies (tauri/wry/reqwest) quiet — only warnings
                // and above — while showing our own app logs at info. A global Info
                // filter floods stdout+file from deps and can stall the UI.
                .level(log::LevelFilter::Warn)
                .level_for("base_studio_code_lib", log::LevelFilter::Info)
                .format(|out, message, record| {
                    let ts = time::OffsetDateTime::now_utc()
                        .format(&time::macros::format_description!("[hour]:[minute]:[second]"))
                        .unwrap_or_default();
                    out.finish(format_args!(
                        "\x1b[90m{ts}\x1b[0m {color}{level:<5}\x1b[0m \x1b[90m{target}\x1b[0m {message}",
                        color = level_color(record.level()),
                        level = record.level(),
                        target = record.target(),
                    ));
                })
                .targets([
                    // Visible in the `tauri dev` terminal…
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    // …and persisted to a rotating file in the app log dir.
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir {
                        file_name: Some("base-studio-code".into()),
                    }),
                ])
                .build(),
        )
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(PtyState(Mutex::new(HashMap::new())))
        .manage(tunnel::TunnelState::new())
        .invoke_handler(tauri::generate_handler![
            kb_chat,
            github_request,
            github_cache_clear,
            github_graphql,
            github_post,
            pty_create,
            pty_write,
            pty_broadcast,
            pty_resize,
            pty_kill,
            pick_directory,
            setup_workspaces,
            setup_kb_workspace,
            clone_repo,
            ensure_worktree,
            get_base_dir,
            read_claude_config,
            write_claude_config,
            ensure_session_settings,
            github_readiness,
            read_plan_sections,
            write_project_plan,
            delete_project_dir,
            list_documents,
            read_document,
            write_document,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status,
            tunnel::tunnel_set_panes,
            tunnel::tunnel_set_sessions,
            read_audit_log,
            read_coord_log,
            append_coord_woke,
            read_git_hooks,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Drain PtyState on app exit so the OS reclaims every shell + its
        // descendants (`claude`, `gh`, `git`, MCP children) before the process
        // dies. Without this, closing the app window left ~28 orphan
        // `bash`/`claude`/WebView children holding cwd locks on
        // `~/.base-studio-code` (#52).
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                // Signal the tunnel transport (#242b) to close before tearing down PTYs.
                app_handle.state::<tunnel::TunnelState>().shutdown();
                kill_all_pty_sessions(app_handle.state::<PtyState>().inner());
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn parse_hooks_path_reads_core_hookspath() {
        assert_eq!(
            super::parse_hooks_path("[core]\n\trepositoryformatversion = 0\n\thooksPath = .githooks\n"),
            Some(".githooks".to_string())
        );
        assert_eq!(super::parse_hooks_path("[core]\n\tbare = false\n"), None);
    }

    #[test]
    fn read_git_hooks_reports_active_hooks_and_skips_samples() {
        let dir = std::env::temp_dir().join(format!("bsc-hooks-{}", std::process::id()));
        let hooks = dir.join(".git").join("hooks");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&hooks).unwrap();
        std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\n# header\ncargo fmt --check\n").unwrap();
        std::fs::write(hooks.join("pre-push.sample"), "#!/bin/sh\necho sample\n").unwrap();

        let out = super::read_git_hooks(dir.to_string_lossy().to_string());
        let pre_commit = out.iter().find(|h| h.name == "pre-commit").unwrap();
        assert!(pre_commit.active);
        assert_eq!(pre_commit.preview, "cargo fmt --check"); // shebang + comment skipped
        assert_eq!(pre_commit.source, ".git/hooks");
        // The `.sample` doesn't make pre-push active.
        assert!(!out.iter().find(|h| h.name == "pre-push").unwrap().active);

        // A path with no .git → empty.
        assert!(super::read_git_hooks(dir.join("nope").to_string_lossy().to_string()).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pane_id_format_matches_frontend_convention() {
        // The frontend uses `t${tabIdx}p${paneIdx}` as the pane ID key.
        // Verify the format matches for several indices.
        assert_eq!(format!("t{}p{}", 0, 0), "t0p0");
        assert_eq!(format!("t{}p{}", 1, 3), "t1p3");
        assert_eq!(format!("t{}p{}", 2, 8), "t2p8");
    }

    #[test]
    fn osc7_path_strip_removes_scheme_and_host() {
        // Mirrors what TerminalView.tsx does in the browser:
        // data.replace(/^file:\/\/[^/]*/, "")
        let input = "file://localhost/c/Users/Kevin/project";
        let stripped = input.trim_start_matches("file://").split_once('/')
            .map(|(_, rest)| format!("/{}", rest))
            .unwrap_or_default();
        assert_eq!(stripped, "/c/Users/Kevin/project");
    }

    use super::{bash_ansi_c_quote, sanitize_project_key, claude_launch, claude_project_dir_name};
    use super::session_env;
    use super::{cache_is_fresh, apply_github_response, CachedGet};
    #[cfg(windows)]
    use super::PtyJob;
    use std::collections::HashMap;

    /// Loadbearing claim of the orphan-kill fix: dropping the job handle kills
    /// every assigned process (and its descendants). Spawn a ~30 s `ping` —
    /// without the kill we'd hit the deadline; with it the process exits in
    /// milliseconds. Windows-only; the Unix branch is a no-op stub (#118).
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

        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => panic!("try_wait failed: {e}"),
            }
        }
        let _ = child.kill();
        panic!("ping survived 2s after job drop — kill-on-close not effective");
    }

    #[test]
    fn cache_is_fresh_only_within_max_age_and_never_when_forced() {
        use std::time::Duration;
        // No max_age → always revalidate (cheap conditional request).
        assert!(!cache_is_fresh(Duration::from_secs(0), None, false));
        // Within / beyond the max_age window.
        assert!(cache_is_fresh(Duration::from_secs(10), Some(60), false));
        assert!(!cache_is_fresh(Duration::from_secs(120), Some(60), false));
        // force always revalidates, even when otherwise fresh.
        assert!(!cache_is_fresh(Duration::from_secs(1), Some(60), true));
    }

    #[test]
    fn apply_github_response_stores_on_200_and_reuses_on_304() {
        let mut cache: HashMap<String, CachedGet> = HashMap::new();

        // 200: stores the body + etag and returns it.
        let body = serde_json::json!({ "n": 1 });
        let out = apply_github_response(&mut cache, "repos/x", false, Some("etag-1".into()), Some(body.clone()));
        assert_eq!(out.as_ref(), Some(&body));
        assert_eq!(cache.get("repos/x").unwrap().etag.as_deref(), Some("etag-1"));

        // 304: returns the cached body without a new body.
        let reused = apply_github_response(&mut cache, "repos/x", true, None, None);
        assert_eq!(reused.as_ref(), Some(&body));

        // 304 with no cached entry → None (caller errors).
        assert_eq!(apply_github_response(&mut cache, "repos/missing", true, None, None), None);
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
    fn ansi_c_quote_wraps_plain_text() {
        assert_eq!(bash_ansi_c_quote("triage the issues"), "$'triage the issues'");
    }

    #[test]
    fn claude_launch_bakes_prompt_fresh() {
        assert_eq!(claude_launch("triage the issues", false), "claude $'triage the issues'");
    }

    #[test]
    fn claude_launch_adds_continue_flag() {
        // Triage resumes the repo's prior conversation instead of starting fresh.
        assert_eq!(claude_launch("triage the issues", true), "claude --continue $'triage the issues'");
    }

    #[test]
    fn bsc_checkpoint_rc_defines_hyphenated_helper_reading_the_doc_var() {
        // The helper keeps its hyphenated, user-facing name (so it can't be exported
        // into subshells — it must be *defined* via the rc file) and writes whatever
        // it gets on stdin to the doc named by $BSC_CHECKPOINT_DOC.
        let rc = super::BSC_CHECKPOINT_RC;
        assert!(rc.contains("bsc-checkpoint()"), "rc must define the hyphenated helper");
        assert!(rc.contains("$BSC_CHECKPOINT_DOC"), "rc must target the doc env var");
        assert!(rc.contains("mkdir -p"), "rc must create the doc's parent dir");
    }

    #[test]
    fn bsc_checkpoint_helper_runs_in_a_fresh_non_interactive_subshell() {
        // Regression: the helper was only defined in the interactive PTY shell, so the
        // agent's own `bash -c` subprocesses (Claude's Bash tool) couldn't find it.
        // The rc file + BASH_ENV mechanism must make a fresh, non-interactive bash able
        // to run `bsc-checkpoint` and write the doc. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        // Resolve the SAME shell the PTY launches (Git Bash on Windows, never the WSL
        // System32 stub — which can't read a /c/... BASH_ENV path). A bare `bash` would
        // resolve via PATH and may hit that stub, failing for reasons unrelated to the fix.
        let shell = super::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_checkpoint subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-ckpt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_CHECKPOINT_RC).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the doc's parent.
        let doc = dir.join("nested").join("checkpoint.md");

        let rc_bash = super::to_bash_path(&rc.to_string_lossy());
        let doc_bash = super::to_bash_path(&doc.to_string_lossy());

        let mut child = Command::new(&shell)
            .arg("-c")
            .arg("bsc-checkpoint")
            .env("BASH_ENV", &rc_bash)
            .env("BSC_CHECKPOINT_DOC", &doc_bash)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"left off: step 3\n").unwrap();
        assert!(child.wait().unwrap().success(), "bsc-checkpoint should run in the subshell");

        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "left off: step 3\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_decisions_rc_defines_note_and_blocked_helpers() {
        // The fleet assume-and-log helpers keep their hyphenated names (defined via the
        // rc file, like bsc-checkpoint) and append to the doc named by the env var.
        let rc = super::BSC_DECISIONS_RC;
        assert!(rc.contains("bsc-note()"), "rc must define bsc-note");
        assert!(rc.contains("bsc-blocked()"), "rc must define bsc-blocked");
        assert!(rc.contains("BSC_DECISIONS_DOC"), "helpers must target the decisions doc env var");
    }

    #[test]
    fn full_bsc_rc_is_syntactically_valid_bash() {
        // Regression for the rc-glue bug: every rc constant must end with a newline so the
        // bsc-env.sh that pty_create writes keeps each helper on its own line. A missing
        // trailing newline glues two functions (`}bsc-audit()`) and bash reports "unexpected
        // end of file", breaking every agent subshell. `bash -n` over the FULL concatenation
        // (the exact format! pty_create uses) catches it; per-constant tests do not.
        use std::process::{Command, Stdio};
        let shell = super::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping full-rc syntax test: no usable bash ({shell})");
            return;
        }
        let rc_body = format!(
            "{}{}{}{}{}",
            super::BSC_CHECKPOINT_RC,
            super::BSC_DECISIONS_RC,
            super::BSC_AUDIT_RC,
            super::BSC_CONFINE_RC,
            super::BSC_COORD_EMIT_RC,
        );
        let dir = std::env::temp_dir().join(format!("bsc-rc-syntax-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, &rc_body).unwrap();
        let rc_bash = super::to_bash_path(&rc.to_string_lossy());
        let out = Command::new(&shell).arg("-n").arg(&rc_bash).stderr(Stdio::piped()).output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            out.status.success(),
            "generated bsc-env.sh has a bash syntax error:
{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn bsc_note_appends_bulleted_lines_in_a_fresh_non_interactive_subshell() {
        // Like bsc-checkpoint, bsc-note must work from the agent's own `bash -c`
        // subshells via the rc file + BASH_ENV. Each call APPENDS one bulleted line read
        // from stdin to $BSC_DECISIONS_DOC. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = super::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_note subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-note-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        // The installed rc is the checkpoint + decisions helpers concatenated.
        std::fs::write(&rc, format!("{}{}", super::BSC_CHECKPOINT_RC, super::BSC_DECISIONS_RC)).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the doc's parent.
        let doc = dir.join("nested").join("DECISIONS.md");

        let rc_bash = super::to_bash_path(&rc.to_string_lossy());
        let doc_bash = super::to_bash_path(&doc.to_string_lossy());

        let run = |msg: &str| {
            let mut child = Command::new(&shell)
                .arg("-c").arg("bsc-note")
                .env("BASH_ENV", &rc_bash)
                .env("BSC_DECISIONS_DOC", &doc_bash)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.take().unwrap().write_all(msg.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success(), "bsc-note should run in the subshell");
        };
        run("chose cursor pagination");
        run("used JWT for auth");

        assert_eq!(
            std::fs::read_to_string(&doc).unwrap(),
            "- chose cursor pagination\n- used JWT for auth\n",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn worktree_slug_keeps_only_branch_safe_chars() {
        // The slug doubles as a git branch name + worktree dir, and must match the
        // frontend `worktreeSlug` (replace anything outside [A-Za-z0-9._-] with '-').
        assert_eq!(super::worktree_slug("auth-ui"), "auth-ui");
        assert_eq!(super::worktree_slug("a.b_c-d"), "a.b_c-d");
        assert_eq!(super::worktree_slug("API client/2"), "API-client-2");
    }

    #[test]
    fn claude_project_dir_name_replaces_non_alnum_with_dash() {
        // Matches the dir Claude Code creates under ~/.claude/projects.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\Projects\rust\base-studio-code"),
            "C--Users-Kevin-Projects-rust-base-studio-code"
        );
        // Consecutive specials (\ then .) each map to their own dash.
        assert_eq!(
            claude_project_dir_name(r"C:\Users\Kevin\.base-studio-code\documents"),
            "C--Users-Kevin--base-studio-code-documents"
        );
    }

    #[cfg(windows)]
    #[test]
    fn bash_in_roots_checks_bin_then_usr_bin() {
        use std::path::PathBuf;
        let roots = vec![PathBuf::from(r"C:\Program Files\Git")];
        let bin = r"C:\Program Files\Git\bin\bash.exe";
        let usr = r"C:\Program Files\Git\usr\bin\bash.exe";
        // bin\bash.exe wins when present.
        assert_eq!(super::bash_in_roots(&roots, &|p| p.to_string_lossy() == bin).as_deref(), Some(bin));
        // falls through to usr\bin\bash.exe.
        assert_eq!(super::bash_in_roots(&roots, &|p| p.to_string_lossy() == usr).as_deref(), Some(usr));
        // nothing found.
        assert_eq!(super::bash_in_roots(&roots, &|_| false), None);
    }

    #[test]
    fn ansi_c_quote_escapes_newlines_quotes_and_backslashes() {
        // Newlines collapse to \n so the whole token stays on one physical line;
        // single quotes and backslashes are escaped. $ and backticks pass through
        // literally (ANSI-C quoting does not expand them).
        assert_eq!(
            bash_ansi_c_quote("line1\nit's $HOME `cmd` \\x"),
            "$'line1\\nit\\'s $HOME `cmd` \\\\x'"
        );
    }

    #[test]
    fn parse_github_probe_detects_each_marker_independently() {
        use super::{GH_AUTH_MARK, GH_PATH_MARK, GIT_PATH_MARK};
        // All three markers present -> (gh, git, auth) all true.
        let all = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
{GH_AUTH_MARK}
");
        assert_eq!(super::parse_github_probe(&all), (true, true, true));
        // Empty output (probe found nothing) -> all false.
        assert_eq!(super::parse_github_probe(""), (false, false, false));
        // git on PATH but gh missing -> gh false, git true, auth false.
        let git_only = format!("{GIT_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&git_only), (false, true, false));
        // gh present but unauthenticated -> gh true, git true, auth false.
        let no_auth = format!("{GIT_PATH_MARK}
{GH_PATH_MARK}
");
        assert_eq!(super::parse_github_probe(&no_auth), (true, true, false));
    }

    #[test]
    fn ensure_session_settings_merges_mandatory_and_custom_commands() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-{}", std::process::id()));
        let settings = dir.join(".claude").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        // Seed an existing setting that must be preserved (not clobbered).
        std::fs::write(
            &settings,
            r#"{"model":"claude-sonnet-4-6","permissions":{"allow":["Read"],"deny":["WebSearch"]}}"#,
        ).unwrap();

        write_session_settings(
            &dir.to_string_lossy(),
            &["cargo".into(), "git".into()],
            &["scp".into()],
            &[],
            &[],
            &[],
            &[],
            &[],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Pre-existing entries are preserved (merged, not clobbered).
        assert!(allow.contains(&"Read".to_string()));
        assert!(deny.contains(&"WebSearch".to_string()));
        assert_eq!(v["model"], "claude-sonnet-4-6");
        // Bash is allowed broadly (start-and-go) plus explicit gh/git/custom rules.
        assert!(allow.contains(&"Bash".to_string()));
        assert!(allow.contains(&"Bash(gh *)".to_string()));
        assert!(allow.contains(&"Bash(git *)".to_string()));
        assert!(allow.contains(&"Bash(cargo *)".to_string()));
        assert_eq!(allow.iter().filter(|r| *r == "Bash(git *)").count(), 1);
        // Curated dangerous defaults plus the user deny are present.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(rm -rf /*)".to_string()));
        assert!(deny.contains(&"Bash(scp *)".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_ask_tier_for_hard_push_gate() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-ask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // A hard push-confirm flow (#297) asks before push/PR: the rules land in
        // permissions.ask (deny > ask > allow), so they prompt under the broad Bash allow.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let ask: Vec<String> = v["permissions"]["ask"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(ask.contains(&"Bash(git push *)".to_string()));
        assert!(ask.contains(&"Bash(gh pr create *)".to_string()));
        // Bash stays broadly allowed; ask only narrows the two push writes.
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow.contains(&"Bash".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_merges_verbatim_tool_rules() {
        use super::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The role write-path guard: deny every write tool (planner/director/triage),
        // and auto-approve a worker's boundary glob.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &["Edit(src/auth/**)".into(), "Write(src/auth/**)".into()],
            &["Edit".into(), "Write".into(), "MultiEdit".into(), "NotebookEdit".into()],
            &[],
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(allow.contains(&"Write(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
        assert!(deny.contains(&"MultiEdit".to_string()));
        assert!(deny.contains(&"NotebookEdit".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_mcp_servers_and_hooks() {
        let dir = std::env::temp_dir().join(format!("bsc-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mcp = vec![
            super::McpServerCfg {
                name: "filesystem".into(), transport: "stdio".into(),
                command: Some("npx".into()), args: vec!["-y".into(), "@mcp/fs".into()],
                url: None, env: vec![("ROOT".into(), "/tmp".into())],
            },
            super::McpServerCfg {
                name: "sentry".into(), transport: "http".into(),
                command: None, args: vec![], url: Some("https://mcp.sentry.dev/sse".into()), env: vec![],
            },
        ];
        let hooks = vec![super::HookCfg {
            event: "PostToolUse".into(), matcher: "Write|Edit".into(), command: "format.sh".into(),
        }];
        super::write_session_settings(&dir.to_string_lossy(), &[], &[], &mcp, &hooks, &[], &[], &[]).unwrap();

        // .mcp.json carries both servers in the right transport shapes.
        let mcp_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["args"][1], "@mcp/fs");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["env"]["ROOT"], "/tmp");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["type"], "http");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["url"], "https://mcp.sentry.dev/sse");

        // settings.json gates the servers + carries the hook grouped by event.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let enabled: Vec<String> = settings["enabledMcpjsonServers"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(enabled.contains(&"filesystem".to_string()) && enabled.contains(&"sentry".to_string()));
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Write|Edit");
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "format.sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_preserves_ascii_alphanumerics_and_dash() {
        assert_eq!(sanitize_project_key("my-project-123"), "my-project-123");
    }

    #[test]
    fn sanitize_replaces_punctuation_and_whitespace_with_underscore() {
        // Slashes, spaces, colons, dots → '_'.
        assert_eq!(sanitize_project_key("acme/api"), "acme_api");
        assert_eq!(sanitize_project_key("title::pitch"), "title__pitch");
        assert_eq!(sanitize_project_key("Studio Code v2.0"), "Studio_Code_v2_0");
    }

    #[test]
    fn sanitize_preserves_github_project_node_id() {
        // Project v2 node ids (underscores stay underscores, dash stays) are ASCII-safe.
        assert_eq!(sanitize_project_key("PVT_kwHOA_-LFc4BYsJC"), "PVT_kwHOA_-LFc4BYsJC");
    }

    #[test]
    fn sanitize_drops_unicode_letters_to_match_js_regex() {
        // The frontend's /[^a-zA-Z0-9-]/ is ASCII-only; café → caf_ (not café),
        // so the PTY id and planning directory stay byte-for-byte identical.
        assert_eq!(sanitize_project_key("café"), "caf_");
    }

    #[test]
    fn sanitize_truncates_to_80_chars() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_project_key(&long).len(), 80);
    }

    use super::plan_dir_for;

    #[test]
    fn plan_dir_for_places_sanitized_key_under_projects() {
        let dir = plan_dir_for("studio-code");
        let s = dir.to_string_lossy().replace('\\', "/");
        // Project hub — plan sections live directly in projects/<key> (no
        // documents/ prefix, no trailing /plans).
        assert!(s.ends_with("/projects/studio-code"), "got {s}");
        assert!(!s.contains("/documents/"), "got {s}");
    }

    #[test]
    fn plan_dir_for_sanitizes_the_key() {
        let dir = plan_dir_for("acme/api project");
        let s = dir.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/projects/acme_api_project"), "got {s}");
    }

    use super::level_color;

    #[test]
    fn level_color_is_distinct_per_level() {
        let colors = [
            level_color(log::Level::Error),
            level_color(log::Level::Warn),
            level_color(log::Level::Info),
            level_color(log::Level::Debug),
            level_color(log::Level::Trace),
        ];
        // every code is a non-empty ANSI escape, and all five are distinct
        assert!(colors.iter().all(|c| c.starts_with("\x1b[")));
        let unique: std::collections::HashSet<_> = colors.iter().collect();
        assert_eq!(unique.len(), colors.len());
    }

    use super::{claude_project_key, mark_dir_trusted};

    #[test]
    fn claude_project_key_uses_forward_slashes_and_upper_drive() {
        // Backslashes → forward slashes; lower-case drive → upper, matching the
        // form Claude Code writes (verified against a real ~/.claude.json).
        assert_eq!(claude_project_key(r"C:\Users\Kevin\proj"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key("c:/Users/Kevin/proj"), "C:/Users/Kevin/proj");
        // Already-canonical paths pass through unchanged.
        assert_eq!(
            claude_project_key("C:/Users/Kevin/.base-studio-code/repos/x"),
            "C:/Users/Kevin/.base-studio-code/repos/x"
        );
    }

    #[test]
    fn claude_project_key_strips_trailing_slash_and_verbatim_prefix() {
        assert_eq!(claude_project_key("C:/Users/Kevin/proj/"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key(r"\\?\C:\Users\Kevin\proj"), "C:/Users/Kevin/proj");
        assert_eq!(claude_project_key("/"), "/"); // bare root preserved
    }

    #[test]
    fn mark_dir_trusted_creates_projects_entry_when_absent() {
        let mut cfg = serde_json::json!({});
        assert!(mark_dir_trusted(&mut cfg, "C:/Users/Kevin/proj"));
        assert_eq!(
            cfg["projects"]["C:/Users/Kevin/proj"]["hasTrustDialogAccepted"],
            serde_json::Value::Bool(true)
        );
    }

    #[test]
    fn mark_dir_trusted_preserves_other_fields_and_sibling_projects() {
        let mut cfg = serde_json::json!({
            "numStartups": 7,
            "projects": {
                "C:/other": { "allowedTools": ["Read"], "hasTrustDialogAccepted": true },
                "C:/proj":  { "allowedTools": ["Edit"], "history": [{ "display": "hi" }] }
            }
        });
        assert!(mark_dir_trusted(&mut cfg, "C:/proj"));
        // Target gains trust without losing its existing fields …
        assert_eq!(cfg["projects"]["C:/proj"]["hasTrustDialogAccepted"], serde_json::Value::Bool(true));
        assert_eq!(cfg["projects"]["C:/proj"]["allowedTools"][0], "Edit");
        assert_eq!(cfg["projects"]["C:/proj"]["history"][0]["display"], "hi");
        // … and unrelated keys / sibling projects are untouched.
        assert_eq!(cfg["numStartups"], 7);
        assert_eq!(cfg["projects"]["C:/other"]["allowedTools"][0], "Read");
    }

    #[test]
    fn mark_dir_trusted_is_noop_when_already_trusted() {
        let mut cfg = serde_json::json!({ "projects": { "C:/proj": { "hasTrustDialogAccepted": true } } });
        assert!(!mark_dir_trusted(&mut cfg, "C:/proj"));
    }

    #[test]
    fn mark_dir_trusted_flips_existing_false_to_true() {
        let mut cfg = serde_json::json!({ "projects": { "C:/proj": { "hasTrustDialogAccepted": false } } });
        assert!(mark_dir_trusted(&mut cfg, "C:/proj"));
        assert_eq!(cfg["projects"]["C:/proj"]["hasTrustDialogAccepted"], serde_json::Value::Bool(true));
    }

    use super::repair_claude_json;

    #[test]
    fn repair_claude_json_passes_through_valid() {
        let out = repair_claude_json(r#"{"a":1,"b":[2,3]}"#).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&out).unwrap()["a"], 1);
    }

    #[test]
    fn repair_claude_json_drops_trailing_junk() {
        // The observed corruption: a complete object followed by stray bytes.
        let out = repair_claude_json("{\"a\":1}\n}garbage").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["a"], 1);
        assert!(v.get("garbage").is_none());
    }

    #[test]
    fn repair_claude_json_returns_none_for_unrecoverable() {
        assert!(repair_claude_json("not json at all").is_none());
        assert!(repair_claude_json("").is_none());
    }

    #[test]
    fn repair_claude_json_handles_concurrent_write_tail() {
        // The real-world tail: a complete object, then leftover bytes from a
        // longer previous write that wasn't truncated (e.g. `}4\n  }\n}`).
        let out = repair_claude_json("{\n  \"numStartups\": 239,\n  \"ok\": true\n}4\n  }\n}").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["numStartups"], 239);
        assert_eq!(v["ok"], true);
    }

    // ── Document store ──────────────────────────────────────────────────────

    use super::{collect_documents, parse_frontmatter, read_document, write_document, bsc_base_dir};
    use super::has_claude_history;
    use std::path::{Path, PathBuf};
    use std::sync::Mutex as StdMutex;

    /// Serializes the env-mutating tests (they all repoint HOME/USERPROFILE,
    /// which `home_dir()` reads) so they can't race each other.
    static ENV_LOCK: StdMutex<()> = StdMutex::new(());

    /// Creates a fresh, unique temp directory for a test and points
    /// HOME/USERPROFILE at it so `bsc_base_dir()` resolves inside it.
    /// Returns the temp dir; caller removes it when done.
    fn temp_home(tag: &str) -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-test-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        dir
    }

    fn write_file(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn parse_frontmatter_extracts_title_and_tags() {
        let (title, tags) = parse_frontmatter("---\nid: abc\ntitle: My Doc\ntags: [rust, react]\n---\n\nbody");
        assert_eq!(title, "My Doc");
        assert_eq!(tags, vec!["rust".to_string(), "react".to_string()]);
    }

    #[test]
    fn parse_frontmatter_empty_when_absent() {
        let (title, tags) = parse_frontmatter("# Just a heading\n\nno frontmatter");
        assert!(title.is_empty());
        assert!(tags.is_empty());
    }

    #[test]
    fn has_claude_history_detects_jsonl_in_project_dir() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("history");
        let cwd = r"C:\Users\Kevin\Projects\demo";
        let proj = home.join(".claude").join("projects").join(claude_project_dir_name(cwd));

        // No project dir yet → fresh launch.
        assert!(!has_claude_history(cwd));

        // Dir exists but holds no conversation → still fresh.
        std::fs::create_dir_all(&proj).unwrap();
        write_file(&proj.join("config.json"), "{}");
        assert!(!has_claude_history(cwd));

        // A conversation transcript is present → resume is safe.
        write_file(&proj.join("abc-123.jsonl"), "{}\n");
        assert!(has_claude_history(cwd));

        // Empty cwd is never resumable.
        assert!(!has_claude_history(""));
    }

    #[test]
    fn collect_documents_classifies_reusable_project_and_repo() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("collect");
        let base = home.join(".base-studio-code");
        let docs = base.join("documents");
        let proj = base.join("projects").join("proj-x");
        let repo = proj.join("api"); // short-name clone dir

        // Reusable library article with frontmatter.
        write_file(&docs.join("a1.md"),
            "---\nid: a1\ntitle: Alpha\ntags: [rust]\n---\n\nbody");
        // Reusable CLAUDE.md IS included (kind reusable).
        write_file(&docs.join("CLAUDE.md"), "# lib claude");
        // Reusable settings.json.
        write_file(&docs.join(".claude").join("settings.json"), "{}");

        // Project plan section (no title frontmatter → stem fallback).
        write_file(&proj.join("goal.md"), "the goal");
        // Project prompt.
        write_file(&proj.join("prompts").join("kickoff.md"), "go");
        // Project settings.json.
        write_file(&proj.join(".claude").join("settings.json"), "{}");

        // Repo clone: a `.git` entry marks it as a clone. Only managed files
        // are surfaced; the clone's own source tree must NOT be listed.
        write_file(&repo.join(".git").join("HEAD"), "ref: refs/heads/main");
        write_file(&repo.join("CLAUDE.md"), "# repo claude");
        write_file(&repo.join("CLAUDE.local.md"), "# repo local");
        write_file(&repo.join(".claude").join("settings.json"), "{}");
        // These are clone source files — they MUST be ignored.
        write_file(&repo.join("README.md"), "do not list me");
        write_file(&repo.join("src").join("deep.md"), "do not list me either");

        let found = collect_documents(&base);
        let by_rel = |rel: &str| found.iter().find(|d| d.relpath == rel);

        // Reusable.
        let a = by_rel("documents/a1.md").expect("reusable article present");
        assert_eq!(a.kind, "reusable");
        assert_eq!(a.project, None);
        assert_eq!(a.repo, None);
        assert_eq!(a.title, "Alpha");
        assert_eq!(a.tags, vec!["rust".to_string()]);
        assert_eq!(by_rel("documents/CLAUDE.md").expect("reusable CLAUDE.md present").kind, "reusable");
        let ds = by_rel("documents/.claude/settings.json").expect("reusable settings present");
        assert_eq!(ds.kind, "reusable");
        assert_eq!(ds.title, "settings.json");

        // Project.
        let g = by_rel("projects/proj-x/goal.md").expect("project section present");
        assert_eq!(g.kind, "project");
        assert_eq!(g.project.as_deref(), Some("proj-x"));
        assert_eq!(g.repo, None);
        assert_eq!(g.title, "goal"); // stem fallback
        assert_eq!(by_rel("projects/proj-x/prompts/kickoff.md").expect("project prompt present").kind, "project");
        assert_eq!(by_rel("projects/proj-x/.claude/settings.json").expect("project settings present").kind, "project");

        // Repo: only managed files, one DocInfo each, project + repo set.
        let rc = by_rel("projects/proj-x/api/CLAUDE.md").expect("repo CLAUDE.md present");
        assert_eq!(rc.kind, "repo");
        assert_eq!(rc.project.as_deref(), Some("proj-x"));
        assert_eq!(rc.repo.as_deref(), Some("api"));
        assert!(by_rel("projects/proj-x/api/CLAUDE.local.md").is_some(), "repo CLAUDE.local.md present");
        assert!(by_rel("projects/proj-x/api/.claude/settings.json").is_some(), "repo settings present");

        // The clone's own source files are NOT listed.
        assert!(by_rel("projects/proj-x/api/README.md").is_none(), "clone README must not be listed");
        assert!(by_rel("projects/proj-x/api/src/deep.md").is_none(), "clone source must not be listed");

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn write_document_round_trips_and_rejects_traversal() {
        let _guard = ENV_LOCK.lock().unwrap();
        let home = temp_home("writedoc");
        let base = bsc_base_dir();

        // Round-trip: write under documents/, read it back, parent dirs created.
        tauri::async_runtime::block_on(write_document(
            "documents/new-note.md".to_string(),
            "hello world".to_string(),
        )).expect("write succeeds");
        assert!(base.join("documents").join("new-note.md").exists(), "file created");
        let got = tauri::async_runtime::block_on(
            read_document("documents/new-note.md".to_string())
        ).expect("read succeeds");
        assert_eq!(got, "hello world");

        // Writing under projects/ also works (creates parent dirs).
        tauri::async_runtime::block_on(write_document(
            "projects/p1/goal.md".to_string(),
            "the goal".to_string(),
        )).expect("project write succeeds");
        assert!(base.join("projects").join("p1").join("goal.md").exists());

        // Traversal is rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "documents/../secret.md".to_string(), "x".to_string(),
        )).is_err(), "`..` rejected on write");
        assert!(tauri::async_runtime::block_on(
            read_document("documents/../secret.md".to_string())
        ).is_err(), "`..` rejected on read");

        // Out-of-store roots are rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "repos/x.md".to_string(), "x".to_string(),
        )).is_err(), "non documents/projects root rejected");

        // Absolute paths are rejected.
        assert!(tauri::async_runtime::block_on(write_document(
            "/etc/passwd".to_string(), "x".to_string(),
        )).is_err(), "absolute path rejected");

        std::fs::remove_dir_all(&home).ok();
    }
}
