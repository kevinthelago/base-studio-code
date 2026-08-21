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

mod busy;
mod env;
mod launch;
mod pump;

// Session env wiring + the sidecar resolvers used at the same `crate::console::pty::*` paths as
// before the split (`extensions/mcp.rs`, `app/run.rs`, `github/readiness.rs`).
pub(crate) use env::{
    bsc_bin_path, session_env, sidecar_status, stage_dev_sidecars, stale_sidecars,
};
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

/// Best-effort process supervision for a freshly spawned session shell: box it into a Windows Job
/// Object (so killing the session tree-kills `claude` and any `gh`/`git`/MCP child it spawns), register
/// the shell PID with the perf sampler, and author the spawn in the crash-recovery ledger (#1049 — the
/// next boot reconciles the ledger and tree-kills this orphan if the app dies ungracefully, skipping the
/// Job Object's clean drop). Every step is best-effort: a failure logs and proceeds (single-process kill
/// still works; we just lose tree-kill until the next launch). Returns the Job Object to hold for the
/// session's lifetime — `None` if creation/assignment failed. Extracted from `pty_create` (#2086).
fn attach_job_and_track(
    child: &(dyn portable_pty::Child + Send + Sync),
    pane_id: &str,
    app: &AppHandle,
) -> Option<PtyJob> {
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
    if let Some(pid) = child.process_id() {
        app.state::<perf::PerfState>().register(pane_id, pid);
        crate::console::ledger::record(pid, pane_id);
    }
    job
}

/// The session's resolved working directory (#367/#979/#1819/#1988) — the single place the scattered
/// `into_sandbox` cwd re-tests collapse into. Normalizes the configured `cwd`, decides whether it is
/// missing or empty, picks the `effective_cwd` the shell actually starts in, and logs the two loud
/// failure cases. `sandbox` is `into_sandbox.is_some()`.
///
/// - **Normalize (#979):** a git-bash drive path (`/c/Users/...`, as OSC-7 reports and the app persists)
///   becomes native (`C:/Users/...`) so `is_dir` / `Command::cwd` resolve it on Windows — otherwise an
///   EXISTING worktree/dir reads as "missing" on restore. No-op off Windows and for already-native paths.
/// - **Missing (#367):** never silently fall back to `$HOME` — a failed clone/worktree or a stale
///   persisted cwd is detected (logged loudly) and the shell starts in the nearest existing ancestor
///   (not `$HOME`), so the agent is at least near the project. Surfaced again in the pane's `cd_prefix`.
/// - **Empty (#1819):** an empty cwd is as dangerous as a missing one — with no cwd the shell inherits
///   the APP's working directory, so the per-cwd settings.json (role gate + shell allowlist) was never
///   written there and a claude launch runs permission-less. Flagged loudly here (and again,
///   claude-specifically, once the launch plan is resolved).
/// - **Sandbox (#1988):** a distro session's cwd is a distro-native path (`/home/agent/...`) — don't
///   normalize it as a Windows path or test it with the host's `is_dir` (it isn't a host path); the init
///   line cd's it. So a sandbox cwd is never `missing`, and `effective_cwd == cwd`.
struct ResolvedCwd {
    /// The host-normalized configured cwd (or the untouched distro-native path under `sandbox`).
    cwd: String,
    /// Where the shell actually starts — `cwd`, or its nearest existing ancestor when `missing`.
    effective_cwd: String,
    /// The configured cwd does not exist as a host directory (never true under `sandbox`).
    missing: bool,
    /// No cwd was configured at all.
    empty: bool,
}

/// Recover an authoritative cwd from the pane's IDENTITY when none was configured (#1819).
///
/// `<key>:director` → the project hub; `<key>:<repo>:triage` → that repo's clone. Mirrors the
/// frontend's `paneCwdRecovery`, and the duplication is deliberate rather than accidental: the
/// frontend recovery exists and still did not fire, because the director was observed launching
/// through a path that never reaches `TerminalView`'s launch block. Recovering HERE, at the point of
/// use, cannot be bypassed by whichever caller is in play — the lesson from #3937/#3986, where two
/// launch-path fixes in a row were burned by a pane that never remounts.
///
/// A WORKER is deliberately NOT recoverable: its cwd is a worktree keyed by the agent id, which
/// `ensure_worktree` supplies, and nothing about it can be derived from the pane id alone. Manual
/// (`man:<tab>:p<n>`) and legacy positional (`t<n>p<n>`) ids fall out naturally — neither ends in a
/// reserved tail, so neither matches.
fn recover_cwd_from_identity(pane_id: &str) -> Option<String> {
    let parts: Vec<&str> = pane_id.split(':').collect();
    if parts.len() >= 3 && *parts.last()? == "triage" && !parts[0].is_empty() {
        let repo = parts[1..parts.len() - 1].join(":");
        return Some(crate::project::hub::repo_dir_path(parts[0].to_string(), repo));
    }
    if parts.len() == 2 && parts[1] == "director" && !parts[0].is_empty() {
        return Some(crate::project::hub::project_dir_path(parts[0].to_string()));
    }
    None
}

/// Does this pane's identity mean it MUST be gated — a director, a triage pane, or a fleet worker?
///
/// These are the sessions the role gate exists for: a director is `code: none`, a worker is scoped to
/// its owned globs, a triage pane is `git: none`. Permission-less, none of them are what they claim to
/// be, so a launch that cannot prove a gate is refused rather than run.
///
/// A MANUAL console (`man:<tab>:p<n>`) and a legacy positional id (`t<n>p<n>`) are not: that is the
/// user's own shell and the user is the principal. The `man:` prefix is excluded explicitly because a
/// manual id has three colon-parts and would otherwise read as a worker.
fn must_be_gated(pane_id: &str) -> bool {
    if pane_id.starts_with("man:") {
        return false;
    }
    let parts: Vec<&str> = pane_id.split(':').collect();
    parts.len() >= 2 && !parts[0].is_empty() && parts[1..].iter().any(|p| !p.is_empty())
}

fn resolve_session_cwd(pane_id: &str, cwd: String, sandbox: bool) -> ResolvedCwd {
    let cwd = if sandbox { cwd } else { to_native_path(&cwd) };
    // #1819 recovery. Only for a HOST session: a sandbox cwd is a distro path, and the hub/repo dirs
    // resolved here are Windows paths that mean nothing inside the cage.
    //
    // The recovery is announced rather than silent. It fixes the SYMPTOM (the shell no longer starts
    // in the app's own directory) but NOT the cause: `.claude/settings.json` is written by the
    // frontend BEFORE this call, so a pane that arrived here with no cwd still has no role gate. The
    // refusal at the launch site is what covers that; this log is how the underlying path stays
    // visible instead of being papered over.
    let cwd = if !sandbox && cwd.is_empty() {
        match recover_cwd_from_identity(pane_id) {
            Some(dir) if !dir.is_empty() => {
                log::warn!("pty[{pane_id}] recovered an EMPTY cwd from the pane identity (#1819): {dir} — the caller passed none, so its settings.json was written nowhere");
                dir
            }
            _ => cwd,
        }
    } else {
        cwd
    };
    let missing = !sandbox && !cwd.is_empty() && !std::path::Path::new(&cwd).is_dir();
    if missing {
        log::error!("pty[{pane_id}] configured cwd does not exist: {cwd} — refusing the silent home fallback");
    }
    let empty = cwd.is_empty();
    if empty {
        log::warn!("pty[{pane_id}] launched with an EMPTY cwd — no per-session settings.json was written; the shell inherits the app's working directory (#1819)");
    }
    let effective_cwd = if missing { nearest_existing_ancestor(&cwd) } else { cwd.clone() };
    ResolvedCwd { cwd, effective_cwd, missing, empty }
}

/// Assemble the init line a freshly opened PTY starts with, dispatched by sandbox mode then shell kind
/// (#447/#1988). The byte-exact wire strings live in the leaf builders this delegates to —
/// [`build_bash_init_line`] (Git-Bash: OSC-7 + `__bsc_state` markers + the `claude()` wrapper + bsc-*
/// helpers + launch), the host's `non_bash_init` (degraded PowerShell/cmd), and `sandbox_init_line`
/// (the sealed WSL2 distro, which bakes its distro-native env + cd since the host bsc-env rc doesn't
/// cross the wsl boundary). Extracted from `pty_create` (#2167) so the orchestrator stays readable;
/// behavior + the emitted bytes are unchanged.
#[allow(clippy::too_many_arguments)]
fn build_session_init_line(
    sandbox: bool,
    shell_kind: crate::platform::shell::ShellKind,
    cwd: &str,
    cwd_missing: bool,
    effective_cwd: &str,
    launch: Option<&str>,
    launch_claude: bool,
    claude_fn: &str,
    rc_bash: &str,
    model_alias: Option<&str>,
    env_map: &std::collections::HashMap<String, String>,
) -> String {
    if sandbox {
        // A distro session always runs the distro's bash — bake its env + cd into the init line.
        crate::platform::shell::sandbox_init_line(cwd, launch, env_map)
    } else {
        match shell_kind {
            crate::platform::shell::ShellKind::Bash => {
                build_bash_init_line(cwd, cwd_missing, effective_cwd, launch, claude_fn, rc_bash)
            }
            // PowerShell / cmd: bsc-* helpers, OSC7/state markers, and startup-prompt baking
            // are bash-only, so run a degraded init that cd's, clears, and prints a visible
            // notice (no silent breakage, #447).
            crate::platform::shell::ShellKind::PowerShell | crate::platform::shell::ShellKind::Cmd => {
                crate::platform::shell::non_bash_init(shell_kind, cwd, cwd_missing, effective_cwd, launch_claude, model_alias)
            }
        }
    }
}

/// Returns `true` when a new session is created, `false` when reconnecting to
/// an existing one (e.g. after a tab switch). The caller should send `\n` on
/// reconnect so the shell re-displays its prompt in the fresh terminal.
/// Create a pane's PTY session. ASYNC (#3989) so the blocking work — openpty, spawning the shell,
/// writing the session rc + settings.json — runs on the BLOCKING pool instead of holding a command-pool
/// thread. Measured before: 43 concurrent calls at a 14.1s mean, with `pty_write` (keystrokes) queued
/// behind them at 3.1s. The work is unchanged; it simply stops monopolizing the queue every other
/// command shares. Same shape `preflight` already uses.
/// Can this host actually put a session in a mount namespace?
///
/// The frontend cannot answer this on its own — it has no platform probe and no `plugin-os` — and it
/// MUST know, because the settings it writes and the launch it requests are two separate calls and
/// the hook list has to match what the launch really did.
///
/// The two failure directions are not symmetric, which is what decides the default:
///
/// * settings say sandboxed, launch is NOT ⇒ the shell gates were dropped and `/bsc-hook` does not
///   exist. The session runs with **no** write-scope and **no** command floor. A regression.
/// * settings say unsandboxed, launch IS ⇒ shell gates are configured but inert, and the kernel
///   still confines paths. Degraded, never worse than today.
///
/// So this fails CLOSED: anything uncertain answers `false`, and the caller keeps the working shell
/// gates. Being wrong in the safe direction costs a little redundancy; being wrong the other way
/// costs the floor.
#[tauri::command]
pub(crate) fn sandbox_available() -> bool {
    namespace_supported()
}

/// The platform half, split out so both the command and the tests read one answer.
#[cfg(target_os = "linux")]
fn namespace_supported() -> bool {
    // `bwrap` is the launcher; without it the rendered argv cannot execute. Probing the binary
    // rather than assuming it means a Linux host that never installed bubblewrap is reported
    // honestly instead of failing at the first launch.
    std::process::Command::new("bwrap")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Windows and macOS have no mount namespace, so the answer is a compile-time `false` rather than a
/// probe that could be fooled by a `bwrap` on PATH under some emulation layer.
#[cfg(not(target_os = "linux"))]
fn namespace_supported() -> bool {
    false
}

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
    startup_prompt_fresh_only: Option<bool>,
    checkpoint_doc: Option<String>,
    model: Option<String>,
    provider_id: Option<String>,
    wsl_distro: Option<String>,
    wsl_user: Option<String>,
    sandbox_role: Option<String>,
    sandbox_stores: Option<String>,
    app: AppHandle,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        // `PtyState` is a bare Mutex managed by Tauri, so it cannot move into the closure — but
        // `AppHandle` is 'static and re-fetches it here, where it outlives the call.
        let state = app.state::<PtyState>();
        pty_create_inner(
            pane_id, cols, rows, cwd, init_cmd, env, startup_prompt, continue_session, startup_prompt_fresh_only, checkpoint_doc, model, provider_id, wsl_distro, wsl_user, sandbox_role, sandbox_stores,
            &app, &state,
        )
    })
    .await
    .map_err(|e| format!("pty_create task failed: {e}"))?
}

/// The real work, off the command pool (#3989). Blocking by nature: it opens a PTY, spawns a shell,
/// writes the session's rc + settings, and registers the session — so it must NOT run as a synchronous
/// `#[tauri::command]`, which holds a command-pool thread for its whole duration.
#[allow(clippy::too_many_arguments)]
fn pty_create_inner(
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
    // #1994: when set (alongside `wsl_distro`), run the distro session as this per-agent Linux USER —
    // its private mode-700 home isolates it from co-located agents (raw Bash can't cross Unix perms).
    // Derive + provision it first via `ensure_sandbox_user`. None ⇒ the distro's default `agent` user.
    wsl_user: Option<String>,
    sandbox_role: Option<String>,
    sandbox_stores: Option<String>,
    app: &AppHandle,
    state: &PtyState,
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
    // #1994: the per-agent Linux user to run the distro session as (its private 700 home isolates it
    // from co-located agents). Only meaningful alongside a distro; empty → None → the distro default.
    let into_sandbox_user = into_sandbox
        .as_ref()
        .and(wsl_user.as_deref().filter(|u| !u.is_empty()).map(str::to_string));
    // phase-2 slice 3: a NAMESPACE session. Where `wsl_distro` swaps the command for a distro
    // shell, this swaps it for the SAME shell wrapped in a cgroup scope and a mount namespace,
    // rendered by `bsc_sandbox::profile`. The kernel becomes the floor instead of the PreToolUse
    // hooks, which can only see a tool's DECLARED payload and are blind to what it spawns.
    //
    // Windows is bit-identical: the whole arm is `cfg`'d out and the params are consumed so no
    // `unused` warning appears. That matters because Windows has no namespace to replace the
    // hooks WITH — demoting them there would silently weaken the posture on the platform this is
    // still developed on.
    let ns_argv: Option<Vec<String>> = namespace_argv(
        sandbox_role.as_deref(),
        &pane_id,
        &cwd,
        sandbox_stores.as_deref(),
        &shell,
    );

    let mut cmd = if let Some(argv) = ns_argv.as_ref() {
        // argv[0] is `systemd-run`; the rest is the scope, the bwrap invocation and the shell.
        // Passed as an ARGV, never a shell string — there is no quoting layer to get wrong.
        let mut c = CommandBuilder::new(&argv[0]);
        for a in &argv[1..] {
            c.arg(a);
        }
        c
    } else if let Some(distro) = into_sandbox.as_deref() {
        let mut c = CommandBuilder::new("wsl.exe");
        // `-d <distro>` [`-u <user>`] `-- bash -i` — the user arg makes the session run as its own
        // isolated Linux user when one was provisioned (#1994), else the distro's default user (#1988).
        for a in crate::platform::shell::wsl_interactive_args(distro, into_sandbox_user.as_deref()) {
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

    // #1994: a per-agent sandbox session with no explicit cwd starts in its OWN private (mode-700)
    // home, not the distro's shared default `~` — so isolation holds even for a bare launch.
    let cwd = match into_sandbox_user.as_deref() {
        Some(user) if cwd.is_empty() => crate::session::sandbox::agent_home(user),
        _ => cwd,
    };
    // Resolve the session's working directory (#367/#979/#1819/#1988): normalize a git-bash drive
    // path back to native, detect a missing/empty cwd (both logged loudly, never a silent home
    // fallback), and pick the effective start dir. All the `into_sandbox` cwd re-tests live in the
    // one helper now; see `resolve_session_cwd` for the per-case rationale.
    let ResolvedCwd { cwd, effective_cwd, missing: cwd_missing, empty: cwd_empty } =
        resolve_session_cwd(&pane_id, cwd, into_sandbox.is_some());
    // #1988: skip for a distro session — `effective_cwd` is a distro path (not a valid wsl.exe spawn
    // cwd), and folder-trust is a Claude-on-host concern. The distro init line cd's into it instead.
    // A namespace session sets its own cwd via bwrap's --chdir, and `effective_cwd` is a HOST
    // path that means nothing inside it.
    if into_sandbox.is_none() && ns_argv.is_none() && !effective_cwd.is_empty() {
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

    // Box the shell into a Job Object (tree-kill), register its PID with the perf sampler, and author
    // the spawn in the crash-recovery ledger — all best-effort (see `attach_job_and_track`).
    let job = attach_job_and_track(child.as_ref(), &pane_id, app);

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
    let plan = plan_launch(
        startup_prompt.as_deref(),
        init_cmd.as_deref(),
        has_history,
        continue_session.unwrap_or(false),
        startup_prompt_fresh_only.unwrap_or(false),
    );
    // #2396: make the resume decision visible — an "always fresh" regression (a caller dropping the
    // resume init/flag) shows up in the logs as `resumed=false` right next to `has_history=true`.
    // An Init launch resumes when its command carries `--continue` AND there's history to continue
    // (the `claude --continue || claude` chain falls back to fresh on its own otherwise).
    let resumed = match &plan {
        LaunchPlan::Prompt { resume } => *resume,
        LaunchPlan::Init(s) => s.contains("--continue") && has_history,
        LaunchPlan::None => false,
    };
    log::info!("pty[{pane_id}] launch decision · has_history={has_history} · resumed={resumed}");
    let launch = match plan {
        LaunchPlan::Prompt { resume } => Some(harness.launch_command(startup_prompt.as_deref().unwrap_or(""), resume)),
        LaunchPlan::Init(s) => Some(s),
        LaunchPlan::None => None,
    };
    // Whether the launch would start `claude` — the only command the degraded
    // non-bash path replays (an arbitrary bash init_cmd would be invalid there).
    let launch_claude = launch.as_deref().map(|s| harness.is_harness_launch(s)).unwrap_or(false);
    // #1819: the high-severity case — claude is about to auto-launch somewhere its role gate + shell
    // allowlist were never written, so the session runs PERMISSION-LESS.
    //
    // The check is for the gate FILE, not for an empty cwd, because the file is what actually gates:
    // `.claude/settings.json` is per-DIRECTORY and persists, so a recovered cwd inherits the gate a
    // previous launch wrote there. That is why the identity recovery above fixes the observed
    // incident on its own — the director's hub already had one. What it cannot cover is a FIRST
    // launch at a directory nothing has gated yet, which is this.
    //
    // Skipped under sandbox: the gate lives inside the distro, not at a host path.
    if launch_claude && into_sandbox.is_none() {
        let gated = !effective_cwd.is_empty()
            && std::path::Path::new(&effective_cwd).join(".claude").join("settings.json").is_file();
        if !gated {
            // A pane with a PROJECT identity is refused outright. Running one of these ungated is the
            // one outcome worse than not starting: a director is `code: none`, a worker is scoped to
            // its owned globs, and permission-less it has neither. A manual console is the user's own
            // shell and they are the principal, so it keeps the loud warning instead.
            if must_be_gated(&pane_id) {
                return Err(format!(
                    "pty[{pane_id}] refusing to auto-launch claude at {} — no .claude/settings.json, so the role gate and shell allowlist were never written and the session would run permission-less (#1819). Relaunch the pane from its project so the settings are written first.",
                    if effective_cwd.is_empty() { "<no cwd>" } else { &effective_cwd }
                ));
            }
            log::error!("pty[{pane_id}] launching claude with NO settings.json at {} — permission-less session: the role gate + shell allowlist were never written (#1819)", if effective_cwd.is_empty() { "<no cwd>" } else { &effective_cwd });
        }
    }
    // The default `--model` alias for this session (per-pane override or global
    // default, mapped from the UI model id). None ⇒ the harness's own default.
    let model_alias = model.as_deref().and_then(|m| harness.model_flag(m));
    // The `claude()` shell wrapper: it emits the run/idle OSC markers AND injects the
    // session's default model, so BOTH the auto-launch below and anything the user
    // types pick it up. Skip the injection when the call already carries `--model`
    // (whole-word match, so prompt text containing the string can't trip it).
    let claude_fn = harness.shell_fn(model_alias.as_deref());
    // Assemble the init line the freshly opened PTY starts with — dispatched by sandbox mode / shell
    // kind to the byte-exact leaf builders (see `build_session_init_line`).
    let init_line = build_session_init_line(
        into_sandbox.is_some(), resolved_shell.kind, &cwd, cwd_missing, &effective_cwd,
        launch.as_deref(), launch_claude, &claude_fn, &rc_bash, model_alias.as_deref(), &env_map,
    );
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
        if cwd_empty { "<none>" } else { cwd.as_str() },
        init_cmd.as_deref().filter(|s| !s.is_empty()).unwrap_or("<none>"),
    );

    // Tell the mobile tunnel this pane's grid size so it renders at the desktop width
    // (before pane_id is moved into the session map).
    tunnel_set_pane_size(app, &pane_id, cols, rows);

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

/// What a pane's PTY is actually doing right now (#3998).
///
/// The two flags are independent and the caller needs both: `live` without `busy` is a session
/// sitting at a bash prompt — the state Resume has to notice and act on, and the one the frontend
/// previously could not tell apart from a working agent.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PaneRuntime {
    pane_id: String,
    /// A PTY session exists for this pane (so `pty_create` would RECONNECT, not launch).
    live: bool,
    /// Its shell has at least one live descendant — something is running in it. See `busy.rs` for
    /// why this is a descendant check rather than a hunt for a process named `claude`.
    busy: bool,
}

/// Report the runtime state of each named pane, in the order asked.
///
/// Batched on purpose: the process walk behind `busy` is the expensive part, and a project-wide
/// resume asks about every pane at once. Answering them together costs ONE walk instead of N.
#[tauri::command]
pub(crate) fn pty_pane_runtime(
    pane_ids: Vec<String>,
    state: State<'_, PtyState>,
) -> Vec<PaneRuntime> {
    // Collect the pids and DROP the lock before walking the process table — that walk takes
    // milliseconds, and every `pty_write` / `pty_create` in the app contends on this same mutex.
    // `live` is session PRESENCE, tracked separately from the pid: a session whose `process_id()`
    // comes back None still occupies the map, and `pty_create` would still reconnect to it. Deriving
    // `live` from the pid would report such a pane as absent and send the caller down the "mount will
    // create it" path that reconnect has already ruled out.
    let (live, pids): (Vec<bool>, Vec<Option<u32>>) = {
        let sessions = state.0.lock().unwrap();
        pane_ids
            .iter()
            .map(|id| match sessions.get(id) {
                Some(s) => (true, s.child.process_id()),
                None => (false, None),
            })
            .unzip()
    };
    let busy = busy::shells_with_descendants(&pids);
    pane_ids
        .into_iter()
        .zip(live)
        .zip(busy)
        .map(|((pane_id, live), busy)| PaneRuntime { pane_id, live, busy })
        .collect()
}

/// Per-pane liveness for `bsc fleet` (#4098), shaped as the CLI's wire type.
///
/// An EMPTY `pane_ids` means "every pane the app is tracking" — the CLI asks that way when there is no
/// roster to narrow by, and only the app knows the full set.
///
/// Reuses the same one-walk batching as [`pty_pane_runtime`]: the descendant probe is the expensive
/// part, so the pids are collected under the lock, the lock is DROPPED, and the walk happens once for
/// all of them. It also reports the pid, which is the thing the original report had to leave the app
/// and run `tasklist` to find.
pub(crate) fn pane_liveness(pane_ids: Vec<String>, state: &PtyState) -> Vec<bsc_fleet::PaneLive> {
    let (ids, pids): (Vec<String>, Vec<Option<u32>>) = {
        let sessions = state.0.lock().unwrap();
        let wanted: Vec<String> = if pane_ids.is_empty() {
            sessions.keys().cloned().collect()
        } else {
            pane_ids
        };
        wanted
            .into_iter()
            .map(|id| {
                let pid = sessions.get(&id).and_then(|s| s.child.process_id());
                (id, pid)
            })
            .unzip()
    };
    //  is session PRESENCE and is NOT derived from the pid: a session whose  comes
    // back None still occupies the map (see ), and reporting it as absent would be the
    // same class of wrong answer this command exists to fix.
    let live: Vec<bool> = {
        let sessions = state.0.lock().unwrap();
        ids.iter().map(|id| sessions.contains_key(id)).collect()
    };
    let busy = busy::shells_with_descendants(&pids);
    ids.into_iter()
        .zip(live)
        .zip(busy)
        .zip(pids)
        .map(|(((pane_id, live), busy), pid)| bsc_fleet::PaneLive { pane_id, live, busy, pid })
        .collect()
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

/// Mark (or un-mark) a pane as "running the app" for the best-effort runtime-fault PTY tap (#2264).
/// When enabled, the PTY emitter scans this pane's output for stack traces / panics / `ERROR` lines
/// and records them (source `pty-tap`) in `project_key`'s `error.db`. Off by default per pane — every
/// ordinary terminal stays untapped. `project_key` is the pane's owning project (from the store's
/// pane→project binding); it's required to enable and ignored when disabling.
#[tauri::command]
pub(crate) fn pty_set_app_runner(
    pane_id: String,
    enabled: bool,
    project_key: Option<String>,
) -> Result<(), String> {
    use crate::observability::pty_faults;
    if enabled {
        let key = project_key.filter(|k| !k.is_empty()).ok_or_else(|| {
            "pty_set_app_runner: enabling the fault tap needs a non-empty project_key".to_string()
        })?;
        pty_faults::mark_app_runner(&pane_id, &key);
    } else {
        pty_faults::clear_app_runner(&pane_id);
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
    // The session env wiring + launch-plan + bash init-line byte tests live with their code in the
    // `env` and `launch` submodules; the PtyJob process-tree-kill tests live in `job.rs`. Here we test
    // the two `pty_create` orchestration helpers extracted in #2167: `resolve_session_cwd` (cwd
    // resolution) and `build_session_init_line` (sandbox/shell-kind init-line dispatch).
    use std::collections::HashMap;

    #[test]
    fn resolve_session_cwd_empty_flags_empty_and_not_missing() {
        // #1819: an unset cwd is flagged empty (not missing); effective_cwd is empty so the caller
        // skips the cmd.cwd/trust step.
        let r = super::resolve_session_cwd("pane", String::new(), false);
        assert!(r.empty, "empty cwd flagged");
        assert!(!r.missing, "empty is not 'missing'");
        assert_eq!(r.cwd, "");
        assert_eq!(r.effective_cwd, "");
    }

    /// #1819 — the DIRECTOR case that was observed running permission-less in the app's own home.
    /// The pane arrived with no cwd at all; its identity is enough to name the hub, so recover it.
    #[test]
    fn an_empty_director_cwd_is_recovered_from_the_pane_identity() {
        let r = super::resolve_session_cwd("studio-code:director", String::new(), false);
        assert!(!r.empty, "a recovered cwd is no longer 'empty': {r:?}", r = r.cwd);
        assert!(
            r.cwd.replace('\\', "/").ends_with("/projects/studio-code"),
            "the director recovers its project HUB, got {}",
            r.cwd
        );
        assert_eq!(r.effective_cwd, r.cwd, "the hub exists or not, effective tracks cwd here");
    }

    #[test]
    fn triage_recovers_its_repo_clone_and_a_worker_recovers_nothing() {
        let t = super::recover_cwd_from_identity("studio-code:kevinthelago/base-studio-code:triage");
        assert!(
            t.as_deref().unwrap_or_default().replace('\\', "/").ends_with("/base-studio-code"),
            "triage recovers its repo dir, got {t:?}"
        );
        // A worker's cwd is a worktree keyed by the agent id — nothing about it is derivable from the
        // pane id, so recovery must decline rather than invent a path.
        assert_eq!(super::recover_cwd_from_identity("studio-code:design-studio"), None);
        // Manual + legacy positional consoles are not project panes at all.
        assert_eq!(super::recover_cwd_from_identity("man:tab_abc:p2"), None);
        assert_eq!(super::recover_cwd_from_identity("t0p1"), None);
    }

    /// A non-recoverable cwd must stay empty rather than fall back to something plausible — the
    /// launch-site refusal depends on this staying honest.
    #[test]
    fn a_worker_with_no_cwd_is_left_empty_not_guessed() {
        let r = super::resolve_session_cwd("studio-code:design-studio", String::new(), false);
        assert!(r.empty, "an unrecoverable identity leaves the cwd empty");
    }

    /// Which panes are REFUSED rather than merely warned about when no gate file is present.
    #[test]
    fn every_fleet_identity_must_be_gated_and_a_manual_console_is_not() {
        for id in ["studio-code:director", "studio-code:design-studio", "studio-code:kevinthelago/base-studio-code:triage"] {
            assert!(super::must_be_gated(id), "{id} is a fleet pane and must be gated");
        }
        // The user's own console: they are the principal, so it warns instead of refusing. `man:` is
        // three colon-parts and would read as a worker without the explicit exclusion.
        assert!(!super::must_be_gated("man:tab_abc:p2"), "a manual console is not refused");
        assert!(!super::must_be_gated("t0p1"), "a legacy positional pane is not refused");
        assert!(!super::must_be_gated("pane"), "a bare id has no project identity");
    }

    #[test]
    fn resolve_session_cwd_existing_dir_is_neither_missing_nor_empty() {
        // A real host directory (the crate root) resolves cleanly; effective == cwd.
        let dir = env!("CARGO_MANIFEST_DIR").to_string();
        let r = super::resolve_session_cwd("pane", dir.clone(), false);
        assert!(!r.missing, "existing dir not missing");
        assert!(!r.empty, "existing dir not empty");
        assert_eq!(r.effective_cwd, r.cwd, "effective == cwd when the dir exists");
        assert!(std::path::Path::new(&r.cwd).is_dir(), "resolved cwd is a real dir");
    }

    #[test]
    fn resolve_session_cwd_missing_dir_falls_back_to_existing_ancestor() {
        // #367: a nonexistent configured cwd is flagged missing and the shell starts in the nearest
        // existing ancestor instead of a silent $HOME fallback.
        let missing = format!("{}/__bsc_does_not_exist_2167__/deeper", env!("CARGO_MANIFEST_DIR"));
        let r = super::resolve_session_cwd("pane", missing.clone(), false);
        assert!(r.missing, "nonexistent dir flagged missing");
        assert!(!r.empty);
        assert_ne!(r.effective_cwd, r.cwd, "effective steps off the missing path");
        assert!(std::path::Path::new(&r.effective_cwd).is_dir(), "ancestor exists: {}", r.effective_cwd);
    }

    #[test]
    fn resolve_session_cwd_sandbox_skips_host_checks() {
        // #1988: a distro cwd is a distro-native path — never host-normalized, never 'missing' (even
        // though it isn't a host dir), and effective == cwd (the init line cd's into it).
        let distro = "/home/agent/proj".to_string();
        let r = super::resolve_session_cwd("pane", distro.clone(), true);
        assert_eq!(r.cwd, distro, "sandbox cwd is left untouched");
        assert!(!r.missing, "sandbox cwd is never host-missing");
        assert!(!r.empty);
        assert_eq!(r.effective_cwd, distro, "effective == cwd under sandbox");
    }

    #[test]
    fn build_session_init_line_dispatches_to_the_leaf_builders() {
        let env_map: HashMap<String, String> = HashMap::new();
        // Non-sandbox Bash ⇒ byte-for-byte the Git-Bash builder's output.
        let bash = super::build_session_init_line(
            false, crate::platform::shell::ShellKind::Bash,
            "/p", false, "/p", Some("claude"), true, "CLAUDE_FN;", "/rc", None, &env_map,
        );
        assert_eq!(
            bash,
            super::build_bash_init_line("/p", false, "/p", Some("claude"), "CLAUDE_FN;", "/rc"),
            "Bash kind reproduces build_bash_init_line exactly",
        );
        // Sandbox ⇒ byte-for-byte the distro builder's output (env + cd baked in, shell kind ignored).
        let sandbox = super::build_session_init_line(
            true, crate::platform::shell::ShellKind::Bash,
            "/home/agent/p", false, "/home/agent/p", Some("claude"), true, "CLAUDE_FN;", "/rc", None, &env_map,
        );
        assert_eq!(
            sandbox,
            crate::platform::shell::sandbox_init_line("/home/agent/p", Some("claude"), &env_map),
            "sandbox routes to sandbox_init_line",
        );
    }

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

/// Render the argv that launches `shell` inside a namespace for `role`, or `None` when this
/// session is not sandboxed.
///
/// Split out of [`pty_create_inner`] so the Linux-only half is one function rather than a `cfg`
/// scattered through the launch path — and so the Windows build consumes every parameter and
/// warns about none.
///
/// `stores_root` is a directory holding the `bsc-storefs` projections (`plan/`, `graph/`, `ui/`,
/// `coord/`). Each subdirectory that EXISTS is mounted read-only at `/<name>`; one that does not
/// is simply absent, which is the same principle the isolation itself runs on. A missing root
/// means no store surfaces at all — the agent still gets its worktree.
///
/// # What this DOES and DOES NOT take over from the PreToolUse hooks
///
/// `bsc-confine`, `bsc-scope` and `bsc-deny` inspect a tool's declared payload and are blind to
/// whatever it spawns; the kernel is not. Once this returns `Some`, the mount namespace is the
/// floor for **path confinement** — an out-of-root path is absent rather than refused, for every
/// descendant.
///
/// It does **not** take over the rest, because a namespace is path-granular: `bsc-scope` enforces
/// globs *within* the one read-write worktree, and `bsc-deny` polices the shape of a command whose
/// binary is present. See the table in `bsc_sandbox::profile`.
///
/// **And note what actually ships today:** the spec binds a curated `/usr` without `bsc`, sets no
/// `BASH_ENV`, and clears the environment to `HOME`/`TERM`, so inside the namespace those two
/// hooks do not run *at all* — they are unreachable, not demoted to telemetry. A sandboxed session
/// therefore has path confinement and no write-scope and no command check. That is a deliberate
/// consequence of not binding `bsc` (which would mean ambient authority over a writable store),
/// but it is a gap, and it is tracked rather than resolved.
///
/// None of this is a global claim: on a host with no mount namespace the hooks remain the whole
/// floor (see the `cfg(not(linux))` twin below, which refuses to pretend otherwise).
/// Which systemd scope this host will actually let us create — probed ONCE, then reused.
///
/// It has to be probed rather than assumed, and that is not a hypothetical: `systemd-run --scope`
/// creates a SYSTEM scope, and an ordinary user gets
/// `Failed to start transient scope unit: Interactive authentication required.` — the session dies
/// before the shell ever runs. Agents are unprivileged by design (#1994 gives each its own Linux
/// user), so the system scope is the mode almost nothing can use.
///
/// Order is user → system → none, i.e. least privilege that works. `--user` needs a running
/// `systemd --user` for this uid, which a `useradd`-created agent lacks until `loginctl
/// enable-linger` is set for it, so it is tried and not presumed either.
///
/// Cached because this spawns processes and a launch must not pay for it per pane.
#[cfg(target_os = "linux")]
fn scope_mode() -> bsc_sandbox::Scope {
    use std::sync::OnceLock;
    static MODE: OnceLock<bsc_sandbox::Scope> = OnceLock::new();
    *MODE.get_or_init(|| {
        let works = |args: &[&str]| {
            std::process::Command::new("systemd-run")
                .args(args)
                .arg("--")
                .arg("/bin/true")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        };
        if works(&["--user", "--scope", "--quiet", "--collect"]) {
            log::info!("sandbox: cgroup caps via the USER systemd scope");
            return bsc_sandbox::Scope::User;
        }
        if works(&["--scope", "--quiet", "--collect"]) {
            log::info!("sandbox: cgroup caps via a SYSTEM systemd scope (running privileged)");
            return bsc_sandbox::Scope::System;
        }
        // Loud, and specific about what is and is not lost. A session that believes it has a memory
        // cap it does not have is how one runaway agent takes the machine down (#795).
        log::warn!(
            "sandbox: NO systemd scope available — sessions will be isolated but UNBOUNDED.              The namespace (filesystem, pid, network) is unaffected; the cgroup memory/task/CPU              caps are NOT applied. `systemd-run --user` needs a user systemd instance for this              uid: `loginctl enable-linger <user>` during provisioning fixes it."
        );
        bsc_sandbox::Scope::None
    })
}

#[cfg(target_os = "linux")]
fn namespace_argv(
    role: Option<&str>,
    pane_id: &str,
    cwd: &str,
    stores_root: Option<&str>,
    shell: &str,
) -> Option<Vec<String>> {
    use bsc_sandbox::profile::{for_role, Role, SessionPaths};
    use std::path::PathBuf;

    let role_name = role.filter(|r| !r.is_empty())?;
    // A closed set: an unrecognised role is REFUSED, never defaulted to something permissive.
    // Falling back to "no sandbox" here would be worse than failing — the caller asked for
    // isolation and would silently not get it.
    let Some(role) = Role::parse(role_name) else {
        log::error!(
            "pty[{pane_id}] sandbox role {role_name:?} is not recognised — refusing to launch \
             UNSANDBOXED. Known roles: planner worker director triage tester reviewer issuer \
             juror documentor designer"
        );
        return None;
    };
    if cwd.is_empty() {
        log::error!("pty[{pane_id}] sandbox role {role_name:?} needs a cwd to bind at /repo");
        return None;
    }

    let mut paths = SessionPaths { root: PathBuf::from(cwd), ..Default::default() };
    if let Some(root) = stores_root.filter(|r| !r.is_empty()) {
        let root = PathBuf::from(root);
        for name in ["plan", "graph", "ui", "coord"] {
            let dir = root.join(name);
            if dir.is_dir() {
                paths.stores.push((name.to_string(), dir));
            }
        }
        // The writable holes, bound AFTER their read-only projections so each lands on top rather
        // than being overmounted. The mountpoint must already exist inside the projection — bwrap
        // cannot mkdir inside a read-only bind.
        for (proj, guest) in [("coord", "/coord/out"), ("ui", "/ui/out")] {
            let out = root.join(proj).join("out");
            if out.is_dir() {
                paths.outboxes.push((guest.to_string(), out));
            }
        }
    }

    // The pane id is already unique per session, which is exactly what a systemd scope name needs:
    // `--unit` refuses a name that is still loaded, so a fixed one makes the second launch fail.
    let unit: String = format!("bsc-{pane_id}")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();

    match for_role(role, unit, &paths, &[], Default::default(), scope_mode(), vec![shell.to_string(), "-i".into()]) {
        Ok(p) => {
            if let Some(c) = &p.caveat {
                // A profile that knowingly grants more than the model wants must be visible at the
                // point of launch, not only in a doc comment.
                log::warn!("pty[{pane_id}] sandbox caveat: {c}");
            }
            match p.spec.render() {
                Ok(argv) => {
                    log::info!(
                        "pty[{pane_id}] launching sandboxed as {role_name} — {} store(s), {} outbox(es)",
                        paths.stores.len(),
                        paths.outboxes.len()
                    );
                    Some(argv)
                }
                Err(e) => {
                    log::error!("pty[{pane_id}] sandbox spec rejected: {e}");
                    None
                }
            }
        }
        Err(e) => {
            log::error!("pty[{pane_id}] sandbox profile refused: {e}");
            None
        }
    }
}

/// Windows and macOS have no mount namespace to put a session in, so a sandbox request cannot be
/// honoured. Returning `None` keeps the launch path identical to what it was before this existed.
///
/// It does NOT silently downgrade a request: the caller is told, loudly, that it asked for
/// isolation it is not getting. The hooks remain the floor on those platforms, which is why
/// nothing here demotes them.
#[cfg(not(target_os = "linux"))]
fn namespace_argv(
    role: Option<&str>,
    pane_id: &str,
    _cwd: &str,
    _stores_root: Option<&str>,
    _shell: &str,
) -> Option<Vec<String>> {
    if role.is_some_and(|r| !r.is_empty()) {
        log::warn!(
            "pty[{pane_id}] a sandbox role was requested but this platform has no mount namespace \
             — launching UNSANDBOXED with the PreToolUse hooks as the floor"
        );
    }
    None
}

// ── the namespace launch arm (phase-2 slice 3) ───────────────────────────────────────────────
//
// These are the LAUNCH-PATH tests. The spec rendering itself is covered in `bsc-sandbox`; what
// matters here is the glue: does a role name become a namespace, does an unknown one REFUSE, and
// does the argv this produces actually run.

#[cfg(test)]
mod namespace_tests {
    use super::{namespace_argv, namespace_supported};

    #[test]
    fn the_probe_agrees_with_what_the_launcher_will_actually_do() {
        // The invariant that matters: `sandbox_available()` must not claim a capability
        // `namespace_argv` then refuses. If it did, the frontend would write a hook list pointing at
        // /bsc-hook for a session that launches unsandboxed — no write-scope, no command floor.
        let rendered = namespace_argv(Some("worker"), "probe", "/tmp/wt", None, "bash").is_some();
        if namespace_supported() {
            assert!(rendered, "the probe says yes, so the launcher must render");
        } else {
            assert!(!rendered, "the probe says no, so the launcher must refuse");
        }
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn a_host_with_no_mount_namespace_reports_false_at_compile_time() {
        // Not a runtime probe here: a `bwrap` reachable through some emulation layer must not make
        // Windows claim an isolation it cannot provide.
        assert!(!namespace_supported());
    }


    #[test]
    fn no_role_means_no_namespace_and_the_launch_path_is_untouched() {
        assert!(namespace_argv(None, "p", "/tmp", None, "bash").is_none());
        assert!(namespace_argv(Some(""), "p", "/tmp", None, "bash").is_none());
    }

    #[test]
    fn an_unknown_role_refuses_rather_than_launching_unsandboxed() {
        // The security-relevant one. A typo must NOT quietly yield a session with no isolation —
        // the caller asked for a cage and would believe it got one.
        assert!(namespace_argv(Some("wroker"), "p", "/tmp", None, "bash").is_none());
        assert!(namespace_argv(Some("root"), "p", "/tmp", None, "bash").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_known_role_renders_a_scope_wrapping_a_namespace() {
        let a = namespace_argv(Some("worker"), "pane-1", "/tmp/wt", None, "bash")
            .expect("a known role with a cwd renders");
        assert_eq!(a[0], "systemd-run", "the scope carries the cgroup limits");
        assert!(a.iter().any(|x| x == "bwrap"), "and wraps a namespace");
        assert!(a.iter().any(|x| x == "--unshare-all"));
        // The worktree is bound at /repo and the shell is last, after the final separator.
        assert!(a.windows(3).any(|w| w[0] == "--bind" && w[1] == "/tmp/wt" && w[2] == "/repo"));
        let sep = a.iter().rposition(|x| x == "--").unwrap();
        assert_eq!(&a[sep + 1..], &["bash".to_string(), "-i".to_string()]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn an_empty_cwd_refuses_because_there_is_nothing_to_bind_at_repo() {
        assert!(namespace_argv(Some("worker"), "p", "", None, "bash").is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_scope_name_is_derived_from_the_pane_so_two_launches_do_not_collide() {
        // systemd refuses a --unit that is still loaded, so a FIXED name makes the second launch
        // of a pane silently fail to start.
        let a = namespace_argv(Some("worker"), "studio:worker-1", "/tmp/wt", None, "bash").unwrap();
        let unit = a.iter().find(|x| x.starts_with("--unit=")).expect("a unit is named");
        assert!(unit.contains("studio"), "the pane id is in the unit: {unit}");
        assert!(!unit.contains(':'), "and sanitized to be unit-safe: {unit}");
        let b = namespace_argv(Some("worker"), "studio:worker-2", "/tmp/wt", None, "bash").unwrap();
        assert_ne!(unit, b.iter().find(|x| x.starts_with("--unit=")).unwrap());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_store_projections_that_exist_are_mounted() {
        // A store the caller has not projected is ABSENT, not empty — the same principle the
        // isolation runs on. Inventing a mount for a missing dir would fail the launch instead.
        let root = std::env::temp_dir().join(format!("bsc-ns-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(root.join("plan"));
        let _ = std::fs::create_dir_all(root.join("coord").join("out"));
        let a = namespace_argv(
            Some("worker"),
            "p",
            "/tmp/wt",
            Some(root.to_str().unwrap()),
            "bash",
        )
        .unwrap();

        assert!(a.iter().any(|x| x == "/plan"), "the projected store is mounted");
        assert!(!a.iter().any(|x| x == "/graph"), "an unprojected store is NOT");
        // The writable hole lands AFTER its read-only projection, or it is overmounted.
        let coord = a.iter().position(|x| x == "/coord").unwrap();
        let out = a.iter().position(|x| x == "/coord/out").unwrap();
        assert!(out > coord);
        let _ = std::fs::remove_dir_all(&root);
    }

    // The end-to-end one: the argv the LAUNCH PATH produces is executed for real, and the escape
    // that a PreToolUse hook cannot see is checked against it. Everything above asserts strings;
    // this asserts behaviour.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_rendered_argv_actually_isolates_when_executed() {
        use std::process::Command;
        if Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let base = std::env::temp_dir().join(format!("bsc-ns-exec-{}", std::process::id()));
        let mine = base.join("mine");
        let theirs = base.join("theirs");
        std::fs::create_dir_all(&mine).unwrap();
        std::fs::create_dir_all(&theirs).unwrap();
        std::fs::write(theirs.join("secret.txt"), "SECRET").unwrap();

        let argv = namespace_argv(Some("worker"), "exec-test", mine.to_str().unwrap(), None, "sh")
            .expect("renders");
        // Replace the trailing interactive shell with a one-shot probe.
        let sep = argv.iter().rposition(|x| x == "--").unwrap();
        let mut cmd = Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/dash", "-c", &format!("cat {}/secret.txt", theirs.display())]);
        let out = cmd.output().expect("the rendered argv is executable");

        assert!(
            !out.status.success(),
            "a sibling worktree must be UNREACHABLE from inside the namespace; got: {}",
            String::from_utf8_lossy(&out.stdout)
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
