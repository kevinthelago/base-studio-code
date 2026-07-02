// PTY session lifecycle: the state registry, the pty_* Tauri commands, and the
// mobile-tunnel bridge (extracted from lib.rs, #758). The session env wiring
// (`wire_bsc_env` + the bsc-* sidecar resolvers) lives in [`env`], the launch
// decision + bash init line in [`launch`], the reader/emitter IO pump in [`pump`],
// and the process-tree kill primitive (`PtyJob`) in [`job`] (#1660). Split out of a
// single ~1150-line mod.rs (#1864); `pty_create` stays the readable orchestration.

use crate::{nearest_existing_ancestor, to_native_path};
use crate::mobile::tunnel;
use crate::observability::perf;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

mod env;
mod launch;
mod pump;

// Session env wiring + the sidecar resolvers used at the same `crate::console::pty::*` paths as
// before the split (`extensions/mcp.rs`, `app/run.rs`, `github/readiness.rs`).
pub(crate) use env::{bsc_bin_path, session_env, sidecar_status};
use env::wire_bsc_env;
use launch::{build_bash_init_line, plan_launch, LaunchPlan};
use pump::{spawn_emitter, spawn_reader};

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

// ── Process tree kill (Windows Job Object / Unix process group) ──────────────

/// Per-session process-tree kill primitive — a Windows Job Object or a Unix
/// process-group id. Lives in [`job`]; `PtySession` owns one (`_job`) so dropping
/// the session reaps the shell and its whole descendant tree.
mod job;
use job::PtyJob;

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
    crate::console::ledger::forget_all_owned();
    log::info!("killed {n} PTY session(s) on exit");
}

/// Which of `pane_ids` belong to project `key` — the identity panes `<key>:…` (director / worker /
/// triage) PLUS the planner pane `planning_<key>`. Manual (`man:…`) and other projects' panes never
/// match (a sanitized key carries no `:`, so the prefix match is exact). Pure for testing.
pub(crate) fn project_session_ids(pane_ids: &[String], key: &str) -> Vec<String> {
    // The PLANNER pane is the exception to the `<key>:<stream>` identity scheme: its id is
    // `planning_<key>` (Planning.tsx), so the prefix alone misses it and its claude shell keeps the
    // hub as its cwd — which blocked the Windows draft-hub delete with a sharing violation (#1401).
    // The frontend sanitizer and `sanitize_project_key` are byte-identical, so the suffix matches.
    let prefix = format!("{key}:");
    let planner = format!("planning_{key}");
    pane_ids.iter().filter(|id| id.starts_with(&prefix) || id.as_str() == planner).cloned().collect()
}

/// Tear down one project's LIVE PTY sessions before its hub is deleted (#1387): drain the sessions
/// whose pane id is `<key>:…` and kill each (the shell + its whole tree, via the Job Object /
/// process group that drops with the session), forgetting their ledger entries. This RELEASES the
/// cwd locks those shells hold on `projects/<key>/`, so the hub delete doesn't fail "in use" on
/// Windows. `key` must be the SANITIZED project key. Returns how many were killed. Mirrors
/// `kill_all_pty_sessions`, scoped to one project.
pub(crate) fn kill_project_sessions(state: &PtyState, key: &str) -> usize {
    let drained: Vec<(String, PtySession)> = {
        let mut map = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let ids = project_session_ids(&map.keys().cloned().collect::<Vec<_>>(), key);
        ids.into_iter().filter_map(|id| map.remove(&id).map(|s| (id, s))).collect()
    };
    let n = drained.len();
    for (pane_id, mut session) in drained {
        if let Err(e) = session.child.kill() {
            log::warn!("pty[{pane_id}] project-delete kill failed: {e}");
        }
        crate::console::ledger::forget_pane(&pane_id);
        // Dropping `session` runs the Job Object / pgid teardown, terminating the whole tree.
    }
    if n > 0 {
        log::info!("killed {n} live PTY session(s) for project {key:?} before delete");
    }
    n
}

/// Returns `true` when a new session is created, `false` when reconnecting to
/// an existing one (e.g. after a tab switch). The caller should send `\n` on
/// reconnect so the shell re-displays its prompt in the fresh terminal.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn pty_create(
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
    // #1988: when set, run this session INSIDE the named sealed WSL2 distro (the model-agnostic
    // sandbox). None ⇒ the normal host shell — every existing caller, unchanged.
    wsl_distro: Option<String>,
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
    let resolved_shell = crate::platform::shell::resolve_interactive_shell();
    let shell = resolved_shell.program.clone();
    // #1988: target the sealed WSL2 distro when one is named (empty → None). When set, spawn the
    // distro's OWN interactive bash via wsl.exe — the seal (/etc/wsl.conf) confines it regardless of
    // which LLM drives the session. Everything distro-specific below is guarded on this, so a None
    // session (every current caller) takes the exact original path.
    let into_sandbox = wsl_distro.as_deref().filter(|d| !d.is_empty()).map(str::to_string);
    let mut cmd = if let Some(distro) = into_sandbox.as_deref() {
        let mut c = CommandBuilder::new("wsl.exe");
        for a in ["-d", distro, "--", "bash", "-i"] {
            c.arg(a);
        }
        c
    } else {
        CommandBuilder::new(&shell)
    };

    // The session-harness adapter (#1078 P0/P3) — owns the launch + pre-launch host setup. Selected
    // from the console provider id: "bsc-agent" runs the model-agnostic runtime, everything else
    // (incl. None) keeps Claude Code, the default. Boxed so both impls share the call sites below.
    let harness: Box<dyn crate::session::harness::HarnessAdapter> = match provider_id.as_deref() {
        Some("bsc-agent") => Box::new(crate::session::harness::BscAgentAdapter),
        _ => Box::new(crate::session::harness::ClaudeCodeAdapter),
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
    // #1988: a distro session's cwd is a distro-native path (`/home/agent/...`) — don't normalize it as
    // a Windows path or test it with the host's `is_dir` (it isn't a host path). The init line cd's it.
    let cwd = if into_sandbox.is_some() { cwd } else { to_native_path(&cwd) };
    let cwd_missing = into_sandbox.is_none() && !cwd.is_empty() && !std::path::Path::new(&cwd).is_dir();
    if cwd_missing {
        log::error!("pty[{pane_id}] configured cwd does not exist: {cwd} — refusing the silent home fallback");
    }
    // #1819: an EMPTY cwd is as dangerous as a missing one — with no cwd set the shell inherits the
    // APP's working directory, so the session's per-cwd settings.json (role gate + shell allowlist)
    // was never written there and a claude launch runs permission-less. We can't manufacture a dir,
    // but flag it loudly here (and again, claude-specifically, once the launch plan is resolved).
    if cwd.is_empty() {
        log::warn!("pty[{pane_id}] launched with an EMPTY cwd — no per-session settings.json was written; the shell inherits the app's working directory (#1819)");
    }
    let effective_cwd: String = if cwd_missing { nearest_existing_ancestor(&cwd) } else { cwd.clone() };
    // #1988: skip for a distro session — `effective_cwd` is a distro path (not a valid wsl.exe spawn
    // cwd), and folder-trust is a Claude-on-host concern. The distro init line cd's into it instead.
    if into_sandbox.is_none() && !effective_cwd.is_empty() {
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
    // Wire every per-session BSC_* env var the bsc-* shell helpers read (checkpoint doc, the
    // BASH_ENV rc, the analytics logs, the plan/skill/data stores + their CLIs, the planner skill
    // group, and the bsc-agent sidecar/session). Returns the bash-style rc path so the interactive
    // shell below can source the same helpers.
    // #1988: the host bsc-env rc + Windows-path BSC_* vars don't cross the wsl boundary — a distro
    // session bakes its (distro-native) env into the init line below instead (rc_bash unused there).
    let rc_bash = if into_sandbox.is_some() {
        String::new()
    } else {
        wire_bsc_env(&mut cmd, &pane_id, &cwd, checkpoint_doc.as_deref(), provider_id.as_deref())
    };

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
        crate::console::ledger::record(pid, &pane_id);
    }

    let mut writer = pair.master.take_writer()
        .map_err(|e| { log::error!("pty[{pane_id}] take_writer failed: {e}"); e.to_string() })?;
    let reader = pair.master.try_clone_reader()
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
    // #1819: the high-severity case — claude is about to launch with NO cwd, so its role gate +
    // shell allowlist (settings.json, written per-cwd by the frontend) were never written and the
    // session will prompt for everything. Surface it loudly so the silent failure can't recur.
    if launch_claude && cwd.is_empty() {
        log::error!("pty[{pane_id}] launching claude with an EMPTY cwd — permission-less session: the role gate + shell allowlist in settings.json were never written (#1819)");
    }
    // The default `--model` alias for this session (per-pane override or global
    // default, mapped from the UI model id). None ⇒ the harness's own default.
    let model_alias = model.as_deref().and_then(|m| harness.model_flag(m));
    // The `claude()` shell wrapper: it emits the run/idle OSC markers AND injects the
    // session's default model, so BOTH the auto-launch below and anything the user
    // types pick it up. Skip the injection when the call already carries `--model`
    // (whole-word match, so prompt text containing the string can't trip it).
    let claude_fn = harness.shell_fn(model_alias.as_deref());
    // #1988: a distro session always runs the distro's bash — bake its env + cd into the init line.
    let init_line = if into_sandbox.is_some() {
        crate::platform::shell::sandbox_init_line(&cwd, launch.as_deref(), &env_map)
    } else { match resolved_shell.kind {
        crate::platform::shell::ShellKind::Bash => {
            build_bash_init_line(&cwd, cwd_missing, &effective_cwd, launch.as_deref(), &claude_fn, &rc_bash)
        }
        // PowerShell / cmd: bsc-* helpers, OSC7/state markers, and startup-prompt baking
        // are bash-only, so run a degraded init that cd's, clears, and prints a visible
        // notice (no silent breakage, #447).
        crate::platform::shell::ShellKind::PowerShell | crate::platform::shell::ShellKind::Cmd => {
            crate::platform::shell::non_bash_init(resolved_shell.kind, &cwd, cwd_missing, &effective_cwd, launch_claude, model_alias.as_deref())
        }
    } };
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
    spawn_reader(pane_id.clone(), reader, tx);
    spawn_emitter(pane_id.clone(), app.clone(), rx);

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
pub(crate) fn pty_write(
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
pub(crate) fn pty_resize(
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
pub(crate) fn pty_kill(
    pane_id: String,
    state: State<'_, PtyState>,
    perf_state: State<'_, perf::PerfState>,
) -> Result<(), String> {
    // Remove from perf tracker before killing the process.
    perf_state.unregister(&pane_id);
    // Drop the ledger entry (#1049) — a clean kill means there's nothing for the next boot to reap.
    crate::console::ledger::forget_pane(&pane_id);
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
    // The session env wiring + launch-plan + init-line tests live with their code in the `env` and
    // `launch` submodules; the PtyJob process-tree-kill tests live in `job.rs`.

    #[test]
    fn project_session_ids_matches_only_the_project_panes() {
        // #1387: pick exactly the project's identity panes for the pre-delete teardown — incl. the
        // planner pane `planning_<key>` (#1401), which the `<key>:` prefix alone would miss.
        let panes: Vec<String> = ["proj:director", "proj:auth-ui", "proj:own/web:triage", "planning_proj", "other:api", "man:t0:p1", "proj", "planning_other"]
            .iter().map(|s| s.to_string()).collect();
        let got = super::project_session_ids(&panes, "proj");
        assert_eq!(got, vec!["proj:director", "proj:auth-ui", "proj:own/web:triage", "planning_proj"]);
        // another project's panes (incl. its planner), a manual pane, and a bare same-name (no `:`)
        // never match.
        for miss in ["other:api", "planning_other", "man:t0:p1", "proj"] {
            assert!(!got.contains(&miss.to_string()), "{miss} must not match");
        }
    }
}

