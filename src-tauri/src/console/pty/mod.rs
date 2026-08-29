// PTY session lifecycle: the state registry, the pty_* Tauri commands, and the
// mobile-tunnel bridge (extracted from lib.rs, #758). The session env wiring
// (`wire_bsc_env` + the bsc-* sidecar resolvers) lives in [`env`], the launch
// decision + bash init line in [`launch`], the reader/emitter IO pump in [`pump`],
// and the process-tree kill primitive (`PtyJob`) in [`job`] (#1660). Split out of a
// single ~1150-line mod.rs (#1864); `pty_create` stays the readable orchestration.

use crate::nearest_existing_ancestor;
use crate::mobile::tunnel;
use crate::observability::perf;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub(crate) mod busy;
mod env;
mod launch;
mod pump;
pub(crate) mod scrollback;

// Session env wiring + the sidecar resolvers used at the same `crate::console::pty::*` paths as
// before the split (`extensions/mcp.rs`, `app/run.rs`, `github/readiness.rs`).
pub(crate) use env::{
    bsc_bin_path, humanize_gap, session_env, sidecar_status, stage_dev_sidecars, stale_sidecars,
};
#[cfg(target_os = "linux")]
use env::bsc_hook_bin_path;
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
/// The smallest grid a session may be BORN into. Below this a full-screen TUI has nowhere to draw,
/// and — the part that costs a diagnosis — nothing it prints on the way up survives legibly, so the
/// session's own last words come back as squeezed-together fragments.
///
/// 80x24 is not a taste: it is what xterm.js reports before it has measured anything, so a clamped
/// session starts at exactly the size an unmeasured one already does. See `clamp_grid`.
const MIN_GRID: (u16, u16) = (80, 24);

/// Floor a requested grid, saying so when it fires.
///
/// PURE, so the rule is testable without a PTY. The log line is the point as much as the clamp is:
/// a pane whose measurement arrives before its layout is a FRONTEND bug, and silently correcting it
/// here would hide the only evidence that it happens.
fn clamp_grid(pane_id: &str, cols: u16, rows: u16) -> (u16, u16) {
    let (c, r) = (cols.max(MIN_GRID.0), rows.max(MIN_GRID.1));
    if (c, r) != (cols, rows) {
        log::warn!(
            "pty[{pane_id}] requested a {cols}x{rows} grid — too small for a full-screen agent to \
             draw in, and too narrow for its output to be readable afterwards. Starting at {c}x{r}; \
             the pane's own refit will follow with the real size. The measurement ran before the \
             pane's layout settled."
        );
    }
    (c, r)
}

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

/// Is there a session for `pane_id` worth reconnecting to — and if not, drop the dead one.
///
/// `true` means reconnect (the tab-switch case this gate exists for). `false` means the caller
/// should create a real session; any tombstone has already been removed from `sessions`.
///
/// **Membership is not the question — liveness is.** `pty_kill` is the only other place that
/// removes an entry, so a child that exits on its OWN leaves its `PtySession` in the map forever.
/// That entry then shadows the pane: every relaunch takes the reconnect branch and returns, writing
/// the init line into a PTY whose process is gone, while the frontend's resume keeps typing into
/// nothing. Observed on a fleet director that exited 1 ten seconds after launch — five relaunches
/// in ten minutes, every one refused, until the app was restarted. The pane cannot recover on its
/// own because the thing that would fix it is the very call being refused.
///
/// Nothing else needs unwinding here: the pane's perf registration and its ledger entry are both
/// keyed by `pane_id` and REPLACED by the create that follows (`attach_job_and_track` →
/// `perf::register` / `ledger::record`, which retains-by-pane_id). Reaping them here as well would
/// leave a window where a pane the app still shows is tracked by nothing.
fn reconnect_or_reap(sessions: &mut HashMap<String, PtySession>, pane_id: &str) -> bool {
    let Some(session) = sessions.get_mut(pane_id) else {
        return false;
    };
    match session.child.try_wait() {
        // Still running — the reconnect this gate is for.
        Ok(None) => true,
        // The child is gone. Reap the tombstone so the caller creates a fresh session.
        Ok(Some(status)) => {
            let code = status.exit_code();
            log::info!(
                "pty[{pane_id}] previous session had already exited (exit={code}) — recreating rather than reconnecting"
            );
            sessions.remove(pane_id);
            false
        }
        // Unreadable status: treat it as ALIVE. Recreating over a session that is merely
        // unreadable would abandon a running agent and its process tree; refusing to recreate
        // costs a relaunch the user can retry. The cheap mistake is the one to make.
        Err(e) => {
            log::warn!("pty[{pane_id}] could not read child status ({e}) — assuming alive and reconnecting");
            true
        }
    }
}

/// Create a caged pane's store root: the coordination outbox first, then the emitter rc inside it.
/// `None` means the outbox could not be made, so the caller gives the session no store root at all.
///
/// **The ORDER is the fix.** The rc write used to come first, against a `root` that nothing had
/// created yet — so on a pane's FIRST launch it failed ENOENT and `let _ =` swallowed it. The bind
/// is then skipped (`namespace_argv` sets `paths.rc_file` only `if rc.is_file()`), and the init
/// line's `source "/bsc-rc" 2>/dev/null` is a silent no-op: the session comes up with no `bsc-ask`,
/// no `bsc-wait`, no `bsc-answer`, and none of the `bsc-landed/merged/closed/failed` completion
/// emitters — the entire coordination surface, missing, with nothing said anywhere.
///
/// The SECOND launch of the same pane worked, because by then the directory existed. That is why it
/// survived so long: on a machine with real sessions every sandbox store had an rc except the one
/// pane that had only ever launched once.
///
/// A failed rc write is now LOGGED rather than swallowed. It stays non-fatal — a session that can
/// read its stores but not emit is still worth having — but "the agent silently cannot coordinate"
/// is not a state anyone should have to discover by listing directories.
fn scaffold_store_root(pane_id: &str, root: &std::path::Path) -> Option<()> {
    let outbox = root.join("coord").join("out");
    if let Err(e) = std::fs::create_dir_all(&outbox) {
        log::warn!("pty[{pane_id}] no coordination outbox ({e}); the session cannot emit");
        return None;
    }
    // ...and the PLAN outbox, so a session can record what it did. Non-fatal on its own: a session
    // that can coordinate but not record is degraded, where one that cannot emit at all has no way
    // to say so. The mountpoint has to exist on the host before bwrap can bind it, and the
    // projection it lands in is read-only, so it cannot be created from inside.
    if let Err(e) = std::fs::create_dir_all(root.join("plan").join("out")) {
        log::warn!(
            "pty[{pane_id}] no plan outbox ({e}); this session cannot open a change record, \
             record gate evidence, move its item or file a request"
        );
    }
    // ...and the COMPONENT outbox, which nothing has ever created.
    //
    // `namespace_argv` only binds an outbox whose host directory already exists (bwrap cannot mkdir
    // inside a read-only projection), so `("ui", "/ui/out")` has been in the bind list and silently
    // skipped on every launch — a real one logged `1 outbox(es)`, which is coord alone. The
    // designer's whole WRITE surface, the thing `/ui/out` names in the worker protocol and in
    // `bsc_storefs::ui`'s own docs, has never existed in any cage.
    if let Err(e) = std::fs::create_dir_all(root.join("ui").join("out")) {
        log::warn!("pty[{pane_id}] no component outbox ({e}); this session cannot author a component");
    }
    // The emitter rc travels with the outbox: written on the host, bound read-only into the cage,
    // sourced by the init line. See `sandbox_emitter_rc` for why it is a file.
    if let Err(e) = std::fs::write(root.join("bsc-rc"), launch::sandbox_emitter_rc()) {
        log::warn!(
            "pty[{pane_id}] no coordination emitters ({e}); bsc-ask / bsc-wait / bsc-answer and the \
             completion emitters will be undefined in this session"
        );
    }
    Some(())
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

/// Is the role gate actually on disk for this launch cwd?
///
/// `.claude/settings.json` is per-DIRECTORY and durable, so this is a question about the DIRECTORY,
/// not about the pane — a recovered cwd inherits whatever a previous launch wrote there.
pub(crate) fn gate_file_present(effective_cwd: &str) -> bool {
    !effective_cwd.is_empty()
        && std::path::Path::new(effective_cwd).join(".claude").join("settings.json").is_file()
}

/// Why an agent auto-launch would be REFUSED for this pane at this cwd, or `None` if it is admitted.
///
/// Extracted so the refusal can be asked BEFORE anything destructive happens, by exactly the
/// predicate that will apply at launch. `a-wake-kills-a-pane-it-cannot-relaunch-and-reports-success`:
/// a wake kills the PTY first (deliberately — otherwise the remount reconnects and the baked prompt
/// is dropped), and the store's verdict only answers whether a tab and a grid seat could be resolved.
/// So a pane whose worktree has no gate file was killed, then refused here, and the director was told
/// `woke: true`. FOUR network-monitor worktrees were in that state.
///
/// Two callers were the design at first — this same function, asked before the kill AND inside the
/// real spawn (`pty_create_inner`, below) — reasoning that a second copy could drift and fail in the
/// worst direction: a pre-check saying "admitted" while the launch refuses.
///
/// That held for every cause except one, and requests #142 (network-monitor) and #150 (studio-code) are
/// what it looks like in practice: a worktree whose `.claude/settings.json` was NEVER written — either
/// because `ensure_worktree` made the directory but no launch ever completed for this stream, or because
/// the stream is materializing for the very first time via a wake — can never self-heal under a shared
/// predicate. The ONLY code that writes that file is `ensure_session_settings`, called by
/// `TerminalView`'s mount effect immediately BEFORE `pty_create` — which means the sole way it could
/// ever get written is for a wake's kill+remount to actually happen. A precheck that refuses on a
/// missing gate file forecloses that remount forever: every wake refuses, nothing ever writes the file,
/// every future wake refuses again. `bsc fleet wake` had no lever to break the loop, and neither did
/// `bsc fleet start` (refuses on an already-running fleet without `--force`, which would relaunch every
/// OTHER pane too, disruptively, just to fix or materialize this one).
///
/// So the precheck ([`pty_launch_refusal`]) and the real launch-time check (`pty_create_inner`'s own
/// call to THIS function) now differ in exactly one case: a real, existing cwd directory with no gate
/// file yet. The precheck admits it — the imminent remount's own `ensure_session_settings` will write
/// the file before `pty_create` ever runs, so refusing here can never come true, only permanent. The
/// real spawn-time check stays exactly this function, unchanged and strict: by the time IT runs, the
/// settings write has already happened (or genuinely failed, in which case refusing is still correct —
/// this is not a case a precheck should launder). An EMPTY cwd, or a cwd that is not a real directory,
/// is still refused by both — there is no remount coming that could ever write anything into it.
pub(crate) fn launch_gate_refusal(pane_id: &str, effective_cwd: &str) -> Option<String> {
    if gate_file_present(effective_cwd) || !must_be_gated(pane_id) {
        return None;
    }
    Some(format!(
        "pty[{pane_id}] refusing to auto-launch claude at {} — no .claude/settings.json, so the role gate and shell allowlist were never written and the session would run permission-less (#1819). Relaunch the pane from its project so the settings are written first.",
        if effective_cwd.is_empty() { "<no cwd>" } else { effective_cwd }
    ))
}

/// The WAKE precheck's answer — [`launch_gate_refusal`], relaxed for the one case that predicate
/// cannot resolve on its own: a real, existing cwd directory whose gate file has simply never been
/// written. See the doc on `launch_gate_refusal` for why (requests #142/#150).
///
/// Only the "recoverable" shape is relaxed. Everything else — an empty cwd, a cwd that is not a real
/// directory, a pane that is not gated, a gate file already present — answers exactly as
/// `launch_gate_refusal` does, because none of those are fixed by letting the wake through.
pub(crate) fn wake_precheck_refusal(pane_id: &str, cwd: &str) -> Option<String> {
    let recoverable = !cwd.is_empty() && std::path::Path::new(cwd).is_dir();
    if recoverable && !gate_file_present(cwd) && must_be_gated(pane_id) {
        return None;
    }
    launch_gate_refusal(pane_id, cwd)
}

/// Ask [`wake_precheck_refusal`] from the frontend, so a destructive action can decline BEFORE it
/// destroys. Returns `None` when the launch would be admitted.
#[tauri::command]
pub(crate) fn pty_launch_refusal(pane_id: String, cwd: String) -> Option<String> {
    wake_precheck_refusal(&pane_id, &cwd)
}

fn resolve_session_cwd(pane_id: &str, cwd: String, sandbox: bool) -> ResolvedCwd {
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
    /* namespaced: a mount-namespace session — see build_bash_init_line */
    namespaced: bool,
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
    // Why a REQUESTED namespace was refused, if it was — printed in the pane so a downgrade is
    // not silent. `None` when the session IS namespaced, and when one was never asked for.
    sandbox_refused: Option<&str>,
) -> String {
    if sandbox {
        // A distro session always runs the distro's bash — bake its env + cd into the init line.
        crate::platform::shell::sandbox_init_line(cwd, launch, env_map)
    } else {
        match shell_kind {
            crate::platform::shell::ShellKind::Bash => {
                // Derived HERE rather than threaded from the caller: the rule is cwd-only, and keeping
                // it beside its one consumer means a call site cannot forget the exports and silently
                // hand the session whatever `~/.bashrc` last exported.
                let store_exports = env::store_exports_for_cwd(cwd);
                build_bash_init_line(cwd, cwd_missing, effective_cwd, launch, claude_fn, rc_bash, &store_exports, namespaced, sandbox_refused)
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
///
/// **This analysis was right and its premise was not.** It reasons about the mismatch case by
/// contrasting it with the matched one — settings sandboxed, launch sandboxed, `/bsc-hook` present.
/// That third state did not exist: nothing ever filled in `SessionPaths::hook_bin`, so `/bsc-hook`
/// was absent from EVERY namespace launch and the "no write-scope, no command floor" outcome
/// described above was what a correctly-matched sandboxed session got too. `namespace_argv` now
/// binds the hook, so the contrast is real.
///
/// One thing this probe still does NOT ask: whether `bsc_hook_bin_path()` actually resolved. A host
/// with `bwrap` but no built hook binary answers `true` here and gets a cage with kernel path
/// confinement but no scope/deny gate, while the caller drops the shell gates — the mismatch
/// direction this doc calls a regression. Making the probe require the hook would mean
/// `namespace_argv` must refuse without one too (the agreement test pins both directions), and that
/// trades real kernel confinement for the shell gates. That is a posture decision, not a bug fix,
/// and is deliberately left to the maintainer rather than taken here.
/// Hand a pane's history to the frontend and resume the live stream from exactly where it ends.
///
/// THIS IS THE SEAMLESS HANDOFF, and it is a Rust command rather than a frontend dance because only
/// the side that owns the bytes can make it atomic. The emitter publishes its cursor while holding it
/// across each emit; this takes the same lock, reads the recording up to precisely that offset, and
/// releases. So a batch is either already in `text` or still to arrive live — never both, never
/// neither. Ordering it from TypeScript could only ever choose which of those two to get wrong.
///
/// `None` when the pane has no cursor or no recording: a fresh pane, or one launched before recording
/// existed. Read that as "show an empty terminal", never as an error.
///
/// REMAINING SEAM, stated so it is not mistaken for closed: Tauri does not guarantee delivery order
/// between an event and a command reply, so an event emitted just before the lock could still reach
/// the webview after this returns. Closing that needs the event payload to carry its offset too, at
/// which point the frontend drops anything at or before `upto`. `upto` is returned for exactly that.
#[tauri::command]
pub(crate) fn pty_scrollback_reveal(
    pane_id: String,
    max_bytes: u64,
    cursors: tauri::State<'_, scrollback::Cursors>,
) -> Option<scrollback::Reveal> {
    let cursor = cursors.get(&pane_id)?;
    let guard = cursor.lock().ok()?;
    let upto = (*guard)?;
    let text = scrollback::read_upto(&scrollback::scrollback_dir(), &pane_id, upto, max_bytes)?;
    Some(scrollback::Reveal { text, upto })
}

/// A pane's recorded scrollback tail, ready to write straight into a terminal.
///
/// `None` when the pane has no recording — a fresh pane, or a session that ran before recording
/// existed. The caller must read that as "show an empty terminal", never as an error: a missing
/// history is the normal state for most panes most of the time.
///
/// Always starts at a SAFE boundary. See [`scrollback::replay_start`] for why that outranks the byte
/// budget, and the module doc for what happens when it does not.
#[tauri::command]
pub(crate) fn pty_scrollback_tail(pane_id: String, max_bytes: u64) -> Option<String> {
    scrollback::read_tail(&scrollback::scrollback_dir(), &pane_id, max_bytes)
}

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
    // If a LIVE session already exists for this pane (e.g. user switched tabs and
    // switched back), reconnect rather than recreating. A DEAD one is reaped first — see
    // `reconnect_or_reap` for why membership alone is not the question.
    if reconnect_or_reap(&mut state.0.lock().unwrap_or_else(|e| e.into_inner()), &pane_id) {
        log::info!("pty[{pane_id}] reconnect to existing session");
        return Ok(false);
    }

    // A degenerate grid is a MEASUREMENT, not a request — refuse to hand it to the kernel.
    //
    // Observed on the live desktop: `console[…] fit-on-open · box=184x25px · grid=23x1`, so the pane
    // was measured before its layout settled and the session was born into a 23-column, ONE-ROW
    // terminal, then resized to 103x21 in the same second. Every agent here is a full-screen TUI: it
    // reads the winsize at startup, lays its frame out for one row, and everything it printed on the
    // way up is unreadable — which is exactly why this pane's dying words came back as
    // `⏵⏵automodeon (shift+tabtocycle)·←foragents●high·` with the spaces squeezed out of them. The
    // evidence a stopped session leaves is worth nothing if it was written 23 columns wide.
    //
    // Clamped rather than rejected, because the pane IS real and the frontend's own refit lands
    // moments later with the true size — failing the launch would trade a cosmetic bug for a missing
    // session. The floor is the classic 80x24 (what xterm.js itself defaults to before it has
    // measured anything), so a clamped session is born at the size an unmeasured one already gets.
    let (cols, rows) = clamp_grid(&pane_id, cols, rows);

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
    // What this session's harness needs on PATH inside the cage. Claude Code is a node program
    // reached through a shim, so both have to be bound — its package lives under /usr/lib, which
    // the curated arm already binds wholesale, so the shim resolves once it is there.
    // The coordination outbox, prepared HERE because a sandboxed session cannot create it: the
    // mountpoint has to exist on the host before bwrap can bind it, and inside the cage /coord
    // would be a read-only projection anyway.
    //
    // Without it every `bsc-ask` / `bsc-maintain` in the worker protocol HANGS — the protocol
    // pipes into them, so a missing reader leaves the writer waiting rather than failing. The
    // shims in the init line write here; a drain turns these files into coord.log events.
    //
    // Best-effort: a session that cannot get an outbox still launches and simply cannot emit,
    // which is strictly better than refusing to start.
    let sandbox_stores = sandbox_stores.or_else(|| {
        let role = sandbox_role.as_deref().filter(|r| !r.is_empty())?;
        let _ = role;
        // Shared with `bsc sandbox replay` (`bsc_sandbox::sandbox_stores_root`) so a replay
        // computes the SAME path from a bare pane id — see that function's doc comment.
        let root = bsc_sandbox::sandbox_stores_root(&crate::platform::paths::bsc_base_dir(), &pane_id);
        // The outbox + the emitter rc, in that order — see `scaffold_store_root` for why the
        // order is the whole fix. `None` means no outbox, and a session that cannot emit at all
        // does not get a store root.
        scaffold_store_root(&pane_id, &root)?;
        // ...and the store projections the agent READS. Without these the launch logged
        // `0 store(s)` and a worker told to consult its plan had no way to.
        #[cfg(target_os = "linux")]
        project_stores_for(&pane_id, &cwd, &root);
        // ...and the shared /graph, built once and symlinked in (see `link_shared_graph`).
        #[cfg(target_os = "linux")]
        link_shared_graph(&pane_id, &root);
        // ...and the component store, small enough to be per-pane.
        #[cfg(target_os = "linux")]
        project_ui_for(&pane_id, &root);
        // ...and carry what the agent emits back to the host. Without this the emitters complete
        // and reach nobody — a quieter failure than the hang they replaced.
        #[cfg(target_os = "linux")]
        spawn_outbox_drain(
            pane_id.clone(),
            root.join("coord").join("out"),
            crate::platform::paths::bsc_base_dir().join("coord.log"),
        );
        // ...and the same for the PLAN outbox, so the change record, the gate evidence, the status
        // transition and the request lane have a path out of the cage.
        #[cfg(target_os = "linux")]
        spawn_plan_drain(pane_id.clone(), root.join("plan").join("out"), cwd.clone());
        // ...and `/ui/out`, which has been a mount with NOTHING behind it: the bind existed, the
        // pure drain existed in `bsc-storefs`, and the only caller was an example. A designer
        // authoring into it wrote into a directory nobody read.
        #[cfg(target_os = "linux")]
        spawn_ui_drain(pane_id.clone(), root.join("ui").join("out"));
        Some(root.to_string_lossy().into_owned())
    });

    let harness_bins: &[&str] = match provider_id.as_deref() {
        Some("claude") | None => &["node", "claude"],
        // Any other provider names its own runtime; an unknown one gets no extra binaries rather
        // than a guess, so the failure is "command not found" and not a silently widened cage.
        Some(_) => &[],
    };
    // The gate's CONFIG, read from the caller's env rather than from a new parameter.
    //
    // `buildAgentEnv` already computes both values for every gated pane — `BSC_SCOPE_GLOBS` (the
    // role's write globs, or the `__bsc_deny_all__` sentinel for a `code: none` role) and
    // `BSC_DENY_BASH` (the role/user/profile deny patterns). They reach here in `env` and are then
    // DISCARDED for a caged session, because the namespace clears the environment and `hook_env`
    // supplies the whole of it. Taking them from the same map is what keeps ONE decision driving
    // both the settings.json the frontend writes and the gate the cage runs; a second parameter
    // computed a second way is exactly how those two drift apart.
    //
    // Guest-safe by construction: these globs are REPO-RELATIVE (`src/auth/**`, the planner's plan
    // globs, the director's commons carve-out), and the gate normalizes a tool's `file_path`
    // against `BSC_REPO_ROOT=/repo` before matching. A host-shaped glob would fail to strip and
    // every write would read as out-of-scope — fails closed, but wedges the agent, so
    // `namespace_argv` refuses one rather than passing it through.
    let gate_env = env.as_ref();
    let ns_argv: Option<Vec<String>> = namespace_argv(
        sandbox_role.as_deref(),
        &pane_id,
        &cwd,
        sandbox_stores.as_deref(),
        &shell,
        harness_bins,
        GateConfig {
            scope_globs: gate_env
                .and_then(|e| e.get("BSC_SCOPE_GLOBS"))
                .map(String::as_str)
                .unwrap_or_default(),
            deny_bash: gate_env
                .and_then(|e| e.get("BSC_DENY_BASH"))
                .map(String::as_str)
                .unwrap_or_default(),
        },
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
    // Count this session's skill ATTACH (#A), for the non-Claude harness.
    //
    // `record_skill_uses` lives in `ensure_session_settings`, which its own doc calls "the single
    // backend chokepoint both manual launches and fleet workers funnel through, so usage is counted
    // UNIFORMLY + model-agnostically". That was not true: a bsc-agent pane never reaches that command
    // (TerminalView gates it on `isClaudeProvider`), so the counter under-counted precisely the
    // non-Claude sessions the comment claimed to cover. The skills now arrive here as
    // `$BSC_AGENT_SKILLS`, so this is where the local half of that promise gets kept.
    //
    // Same function, so a skill counts once per launch on either harness and the two cannot drift.
    // Best-effort throughout — a launch is never blocked by telemetry.
    if let Some(raw) = env_map.get("BSC_AGENT_SKILLS") {
        match serde_json::from_str::<Vec<crate::extensions::cfg::SkillCfg>>(raw) {
            Ok(skills) => crate::extensions::skills::record_skill_uses(&skills),
            Err(e) => log::warn!("pty[{pane_id}] BSC_AGENT_SKILLS unparseable, not counted: {e}"),
        }
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
    // Held for the `created` line below: the one identifier that joins this session to `journalctl`,
    // `ps`, the pty ledger and `pty-job`'s SIGKILL line. It has to be read here, while the child is
    // still owned locally — once the session is in the registry the log line is past it.
    let session_pid = child.process_id();

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
    // A CAGED session's transcripts are NOT where the host would look for them, and looking in the
    // wrong place made every caged session start over.
    //
    // `detect_history` resolves `~/.claude/projects/<slug(cwd)>` on the HOST, from the HOST cwd. Inside
    // the namespace the harness writes to its private HOME, whose `.claude/projects` is bound to this
    // pane's `history_dir` (`<stores_root>/home/projects`), and it keys the directory by the GUEST cwd
    // — always `/repo`, hence `-repo`. The two can never agree: the host check asks about a path the
    // caged harness never writes to, so `has_history` was false on EVERY caged launch and the launch
    // plan resolved to a fresh session every time.
    //
    // Observed on `network-monitor:domain-model-and-adapter-traits`: FOUR separate conversations in its
    // cage (4, 11, 19 and 0 assistant turns), one per launch, each starting from nothing while the log
    // recorded `has_history=false · resumed=false` — with three prior transcripts sitting right there.
    // A worker that is relaunched loses everything it learned, which is most of what makes a relaunch
    // look like a session that was killed for no reason.
    let has_history = match caged_history_dir(sandbox_stores.as_deref(), ns_argv.is_some()) {
        Some(dir) => harness.detect_history_at(&dir),
        None => harness.detect_history(&cwd),
    };
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
    // WHICH conversation, not merely whether to resume one.
    //
    // `--continue` means "the newest transcript in this directory" by mtime, and that is a different
    // question from "the conversation this pane was having". Measured on a live architect: a 24KB
    // conversation sat unreachable beside a 3KB metadata-only stub, because the stub was newer. A
    // cancelled `/resume`, a launch that died before its first turn, or late `cost-state` appends to a
    // finished transcript are all enough to shadow the real thread permanently.
    //
    // `lastSessionId` is Claude's own record for this directory, and Claude MAINTAINS it — a `/clear`
    // forks a new session and the field follows — so naming it pins the pane to its own conversation
    // WITHOUT freezing it against the user clearing context.
    //
    // A CAGED session is deliberately excluded: its transcripts live in the cage's private HOME under
    // the guest cwd, so the host's `~/.claude.json` says nothing about it and `--continue` remains the
    // only honest answer there.
    let resume_id: Option<String> = if resumed && ns_argv.is_none() {
        crate::session::claude_config::last_session_id(&cwd)
    } else {
        None
    };
    log::info!(
        "pty[{pane_id}] launch decision · has_history={has_history} · resumed={resumed}{}",
        match &resume_id {
            Some(id) => format!(" · session={id}"),
            // Said out loud: a resume with no id falls back to newest-wins, which is the behaviour
            // that loses a conversation, so it should never be silent.
            None if resumed => " · session=unknown (falling back to --continue)".to_string(),
            None => String::new(),
        }
    );
    let launch = match plan {
        LaunchPlan::Prompt { resume } => Some(harness.launch_command(
            startup_prompt.as_deref().unwrap_or(""),
            // `resume` says WHETHER; `resume_id` says WHICH. Without an id the harness keeps its old
            // behaviour rather than launching fresh — a worse resume beats no resume.
            if resume { resume_id.as_deref() } else { None },
        )),
        // An `initCmd` is a literal shell line the caller composed (`claude --continue || claude` for
        // a studio), so the substitution happens on the STRING. Rewriting rather than re-composing
        // keeps every existing caller — studio, triage, fleet — on one code path.
        LaunchPlan::Init(s) => Some(match &resume_id {
            Some(id) if s.contains("--continue") => {
                s.replace("--continue", &format!("--resume {}", crate::bash_ansi_c_quote(id)))
            }
            _ => s,
        }),
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
        // A pane with a PROJECT identity is refused outright. Running one of these ungated is the
        // one outcome worse than not starting: a director is `code: none`, a worker is scoped to
        // its owned globs, and permission-less it has neither. A manual console is the user's own
        // shell and they are the principal, so it keeps the loud warning instead.
        if let Some(msg) = launch_gate_refusal(&pane_id, &effective_cwd) {
            return Err(msg);
        }
        if !gate_file_present(&effective_cwd) {
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
    // The pane has to SAY when it asked for a cage and did not get one. This reads the same
    // `sandbox_refusal` the refusal itself does, so the notice and the decision cannot disagree.
    #[cfg(target_os = "linux")]
    let ns_refused: Option<String> =
        if sandbox_role.as_deref().is_some_and(|r| !r.trim().is_empty()) && ns_argv.is_none() {
            sandbox_refusal(&cwd)
        } else {
            None
        };
    #[cfg(not(target_os = "linux"))]
    let ns_refused: Option<String> = None;

    // A floor that cannot run must SAY SO. Read the settings this session will actually obey and
    // compare its hook list against the cage it actually got — see `hook_floor_mismatch` for why one
    // launch-time decision does not make these agree across launches.
    //
    // Reported on TWO surfaces on purpose. `log::error!` because the original failure existed only as
    // transient text in a transcript — grepping every app log for it returned nothing, so "the gates
    // are not running" had no durable trace at all. The pane notice because the person who can act on
    // it is looking at the pane, not at a log.
    let hook_mismatch: Option<String> = (!cwd_empty)
        .then(|| {
            let cfg = crate::platform::fsx::read_json_object_or_default(
                &std::path::Path::new(&cwd).join(".claude").join("settings.json"),
            );
            crate::session::settings::hook_floor_mismatch(&cfg, ns_argv.is_some())
        })
        .flatten();
    if let Some(msg) = &hook_mismatch {
        log::error!("pty[{pane_id}] UNGATED: {msg}");
    }

    let init_line = build_session_init_line(
        into_sandbox.is_some(),
        ns_argv.is_some(), resolved_shell.kind, &cwd, cwd_missing, &effective_cwd,
        launch.as_deref(), launch_claude, &claude_fn, &rc_bash, model_alias.as_deref(), &env_map,
        // Only when a namespace was actually REQUESTED and did not happen. A pane with no role was
        // never going to be caged, and a notice there would be noise rather than information.
        //
        // The dead-hook-floor notice rides the same channel: it is the same class of fact (a gate the
        // session is missing) and the same audience. A refusal already implies the floor is dead, so
        // the two are joined rather than printed twice.
        match (ns_refused.as_deref(), hook_mismatch.as_deref()) {
            (Some(r), Some(h)) => Some(format!("{r}\n{h}")),
            (Some(r), None) => Some(r.to_string()),
            (None, Some(h)) => Some(h.to_string()),
            (None, None) => None,
        }
        .as_deref(),
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
    let (tx, rx) = std::sync::mpsc::channel::<(String, Option<u64>)>();
    // Registered BEFORE the emitter starts, and replacing any cursor a previous session with this
    // pane id left behind — a relaunched pane records afresh and must not inherit an offset that
    // addressed the old stream.
    let cursor = app
        .try_state::<scrollback::Cursors>()
        .map(|c| c.register(&pane_id))
        .unwrap_or_else(|| std::sync::Arc::new(std::sync::Mutex::new(None)));
    spawn_reader(pane_id.clone(), reader, tx);
    spawn_emitter(pane_id.clone(), app.clone(), rx, cursor, sandbox_role.clone());

    // `pid` and `launch` are both here because both were missing when they were needed.
    //
    // The pid is the join to everything OUTSIDE the app — `journalctl` on the scope unit, `ps`, the
    // pty ledger, and `pty-job`'s own SIGKILL line, which prints the process GROUP (== this pid,
    // since portable_pty `setsid`s the child). Without it, "the session died" and "this scope unit
    // stopped" are two records with nothing to match on.
    //
    // `launch` is the command that actually ran. This line used to print `init_cmd`, which is EMPTY
    // whenever the launch is a baked startup prompt — so a resumed worker logged `init=<none>` while
    // really running `claude --continue $'…'`, and the log positively denied that anything was
    // launched at all. It is the resolved `launch`, so it can never disagree with what was written
    // into the shell.
    log::info!(
        "pty[{}] created · {}x{} · pid={} · provider={} · shell={} · cwd={} · launch={}",
        pane_id, cols, rows,
        session_pid.map(|p| p.to_string()).unwrap_or_else(|| "<unknown>".into()),
        provider_id.as_deref().unwrap_or("claude"),
        shell,
        if cwd_empty { "<none>" } else { cwd.as_str() },
        launch.as_deref().filter(|s| !s.is_empty()).unwrap_or("<none>"),
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

/// Per-pane liveness for `bsc fleet` (#4098) and `bsc session list` (#154), shaped as the CLI's wire
/// type.
///
/// An EMPTY `pane_ids` means "every pane the app is tracking" — the CLI asks that way when there is no
/// roster to narrow by, and only the app knows the full set.
///
/// Reuses the same one-walk batching as [`pty_pane_runtime`]: the descendant probe is the expensive
/// part, so the pids are collected under the lock, the lock is DROPPED, and the walk happens once for
/// all of them. It also reports the pid, which is the thing the original report had to leave the app
/// and run `tasklist` to find.
///
/// **`live` is confirmed with `try_wait`, not read off map PRESENCE (#154).** A child that exits on
/// its own — no reconnect, no `pty_kill` — keeps its `PtySession` in the map forever; see
/// `reconnect_or_reap`'s doc for why that tombstone is left for the create path to clear. A liveness
/// query answered from `contains_key` alone therefore reports a dead pane as live, with its last real
/// pid, indefinitely — which is exactly the bug reported against `bsc session list`: a session showed
/// `live: true, busy: true` with a real pid while it was actually off, an `Ok(Some(_))` from
/// `try_wait` that nothing had ever consulted. Reporting `pid: None` for a confirmed-dead child also
/// keeps a since-recycled pid out of the `busy`/`agent` process-table walk below, which is what let a
/// dead session's stale pid read as busy in the first place.
pub(crate) fn pane_liveness(pane_ids: Vec<String>, state: &PtyState) -> Vec<bsc_fleet::PaneLive> {
    let (ids, live, pids): (Vec<String>, Vec<bool>, Vec<Option<u32>>) = {
        let mut sessions = state.0.lock().unwrap();
        let wanted: Vec<String> = if pane_ids.is_empty() {
            sessions.keys().cloned().collect()
        } else {
            pane_ids
        };
        let mut ids = Vec::with_capacity(wanted.len());
        let mut live = Vec::with_capacity(wanted.len());
        let mut pids = Vec::with_capacity(wanted.len());
        for id in wanted {
            let (is_live, pid) = match sessions.get_mut(&id) {
                Some(s) => match s.child.try_wait() {
                    // Confirmed exited — report dead, and withhold the now-stale pid.
                    Ok(Some(_)) => (false, None),
                    // Still running, OR the status is unreadable. An unreadable status is treated as
                    // alive for the same reason `reconnect_or_reap` does: the cheap mistake is a
                    // stale "running" report, not abandoning a process that is actually still there.
                    _ => (true, s.child.process_id()),
                },
                None => (false, None),
            };
            ids.push(id);
            live.push(is_live);
            pids.push(pid);
        }
        (ids, live, pids)
    };
    let busy = busy::shells_with_descendants(&pids);
    // A SECOND, narrower probe (#fleet-list-reports-whether-the-agent-is-running). `busy` answers "may
    // I type here" and stays broad on purpose; this answers "is the agent working", which is what the
    // fleet table reports. They differ on exactly the panes that matter: a sandboxed pane is `busy` at
    // a bare prompt (its own `bwrap` and the shell inside are descendants), and a shell mid-build is
    // busy with no agent at all.
    let agent = busy::shells_with_agents(&pids);
    // A THIRD probe, narrower still (#session-list-reports-every-agent-session-as-busy): `agent` says an
    // agent is PRESENT, which an idle one equally is, so `bsc session list` needs "is it running
    // something" — the agent having a child of its own.
    let working = busy::agents_doing_work(&pids);
    ids.into_iter()
        .zip(live)
        .zip(busy)
        .zip(agent)
        .zip(working)
        .zip(pids)
        .map(|(((((pane_id, live), busy), agent), working), pid)| bsc_fleet::PaneLive { pane_id, live, busy, agent, working, pid })
        .collect()
}

/// Whether this is the FIRST write to `pane_id` since it vanished from the session map.
///
/// Exists so a dead pane reports itself exactly once. A user typing into a pane whose shell has exited
/// produces one call per keystroke, and the choice is between a silent drop (which is what hid this bug)
/// and a log line per keypress (which buries it). Neither is a report; the first one is.
///
/// The set is never pruned: a pane id is short, they are bounded by the panes a user opens, and a pane
/// that comes back to life writes through the `Some` arm without consulting this at all.
fn first_write_to_missing(pane_id: &str) -> bool {
    static SEEN: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    SEEN.get_or_init(Default::default)
        .lock()
        .map(|mut s| s.insert(pane_id.to_string()))
        .unwrap_or(true)
}

/// Write bytes into a pane's PTY, reporting whether a session was actually there to take them.
///
/// Split out of [`pty_write`] so the BACKEND can deliver an ask to a live session
/// (`session::deliver`) without routing through the frontend command — and, unlike the command, it
/// says whether the write landed. A caller that is delivering a request has to be able to tell "sent"
/// from "there was no session", which is exactly the distinction `pty_write` swallows on purpose for
/// the keystroke path.
///
/// EVERY caller of this is an injector. See `rust_injectors_are_ratcheted` in `crate::tests` and the
/// module doc of `session::deliver` before adding one.
pub(crate) fn write_pane(pane_id: &str, data: &str, state: &PtyState) -> bool {
    let mut sessions = state.0.lock().unwrap();
    match sessions.get_mut(pane_id) {
        Some(s) => match s.writer.write_all(data.as_bytes()) {
            Ok(()) => true,
            Err(e) => {
                log::error!("pty[{pane_id}] write failed: {e}");
                false
            }
        },
        None => false,
    }
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
        // The session is gone. This IS a teardown race sometimes, and the bytes are dropped either
        // way - but it is also what a pane whose shell exited looks like from here, and in that
        // case it is not a race at all: it is every keystroke the user types into a corpse. At
        // `debug` that was invisible while a maintainer sat typing into a dead pane wondering why
        // the terminal had frozen. Warned ONCE per pane, because the alternative is a log line per
        // keypress, which is its own way of hiding the signal.
        None => {
            if first_write_to_missing(&pane_id) {
                log::warn!(
                    "pty[{pane_id}] write to a session that is gone ({} bytes dropped) - the pane is no longer connected; further writes to it are logged at debug",
                    data.len()
                );
            } else {
                log::debug!("pty[{pane_id}] write to missing session ({} bytes dropped)", data.len());
            }
        }
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
        // `effective_cwd` is the nearest EXISTING ancestor of `cwd`, so it equals `cwd` only on a
        // machine where the hub happens to be present. Asserting equality made this test read the
        // DEVELOPER'S HOME: green where that hub existed, red on a fresh host — which is exactly how
        // it failed on the first native Debian gate. The ancestor relation is the real invariant and
        // holds either way, and it still fails if recovery or the fallback genuinely regresses.
        // Guarded against vacuity: `starts_with("")` is true for anything, so an empty
        // `effective_cwd` would make the check below meaningless rather than passing.
        assert!(!r.effective_cwd.is_empty(), "a recovered cwd must resolve to SOME existing dir");
        assert!(
            r.cwd.starts_with(&r.effective_cwd),
            "effective_cwd must be an ancestor of (or equal to) the recovered cwd: cwd={} effective={}",
            r.cwd,
            r.effective_cwd
        );
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

    // ── a session is never born into a one-row terminal ──────────────────────────────────────
    //
    // MEASURED on the live desktop: `console[network-monitor:domain-model-and-adapter-traits]
    // fit-on-open · box=184x25px · grid=23x1`, immediately followed by a refit to 103x21. The pane
    // was measured before its layout settled, so `pty_create` opened a 23-column, ONE-ROW pty and
    // handed it to a full-screen agent. The cost is not cosmetic: that session's dying words came
    // back as `⏵⏵automodeon (shift+tabtocycle)·←foragents●high·` — a TUI footer with the spaces
    // wrapped out of it — so the one piece of evidence a stopped session leaves was unreadable.

    /// A degenerate grid is floored, and a real one is untouched.
    #[test]
    fn a_pane_measured_before_its_layout_settled_does_not_get_a_one_row_pty() {
        assert_eq!(super::clamp_grid("p", 23, 1), super::MIN_GRID, "the observed 23x1");
        assert_eq!(super::clamp_grid("p", 32, 3), super::MIN_GRID, "and the other one from that run");
        // Each axis floors on its own — a wide-but-flat pane keeps its width.
        assert_eq!(super::clamp_grid("p", 217, 6), (217, 24));
        assert_eq!(super::clamp_grid("p", 40, 60), (80, 60));
    }

    /// A settled pane is passed through EXACTLY. The clamp exists for a measurement that has not
    /// happened yet, and a floor that rounded real sizes up would resize every small pane's agent.
    #[test]
    fn a_settled_grid_is_passed_through_unchanged() {
        for g in [(80, 24), (103, 21), (158, 8), (217, 40)] {
            // 158x8 and 217x40 are real studio-pane sizes from the same run: short, and legitimate.
            let (c, r) = g;
            let out = super::clamp_grid("p", c, r);
            assert_eq!(out, (c.max(80), r.max(24)), "{g:?}");
        }
        assert_eq!(super::clamp_grid("p", 103, 21), (103, 24), "only the axis under the floor moves");
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

    /// The refusal a WAKE can ask about before it destroys anything.
    ///
    /// `a-wake-kills-a-pane-it-cannot-relaunch-and-reports-success`: the wake kills the PTY first —
    /// deliberately, or the remount reconnects and drops the baked prompt — and the store's verdict
    /// only answers whether a tab and a grid seat resolved. So a pane this predicate refuses was
    /// killed anyway, and the director was told `woke: true`. MEASURED: four network-monitor
    /// worktrees had no `.claude/settings.json`, complete in every other respect.
    ///
    #[test]
    fn the_real_launch_refusal_stays_strict_on_a_missing_gate_file() {
        let dir = std::env::temp_dir().join(format!("bsc-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();

        // No gate file yet — a fleet pane is REFUSED, and the message names the cause and the cure.
        assert!(!super::gate_file_present(&cwd));
        let msg = super::launch_gate_refusal("network-monitor:omada-controller-adapter", &cwd)
            .expect("a fleet pane with no gate file must be refused");
        assert!(msg.contains(".claude/settings.json"), "names what is missing: {msg}");
        assert!(msg.contains("permission-less"), "names why it matters: {msg}");

        // The same directory, once the gate exists — admitted.
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude").join("settings.json"), "{}").unwrap();
        assert!(super::gate_file_present(&cwd));
        assert_eq!(super::launch_gate_refusal("network-monitor:omada-controller-adapter", &cwd), None);

        // A manual console is never refused — the user is the principal there, so it warns instead.
        let _ = std::fs::remove_dir_all(dir.join(".claude"));
        assert_eq!(super::launch_gate_refusal("man:tab_abc:p2", &cwd), None);

        // An EMPTY cwd is the #1819 shape and must refuse a fleet pane rather than launch it nowhere.
        assert!(super::launch_gate_refusal("network-monitor:api", "").is_some());
        assert!(!super::gate_file_present(""));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Requests #142 (network-monitor, `opnsense-config-adapter`) and #150 (studio-code, `surface` /
    /// `mobile-orphan-clearance`): a worktree whose gate file was never written sat permanently
    /// `stopped`/unmaterializable because every `bsc fleet wake` precheck refused it before the remount
    /// that would have written it ever got to run. `wake_precheck_refusal` is the fix — it ADMITS
    /// exactly this shape, because the imminent remount's own `ensure_session_settings` writes the gate
    /// file before `pty_create` is ever called.
    #[test]
    fn a_wake_precheck_admits_a_real_directory_that_has_never_been_gated() {
        let dir = std::env::temp_dir().join(format!("bsc-wake-precheck-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();

        // THE FIX: a real, existing worktree with no gate file yet is ADMITTED by the precheck — where
        // the real launch-time check (above) still refuses the identical input.
        assert!(!super::gate_file_present(&cwd));
        assert_eq!(
            super::wake_precheck_refusal("network-monitor:opnsense-config-adapter", &cwd),
            None,
            "a real cwd with no gate file yet must be admitted — the remount will write it",
        );
        assert!(
            super::launch_gate_refusal("network-monitor:opnsense-config-adapter", &cwd).is_some(),
            "the real spawn-time check stays strict for the identical input",
        );

        // Once the gate file exists, both agree (admitted) — no divergence in the ordinary case.
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude").join("settings.json"), "{}").unwrap();
        assert_eq!(super::wake_precheck_refusal("network-monitor:opnsense-config-adapter", &cwd), None);
        assert_eq!(super::launch_gate_refusal("network-monitor:opnsense-config-adapter", &cwd), None);

        // An EMPTY cwd is still refused by both — no remount can ever write a gate file into nothing.
        assert!(super::wake_precheck_refusal("network-monitor:api", "").is_some());

        // A cwd that is not a real directory at all is still refused too — recovering to some other
        // ancestor at spawn time is not something the precheck can promise will end up gated either.
        let ghost = dir.join("never-existed").to_string_lossy().to_string();
        assert!(super::wake_precheck_refusal("network-monitor:api", &ghost).is_some());

        // A manual console is never refused by either — the user is the principal there.
        assert_eq!(super::wake_precheck_refusal("man:tab_abc:p2", &cwd), None);

        let _ = std::fs::remove_dir_all(&dir);
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
            false, false, crate::platform::shell::ShellKind::Bash,
            "/p", false, "/p", Some("claude"), true, "CLAUDE_FN;", "/rc", None, &env_map, None,
        );
        assert_eq!(
            bash,
            // The wrapper derives the store exports from the cwd, so the leaf call must be given the
            // SAME derivation — hardcoding "" here would assert the wrapper does something it does not.
            super::build_bash_init_line(
                "/p", false, "/p", Some("claude"), "CLAUDE_FN;", "/rc",
                &super::env::store_exports_for_cwd("/p"), false, None,
            ),
            "Bash kind reproduces build_bash_init_line exactly",
        );
        // Sandbox ⇒ byte-for-byte the distro builder's output (env + cd baked in, shell kind ignored).
        let sandbox = super::build_session_init_line(
            true, false, crate::platform::shell::ShellKind::Bash,
            "/home/agent/p", false, "/home/agent/p", Some("claude"), true, "CLAUDE_FN;", "/rc", None, &env_map, None,
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
/// Drain a sandboxed session's coordination outbox into the real `coord.log`.
///
/// A caged agent cannot append to `coord.log` itself: the log lives on the host and the cage binds
/// no writable path to it — deliberately, since a writable host path is the ambient authority the
/// isolation removes. So it WRITES A FILE into `/coord/out` (the filename is the verb, the contents
/// are the message) and something on this side has to carry that across. Without this the emitters
/// completed and reached nobody, which is a quieter failure than the hang they replaced.
///
/// Polls rather than watches: an inotify watch would need the directory to outlive the session and
/// a watcher per pane, and a one-second poll over a directory that is almost always empty costs
/// nothing measurable next to the session it belongs to.
///
/// Everything is best-effort. A drain that cannot read, append or clean up leaves the entry where
/// it is and tries again — losing an event is worse than repeating a scan, and a coordination
/// channel must never be the thing that ends a session.
#[cfg(target_os = "linux")]
fn spawn_outbox_drain(pane_id: String, outbox: std::path::PathBuf, coord_log: std::path::PathBuf) {
    std::thread::spawn(move || {
        // The actor recorded on every event this session emits. `pane` is what joins an event to
        // its session, exactly as the shell emitters do it.
        let actor = "agent";
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            // The session is gone once its outbox is: `pty_kill` removes the directory, which is
            // also how this thread learns to stop without a channel.
            if !outbox.is_dir() {
                return;
            }
            let Ok(rd) = std::fs::read_dir(&outbox) else { continue };
            // Sorted, so a drain is deterministic — `drain` documents that the caller sorts.
            let mut entries: Vec<(String, String)> = Vec::new();
            let mut consumed: Vec<std::path::PathBuf> = Vec::new();
            let mut names: Vec<_> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
            names.sort();
            for path in names {
                let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
                // `.notes` is local provenance the agent keeps for itself, and `.rejected` is our
                // own feedback — neither is an event to emit.
                if name.starts_with('.') || name.ends_with(".rejected") {
                    continue;
                }
                let Ok(body) = std::fs::read_to_string(&path) else { continue };
                entries.push((name.to_string(), body));
                consumed.push(path);
            }
            if entries.is_empty() {
                continue;
            }

            let ts = bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms());
            let (events, rejected) = bsc_storefs::coord::drain(&entries, &pane_id, &ts, actor);

            if !events.is_empty() {
                use std::io::Write;
                let line: String = events
                    .iter()
                    .map(|e| format!("{}\t{}\t{}\t{}\t{}\n", e.ts, e.pane, e.verb, e.message, e.actor))
                    .collect();
                match std::fs::OpenOptions::new().create(true).append(true).open(&coord_log) {
                    Ok(mut f) => {
                        if let Err(e) = f.write_all(line.as_bytes()) {
                            log::warn!("pty[{pane_id}] coord drain could not append: {e}");
                            continue; // leave the entries; try again next tick
                        }
                        log::info!("pty[{pane_id}] drained {} coordination event(s)", events.len());
                    }
                    Err(e) => {
                        log::warn!("pty[{pane_id}] coord drain could not open the log: {e}");
                        continue;
                    }
                }
            }
            // Feedback the agent can READ: a rejection explains the fix rather than vanishing.
            for (name, fix) in &rejected {
                let _ = std::fs::write(outbox.join(name), fix);
            }
            for p in consumed {
                let _ = std::fs::remove_file(p);
            }
        }
    });
}

/// Drain a caged session's `/plan/out` into the project's plan store, through the bundled `bsc`.
///
/// The mirror of [`spawn_outbox_drain`], and it applies entries by EXECING THE CLI rather than by
/// opening plan.db here. That is the point: `bsc plan change note` already enforces append-only
/// notes, `bsc plan status` already validates the status, and the projection on the read side
/// (`project_stores_for`) already goes through the same binary. A second implementation of those
/// semantics inside the launcher is exactly the "written twice and drifted" failure this repo keeps
/// paying for — and it is what `dangerous.rs` in `bsc-hook` exists as a monument to.
///
/// The store stays unwritable from INSIDE the cage either way: `/plan` is a read-only mount, the
/// binary is not bound, and this runs host-side on entries the agent could only append.
///
/// Every call is an ARGV, never a shell string, so a note containing a backtick or a `$(…)` is
/// passed as data. `bsc_storefs::plan::accept_write` has already refused anything outside the
/// vocabulary — notably `status verified`, which is the reviewer's verdict and not the author's.
#[cfg(target_os = "linux")]
fn spawn_plan_drain(pane_id: String, outbox: std::path::PathBuf, cwd: String) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            // The session is gone once its outbox is — the same stop signal the coord drain uses.
            if !outbox.is_dir() {
                return;
            }
            // Resolved every tick rather than once: a session can outlive a `bsc` restage, and a
            // hub can gain its plan.db after launch (a fresh project is scaffolded, then planned).
            let (Some(bsc), Some(db)) = (env::bsc_bin_path(), env::plan_db_for_cwd(&cwd)) else {
                continue;
            };
            if !db.is_file() {
                continue;
            }

            // One directory per entry, one file per field — the `/ui/out` shape, because a change
            // note is prose and must not be escaped into a filename or a JSON blob.
            let Ok(rd) = std::fs::read_dir(&outbox) else { continue };
            let mut dirs: Vec<std::path::PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
            dirs.sort(); // deterministic, so a drain applies in a stable order
            let mut entries: Vec<(String, Vec<(String, String)>)> = Vec::new();
            let mut consumed: Vec<std::path::PathBuf> = Vec::new();
            for dir in dirs {
                let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { continue };
                // `.rejected` is our own feedback, written back as a FILE beside the entry.
                if name.starts_with('.') || name.ends_with(".rejected") || !dir.is_dir() {
                    continue;
                }
                let Ok(fields_rd) = std::fs::read_dir(&dir) else { continue };
                let mut fields: Vec<(String, String)> = Vec::new();
                for f in fields_rd.filter_map(Result::ok) {
                    let Some(k) = f.file_name().to_str().map(str::to_string) else { continue };
                    if let Ok(v) = std::fs::read_to_string(f.path()) {
                        fields.push((k, v));
                    }
                }
                entries.push((name.to_string(), fields));
                consumed.push(dir);
            }
            if entries.is_empty() {
                continue;
            }

            let (writes, rejected) = bsc_storefs::plan::drain_writes(&entries);
            for (entry, w) in &writes {
                let argv = w.argv();
                match std::process::Command::new(&bsc).args(&argv).env("BSC_PLAN_DB", &db).output() {
                    Ok(o) if o.status.success() => {
                        log::info!("pty[{pane_id}] plan drain: bsc {}", argv.join(" "));
                    }
                    // A REFUSAL BY THE CLI IS FEEDBACK, not a silent drop. The pure layer accepts
                    // the shape; only the store knows whether the ref exists or the transition is
                    // legal, and the agent has to be able to read that answer.
                    Ok(o) => {
                        let why = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        log::warn!("pty[{pane_id}] plan drain refused ({}): {why}", o.status);
                        let _ = std::fs::write(
                            outbox.join(format!("{entry}.rejected")),
                            format!("rejected by the plan store: {why}\n\nthe command was:\n  bsc {}\n", argv.join(" ")),
                        );
                    }
                    Err(e) => {
                        log::warn!("pty[{pane_id}] plan drain could not exec bsc: {e}");
                        // Leave the entries in place and retry on the next tick — an unrunnable
                        // binary is transient (a restage), and dropping the record is not.
                        continue;
                    }
                }
            }
            // Feedback the agent can READ: a rejection explains the fix rather than vanishing.
            for (name, fix) in &rejected {
                let _ = std::fs::write(outbox.join(name), fix);
            }
            for d in consumed {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    });
}

/// Drain a caged session's `/ui/out` into the component store, through the bundled `bsc`.
///
/// The third of the three, and the one that was MISSING RATHER THAN WRONG: the bind existed, the
/// pure `bsc_storefs::ui::drain_writes` existed and was tested, and the only thing that ever called
/// it was `crates/bsc-storefs/examples/ui-drain.rs`. So a designer authoring a component into
/// `/ui/out` wrote into a directory nothing read — the writes did not fail, they just never
/// happened, which is worse than an error.
///
/// The JSON goes in on STDIN, never as an argument. `srcText` is TSX; a backtick or a `${…}` in it
/// is content, and that is the same reason it travels as its own FILE in the outbox. The example
/// already made this call correctly and is where the shape comes from.
#[cfg(target_os = "linux")]
fn spawn_ui_drain(pane_id: String, outbox: std::path::PathBuf) {
    std::thread::spawn(move || {
        use std::io::Write;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            if !outbox.is_dir() {
                return; // the session is gone — same stop signal the other two drains use
            }
            let Some(bsc) = env::bsc_bin_path() else { continue };

            let Ok(rd) = std::fs::read_dir(&outbox) else { continue };
            let mut dirs: Vec<std::path::PathBuf> = rd.filter_map(Result::ok).map(|e| e.path()).collect();
            dirs.sort();
            let mut entries: Vec<(String, Vec<(String, String)>)> = Vec::new();
            let mut consumed: Vec<std::path::PathBuf> = Vec::new();
            for dir in dirs {
                let Some(name) = dir.file_name().and_then(|n| n.to_str()) else { continue };
                if name.starts_with('.') || name.ends_with(".rejected") || !dir.is_dir() {
                    continue;
                }
                let Ok(fields_rd) = std::fs::read_dir(&dir) else { continue };
                let mut fields: Vec<(String, String)> = Vec::new();
                for f in fields_rd.filter_map(Result::ok) {
                    let Some(k) = f.file_name().to_str().map(str::to_string) else { continue };
                    // Source is read VERBATIM: no trim, no normalization. Its leading and trailing
                    // whitespace is the author's.
                    if let Ok(v) = std::fs::read_to_string(f.path()) {
                        fields.push((k, v));
                    }
                }
                fields.sort();
                entries.push((name.to_string(), fields));
                consumed.push(dir);
            }
            if entries.is_empty() {
                continue;
            }

            let (writes, rejected) = bsc_storefs::ui::drain_writes(&entries);
            for w in &writes {
                let child = std::process::Command::new(&bsc)
                    .args(["ui", "set"])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn();
                let out = child.and_then(|mut c| {
                    if let Some(si) = c.stdin.as_mut() {
                        si.write_all(w.to_json().as_bytes())?;
                    }
                    c.wait_with_output()
                });
                match out {
                    Ok(o) if o.status.success() => {
                        log::info!("pty[{pane_id}] ui drain: set {}", w.id);
                    }
                    // A store-side refusal is FEEDBACK. The pure layer accepts the shape; only the
                    // store knows whether the kit exists or the id collides.
                    Ok(o) => {
                        let why = String::from_utf8_lossy(&o.stderr).trim().to_string();
                        log::warn!("pty[{pane_id}] ui drain refused ({}): {why}", o.status);
                        let _ = std::fs::write(
                            outbox.join(format!("{}.rejected", w.id)),
                            format!("rejected by the component store: {why}\n"),
                        );
                    }
                    Err(e) => {
                        log::warn!("pty[{pane_id}] ui drain could not exec bsc: {e}");
                        continue; // leave the entries; a restage is transient, losing work is not
                    }
                }
            }
            for (name, fix) in &rejected {
                let _ = std::fs::write(outbox.join(name), fix);
            }
            for d in consumed {
                let _ = std::fs::remove_dir_all(d);
            }
        }
    });
}

/// Why this session cannot be sandboxed, if it cannot — the ONE implementation, shared by the/// Why this session cannot be sandboxed, if it cannot — the ONE implementation, shared by the
/// refusal in [`namespace_argv`] and the notice the pane prints.
///
/// Two callers for the same question is how they drift, and the drift here would be the worst kind:
/// a pane that says it is caged when it is not, or one that warns when it is fine. So the check lives
/// here and both sides ask it.
///
/// `None` means "no objection" — which is NOT the same as "will be sandboxed": a pane with no role
/// was never going to be, and printing a notice there would be noise.
#[cfg(target_os = "linux")]
pub(super) fn sandbox_refusal(cwd: &str) -> Option<String> {
    // A REFUSAL, not a smaller cage: a session whose cwd fell back to the home directory would bind
    // the user's whole home read-write at /repo. That is not isolation with a wide root, it is the
    // opposite of the thing.
    if std::path::Path::new(cwd) == crate::platform::paths::home_dir() {
        return Some(format!(
            "this pane's directory is your HOME ({cwd}). Point it at a worktree or project hub              and relaunch."
        ));
    }
    None
}

/// Where the shared `/graph` projection lives — ONE copy, reached by every sandboxed session.
///
/// `/plan` is per-project, `/coord` and `/ui` are per-session (both carry a writable outbox), so all
/// three belong under the pane's own store root. `/graph` is none of those: it is a global store,
/// byte-identical for every session, read-only, and by far the largest.
///
/// Measured before choosing this: `bsc graph impl list` is **12.4 MB and 755 ms** — every node
/// carries its full `code`, because there the code IS the node — against 0.08 MB for `bsc ui list`.
/// Projected per pane, a ten-session fleet would write ten identical trees: ~124 MB and ~7.5 s. So
/// the graph is built once here and each pane gets a SYMLINK to it.
///
/// The symlink matters beyond disk: `namespace_argv` keeps resolving every store under the pane's own
/// root, so it stays a pure function of its arguments and its tests stay hermetic. Reaching into a
/// machine-global directory from inside it would have made "is `/graph` mounted?" depend on whether
/// this machine happened to have a projection lying around.
#[cfg(target_os = "linux")]
fn shared_graph_dir() -> std::path::PathBuf {
    crate::platform::paths::bsc_base_dir().join("sandbox-stores").join("_shared").join("graph")
}

/// Refresh the shared `/graph` projection when the algorithms store has moved on, and point this
/// pane's store root at it.
///
/// ## Why a staleness check rather than once per boot
/// The store is authored DURING a run, so a projection built once at startup would leave a caged
/// session reading a boot-time snapshot. The check is exact and nearly free: the projection records
/// the mtime of the file that produced it, so an unchanged store costs one `stat` rather than 12.4 MB
/// of work.
///
/// Best-effort throughout — a projection that cannot be built leaves the session without `/graph`
/// rather than without a session.
#[cfg(target_os = "linux")]
fn link_shared_graph(pane_id: &str, root: &std::path::Path) {
    use std::sync::Mutex;
    // One refresh at a time within this process: a fleet launch starts many panes at once, and
    // without this they would all rebuild the same 12.4 MB tree over each other.
    static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock();

    let Some(bsc) = env::bsc_bin_path() else { return };
    let dir = shared_graph_dir();
    let stamp = dir.join(".source-mtime");
    let backing = std::env::var_os("BSC_GRAPH_STORE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            crate::platform::paths::bsc_base_dir().join("knowledge").join("algorithms.json")
        });

    // `0` when there is no WRITABLE store, rather than an early return: `bsc graph impl list` falls
    // back to the packaged seed, so a machine that has never authored an algorithm still has a graph
    // worth projecting. Returning here would have skipped it silently — and on the Linux box it also
    // hid a real failure, where the bundled `bsc` cannot find its packaged seeds at all and panics.
    // Attempting and reporting beats declining and saying nothing.
    let source_mtime = backing
        .metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let current = std::fs::read_to_string(&stamp).ok().and_then(|s| s.trim().parse::<u64>().ok());
    if current != Some(source_mtime) || !dir.is_dir() {
        match std::process::Command::new(&bsc).args(["graph", "impl", "list"]).output() {
            Ok(o) if o.status.success() => {
                let json = String::from_utf8_lossy(&o.stdout);
                match bsc_storefs::graph::from_json(&json) {
                    Ok(impls) => {
                        let at = bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms());
                        let tree = bsc_storefs::graph::project(&impls, &at);
                        let _ = std::fs::remove_dir_all(&dir);
                        match bsc_storefs::materialize(&dir, &tree) {
                            Ok(()) => {
                                let _ = std::fs::write(&stamp, source_mtime.to_string());
                                log::info!(
                                    "pty[{pane_id}] refreshed the shared /graph projection ({} impls)",
                                    impls.len()
                                );
                            }
                            Err(e) => {
                                log::warn!("pty[{pane_id}] /graph projection could not be written: {e}");
                                return;
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("pty[{pane_id}] /graph projection skipped: {e}");
                        return;
                    }
                }
            }
            Ok(o) => {
                log::warn!(
                    "pty[{pane_id}] /graph projection skipped: bsc exited {}: {}",
                    o.status,
                    String::from_utf8_lossy(&o.stderr).trim()
                );
                return;
            }
            Err(e) => {
                log::warn!("pty[{pane_id}] /graph projection skipped: {e}");
                return;
            }
        }
    }

    // Point this pane at it. `Path::is_dir` follows symlinks, so the ordinary discovery in
    // `namespace_argv` picks it up with no special case, and bwrap binds the resolved target.
    let link = root.join("graph");
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_dir_all(&link);
    if let Err(e) = std::os::unix::fs::symlink(&dir, &link) {
        log::warn!("pty[{pane_id}] could not link the shared /graph: {e}");
    }
}

/// Project the component store at `/ui`, so a caged session can read what the app's UI is made of.
///
/// Per pane rather than shared, unlike [`link_shared_graph`], and the reason is size: `bsc ui list` is
/// **0.08 MB** against the graph's 12.4 MB, so the duplication a shared copy would save is not worth
/// the indirection. (It is also the store that will eventually carry a per-session writable outbox,
/// which a shared read-only tree could not hold.)
///
/// **Read-only in this slice, deliberately.** `bsc-storefs`'s `/ui` design includes a writable
/// `/ui/out` that a host-side drain turns into `bsc ui set` calls. That drain is its own item, and
/// shipping the outbox before it exists would recreate exactly the failure the coordination emitters
/// had: a session writes, and what it writes reaches nobody. So the mountpoint is not created yet.
///
/// Its own function rather than part of `project_stores_for` because that one returns early when
/// there is no plan store, and a plain console outside a project hub should still get `/ui`.
///
/// Best-effort: a session that cannot get the projection still launches.
#[cfg(target_os = "linux")]
fn project_ui_for(pane_id: &str, root: &std::path::Path) {
    let Some(bsc) = env::bsc_bin_path() else { return };

    // `--full`, so the projection carries SOURCE. The recorded reason not to — "pulling it would
    // mean one `bsc ui get` per record" — is obsolete: `--full` is ONE call, measured at 5.7 MB in
    // 47 ms against 0.08 MB for the summary. And the value it was waiting on is established, by the
    // designer having to be let OUT of its cage: without source a caged designer can see that a
    // component exists and cannot read the thing it was asked to edit.
    let json = match std::process::Command::new(&bsc).args(["ui", "list", "--full"]).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            log::warn!(
                "pty[{pane_id}] /ui projection skipped: bsc exited {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            );
            return;
        }
        Err(e) => {
            log::warn!("pty[{pane_id}] /ui projection skipped: {e}");
            return;
        }
    };

    let components = match bsc_storefs::ui::from_json(&json) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("pty[{pane_id}] /ui projection skipped: {e}");
            return;
        }
    };
    let at = bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms());
    let tree = bsc_storefs::ui::project(&components, &at);
    let dir = root.join("ui");
    match bsc_storefs::materialize(&dir, &tree) {
        Ok(()) => log::info!(
            "pty[{pane_id}] projected {} component(s) to {}",
            components.len(),
            dir.display()
        ),
        Err(e) => log::warn!("pty[{pane_id}] /ui projection could not be written: {e}"),
    }
}

/// Project this session's stores into `root`, so a sandboxed agent can READ them without `bsc`.
///
/// A caged session cannot run `bsc`: the binary is not bound, and binding it would mean binding a
/// writable SQLite database into the namespace — the ambient authority the isolation exists to
/// remove. `bsc-storefs` is the answer that was built for this and never called: the store becomes
/// a read-only file tree the agent reaches with `cat` and `ls`.
///
/// Measured when this was missing: the launch logged `0 store(s)`, and a worker whose kickoff told
/// it to consult its plan had no way to.
///
/// The projection is a SNAPSHOT, taken at launch. That is already the semantics a worker runs
/// under — its context is assembled once at launch while the stores stay live — and the README the
/// projection writes says so where a reader meets it.
///
/// Best-effort throughout: a session that cannot get a projection still launches with whatever it
/// did get. Returning early would trade a degraded agent for no agent.
#[cfg(target_os = "linux")]
fn project_stores_for(pane_id: &str, cwd: &str, root: &std::path::Path) {
    let Some(bsc) = env::bsc_bin_path() else {
        log::warn!("pty[{pane_id}] no bundled bsc — the session gets no store projections");
        return;
    };
    let Some(db) = env::plan_db_for_cwd(cwd) else {
        // A plain console outside a project hub has no plan to read. Absent, not empty.
        return;
    };
    if !db.is_file() {
        return;
    }

    // `--full`, deliberately: plain `--json` is the LEAN summary shape, where `acceptance` is a
    // COUNT rather than an array and `body` is absent — it does not deserialize and fails at parse
    // time. The projection's own module docs say so, having been caught by it.
    let out = std::process::Command::new(&bsc)
        .args(["plan", "list", "--full", "--json"])
        .env("BSC_PLAN_DB", &db)
        .output();
    let json = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
        Ok(o) => {
            log::warn!(
                "pty[{pane_id}] plan projection skipped: bsc exited {}: {}",
                o.status,
                String::from_utf8_lossy(&o.stderr).trim()
            );
            return;
        }
        Err(e) => {
            log::warn!("pty[{pane_id}] plan projection skipped: {e}");
            return;
        }
    };

    let items = match bsc_storefs::plan::from_json(&json) {
        Ok(i) => i,
        Err(e) => {
            log::warn!("pty[{pane_id}] plan projection skipped: {e}");
            return;
        }
    };
    let stamp = bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms());
    let tree = bsc_storefs::plan::project(&items, &stamp);
    let dir = root.join("plan");
    match bsc_storefs::materialize(&dir, &tree) {
        Ok(()) => log::info!(
            "pty[{pane_id}] projected {} plan item(s) to {}",
            items.len(),
            dir.display()
        ),
        Err(e) => log::warn!("pty[{pane_id}] plan projection could not be written: {e}"),
    }
}

/// The single credential a sandboxed harness needs, if it is there.
///
/// Exactly one file — never the whole `~/.claude`, which holds every project's transcripts and the
/// machine's global settings. The agent can READ its own token, which is unavoidable since the
/// harness needs it to reach the model; what the cage adds is that it cannot MODIFY it, and that a
/// `network: false` role cannot send it anywhere.
#[cfg(target_os = "linux")]
fn credential_for_harness() -> Option<std::path::PathBuf> {
    let p = crate::platform::paths::home_dir().join(".claude").join(".credentials.json");
    p.is_file().then_some(p)
}

/// The pane's PERSISTENT transcript directory, created on the host so bwrap can bind it.
///
/// Claude Code stores conversations under `$HOME/.claude/projects/<cwd-slug>/`. The cage's HOME is a
/// tmpfs, so those died with every session and `--continue` never had anything to continue — the
/// caged designer started fresh on every launch while the uncaged studios resumed normally.
///
/// Per PANE, not per role: the pane id is what distinguishes `designer-react` from
/// `designer-react-native`, and inside the cage both see the same cwd (`/repo`), so sharing one host
/// directory would make them share a conversation. That is the same collision the per-technology
/// workspace directories fix on the host side, and it has to hold on both.
///
/// Best-effort: a session that cannot get one still launches and simply cannot resume, which is
/// strictly better than refusing to start.
/// The SHARED git directory a worktree at `cwd` depends on, or `None` when it needs no extra bind.
///
/// An ordinary clone keeps `.git` as a DIRECTORY inside the tree, so binding the tree carries it and
/// there is nothing to add. A WORKTREE keeps a `.git` FILE holding `gitdir: <absolute host path>`, and
/// the objects/refs live back in the parent clone — so the namespace has the pointer and not the
/// target, and every git command fails with `fatal: not a git repository: <that path>`.
///
/// Resolved the way git itself does: follow the `gitdir:` pointer, then read its `commondir` (normally
/// `../..`) rather than assuming a depth. A linked worktree of a linked worktree is a shape the
/// two-levels-up guess gets wrong and `commondir` gets right.
///
/// Returns the path only when it EXISTS: binding a source bwrap cannot find fails the whole launch,
/// and a repo whose parent clone has been removed should degrade to today's behaviour (git broken in
/// the cage) rather than to no session at all.
#[cfg(target_os = "linux")]
fn git_common_dir_for(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let dot_git = std::path::Path::new(cwd).join(".git");
    // A real directory ⇒ an ordinary clone; it rides along inside the tree bind.
    if dot_git.is_dir() {
        return None;
    }
    let text = std::fs::read_to_string(&dot_git).ok()?;
    let pointer = text.lines().find_map(|l| l.strip_prefix("gitdir:"))?.trim();
    let gitdir = std::path::Path::new(pointer);
    let common = match std::fs::read_to_string(gitdir.join("commondir")) {
        // `commondir` is relative TO the gitdir, and may be absolute in exotic setups.
        Ok(rel) => {
            let rel = rel.trim();
            let p = std::path::Path::new(rel);
            if p.is_absolute() { p.to_path_buf() } else { gitdir.join(p) }
        }
        // No `commondir` — an older layout. `<clone>/.git/worktrees/<name>` ⇒ two up.
        Err(_) => gitdir.parent()?.parent()?.to_path_buf(),
    };
    let common = std::fs::canonicalize(&common).unwrap_or(common);
    common.is_dir().then_some(common)
}

/// Where a CAGED session's transcripts actually live, or `None` when this launch is not caged.
///
/// The harness inside the namespace writes to `<home>/.claude/projects/<slug(guest cwd)>`, and the
/// guest cwd is always [`bsc_sandbox::REPO_GUEST_PATH`] — so the directory name is fixed, not derived
/// from the host path. `history_dir_for` binds `<stores_root>/home/projects` over that `projects` dir,
/// which makes the transcripts durable; this resolves the ONE subdirectory inside it that a resume
/// would continue from.
///
/// Gated on `caged` (an actual namespace argv) rather than on `stores_root` alone: the stores root is
/// prepared for a pane before we know the launch will be sandboxed, and answering "yes, look in the
/// cage" for a session that then runs on the host would break resume in the opposite direction.
#[cfg(target_os = "linux")]
fn caged_history_dir(stores_root: Option<&str>, caged: bool) -> Option<std::path::PathBuf> {
    if !caged {
        return None;
    }
    let root = stores_root.filter(|r| !r.is_empty())?;
    let slug = crate::session::launch::claude_project_dir_name(bsc_sandbox::REPO_GUEST_PATH);
    Some(std::path::Path::new(root).join("home").join("projects").join(slug))
}

#[cfg(target_os = "linux")]
fn history_dir_for(pane_id: &str, stores_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = stores_root.join("home").join("projects");
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Some(dir),
        Err(e) => {
            log::warn!("pty[{pane_id}] no transcript dir ({e}); this session will not resume");
            None
        }
    }
}

/// A PER-SESSION, WRITABLE copy of the harness's own state file, if there is one to copy.
///
/// ## Why the credential alone was not enough
/// Claude Code keeps its ONBOARDING and account state in `~/.claude.json`, separately from the
/// credential. A private HOME holding `.claude/.credentials.json` but no `.claude.json` reads to it
/// as a FIRST RUN: it starts the OAuth flow and asks for a pasted code — with the credential it
/// needed sitting right beside it. Observed as a caged session demanding a login the user had
/// already done, and it is why pasting mattered so much in that session.
///
/// ## Why a copy rather than a bind
/// The harness REWRITES this file as it runs, so a read-only bind would fail every write, and a
/// writable bind of the host's own config would hand the cage the ambient authority the isolation
/// exists to remove — the agent could edit the machine's harness config. A copy gives it real,
/// working state whose mutations die with the session, which is the same trade the plan projection
/// and the coordination outbox already make.
///
/// Best-effort: a session that cannot get a copy still launches. It will re-run onboarding, which is
/// worse than the alternative but better than not starting.
#[cfg(target_os = "linux")]
fn harness_state_for(pane_id: &str, stores_root: &std::path::Path) -> Option<std::path::PathBuf> {
    let src = crate::platform::paths::home_dir().join(".claude.json");
    if !src.is_file() {
        return None;
    }
    let dir = stores_root.join("home");
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("pty[{pane_id}] no harness state: cannot create {}: {e}", dir.display());
        return None;
    }
    let dst = dir.join(".claude.json");
    match std::fs::copy(&src, &dst) {
        Ok(n) => {
            log::info!("pty[{pane_id}] harness state copied ({n} bytes) — the cage will not re-run onboarding");
            trust_guest_repo(pane_id, &dst);
            Some(dst)
        }
        Err(e) => {
            log::warn!("pty[{pane_id}] no harness state: {e} — the session will re-run onboarding");
            None
        }
    }
}

/// Mark the cage's own workspace as already-trusted in the session's PRIVATE state copy.
///
/// Claude Code records trust PER ABSOLUTE PATH (`projects.<path>.hasTrustDialogAccepted`). Inside the
/// namespace the tree is bound at [`bsc_sandbox::REPO_GUEST_PATH`], a path that exists nowhere on the
/// host — so no amount of trusting the real directory can match it, and every caged session opened on
/// the interactive trust dialog instead of a prompt:
///
/// ```text
///   Accessing workspace: /repo
///   Quick safety check: Is this a project you created or one you trust?
///   ❯ 1. Yes, I trust this folder
///     2. No, exit
/// ```
///
/// The second option EXITS, and the dialog takes the keystrokes the user believed they were typing at
/// an agent — so the observed symptom was "the session ends after the first command", with the cause
/// two screens up and already scrolled away. Copying `~/.claude.json` (which this function completes)
/// silenced the LOGIN prompt and made this one the next thing standing in the way.
///
/// Accepting it on the user's behalf is defensible ONLY because of what the path is: `/repo` is bound
/// by this app, to the directory the user chose in the pane, for a session they gave a role to. The
/// dialog's question — "do you trust this folder" — was answered when they pointed the pane at it.
/// And the answer is not load-bearing here: the mount namespace, not the harness's prompt, is what
/// confines the session. This grants nothing the cage does not already allow.
///
/// Deliberately writes ONLY the per-session copy, never `~/.claude.json`: the host's own trust record
/// is the user's, and a sandbox launch must not edit it.
///
/// Fail-safe throughout — an unparseable or unwritable state file leaves the plain copy in place, which
/// is exactly the behaviour before this existed.
fn trust_guest_repo(pane_id: &str, state: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(state) else {
        log::warn!("pty[{pane_id}] harness state unreadable — the trust dialog will appear");
        return;
    };
    let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) else {
        log::warn!("pty[{pane_id}] harness state is not JSON — the trust dialog will appear");
        return;
    };
    // The trust key's shape is `claude_config`'s to know — it already creates the `projects` map and
    // the per-directory entry, and coerces a non-object at either level rather than silently skipping.
    // Duplicating that here would be a second definition of the same fact.
    crate::session::claude_config::mark_dir_trusted(&mut v, bsc_sandbox::REPO_GUEST_PATH);
    // ...plus the ONBOARDING flag, which trust alone does not cover: a project the harness has never
    // seen still runs its per-project intro, which is another screen in front of the agent.
    if let Some(entry) = v
        .get_mut("projects")
        .and_then(|p| p.get_mut(bsc_sandbox::REPO_GUEST_PATH))
        .and_then(|e| e.as_object_mut())
    {
        entry.insert("hasCompletedProjectOnboarding".into(), serde_json::Value::Bool(true));
    }
    match serde_json::to_string(&v).map(|out| std::fs::write(state, out)) {
        Ok(Ok(())) => log::info!(
            "pty[{pane_id}] {} pre-trusted in the session's state copy — no trust dialog",
            bsc_sandbox::REPO_GUEST_PATH
        ),
        _ => log::warn!("pty[{pane_id}] could not pre-trust {} — the trust dialog will appear", bsc_sandbox::REPO_GUEST_PATH),
    }
}

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
/// The cgroup ceilings one caged session runs under (#795).
///
/// Every namespace launch passed `Limits::default()` — every field `None`, so `render_limits`
/// emitted nothing and the `systemd-run` scope enforced NOTHING. The machinery was built, tested in
/// `bsc-sandbox`, and never reached from the launcher, while `scope_mode` below warns loudly about
/// the *other* way to end up uncapped. `Limits`' own doc names the goal: the repo has an OOM
/// history, serializes full gates behind a cross-worktree lock and pins `jobs = 4` globally, all of
/// it "userspace negotiation for something cgroups enforce directly".
///
/// **Sized from the HOST, not from a constant.** A number that is right on a 32 GB workstation
/// OOM-kills a build on an 8 GB one and is meaningless on a 128 GB one. The cap exists to stop ONE
/// runaway session taking the machine down — not to right-size a workload — so it is a generous
/// fraction of what the host actually has:
///
/// * `worker` — the only role that writes code, so the only one whose work can legitimately be
///   large. Half of host RAM. Measured on the dev box (32 GB): a FULL gate peaks at 8.04 GB with
///   `jobs = 4`, so a ~15.8 GB ceiling clears the heaviest real workload twice over and still
///   means one session cannot exhaust the box.
/// * everything else — `code: none` roles that read, review, and drive git/gh. A THIRD, not a
///   quarter: a quarter of this box is 7.9 GB, which lands just UNDER that same 8.04 GB gate peak.
///   No caged role can run a Rust build today (`extra_bins` is `node`/`claude`, and `bins_for`
///   adds only git/gh, so there is no `cargo` in any cage), but sizing a ceiling to sit a rounding
///   error below the heaviest workload the repo measures is how a cap becomes a flaky build the
///   first time somebody widens `extra_bins` for a `tester`.
///
/// **An unreadable host size yields NO memory cap, not a guessed one.** `MemoryMax` renders
/// `MemorySwapMax=0` beside it (a cap that can swap is not a cap), so a cap that is too small does
/// not slow a build down, it kills it. Falling back to today's unbounded behaviour is recoverable;
/// falling back to a number picked blind is a regression that looks like a flaky build.
///
/// `BSC_SANDBOX_MEMORY_MAX` / `BSC_SANDBOX_TASKS_MAX` / `BSC_SANDBOX_CPU_WEIGHT` override, the way
/// `BSC_GATE_SLOTS` does for the gate lock — a machine that disagrees should not need a rebuild.
/// `BSC_SANDBOX_MEMORY_MAX=0` disables the memory cap explicitly.
#[cfg(target_os = "linux")]
fn session_limits(role: bsc_sandbox::profile::Role) -> bsc_sandbox::Limits {
    use bsc_sandbox::profile::Role;

    let env_u32 = |k: &str| std::env::var(k).ok().and_then(|v| v.trim().parse::<u32>().ok());

    let memory_max = match std::env::var("BSC_SANDBOX_MEMORY_MAX") {
        // An explicit "0" means "no memory cap" — a way to opt out without editing code.
        Ok(v) if v.trim() == "0" => None,
        Ok(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => host_memory_kb()
            .map(|total_kb| {
                let share = if role == Role::Worker { 2 } else { 3 };
                // Round to whole MB: systemd accepts a bare integer as bytes, and "16384M" is
                // easier to recognise in `systemctl show` than a raw byte count.
                format!("{}M", (total_kb / 1024) / share)
            })
            .or_else(|| {
                log::warn!(
                    "sandbox: host memory size unreadable — caged sessions run with NO memory cap. \
                     Set BSC_SANDBOX_MEMORY_MAX (e.g. 8G) to bound them."
                );
                None
            }),
    };

    bsc_sandbox::Limits {
        memory_max,
        // A fork-bomb ceiling, not a tuning knob. High enough that a real toolchain never meets it
        // (`jobs = 4` plus node plus the harness is low hundreds of tasks at most) and low enough
        // that a runaway cannot exhaust the host's pid space.
        tasks_max: Some(env_u32("BSC_SANDBOX_TASKS_MAX").unwrap_or(4096)),
        // Half the default weight, so agents yield to the app under contention. A WEIGHT, not a
        // quota: an idle host still gives a session every core, so this can never make a build
        // fail — only wait.
        cpu_weight: Some(env_u32("BSC_SANDBOX_CPU_WEIGHT").unwrap_or(50)),
    }
}

/// Total host RAM in kB, from `/proc/meminfo`'s `MemTotal`. `None` when it cannot be read or parsed
/// — the caller then declines to guess a cap rather than inventing one.
#[cfg(target_os = "linux")]
fn host_memory_kb() -> Option<u64> {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok()?;
    meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|v| v.split_whitespace().next())
        .and_then(|n| n.parse::<u64>().ok())
        .filter(|kb| *kb > 0)
}

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

/// The caged PreToolUse gate's configuration — the two values `bsc-hook` reads that are NOT
/// compiled into it. Passed as one struct because they are one decision: a session's write
/// boundary and its command denies come from the same role+profile resolution, and splitting them
/// across the signature is how one gets wired and the other forgotten (which is the state this
/// type was introduced to fix).
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Default)]
struct GateConfig<'a> {
    /// `$BSC_SCOPE_GLOBS` — whitespace-separated REPO-RELATIVE globs, or the `__bsc_deny_all__`
    /// sentinel. Empty ⇒ no write-scope restriction (`scope_verdict` reads empty as Allow), which
    /// is correct only for an UNGATED pane.
    scope_globs: &'a str,
    /// `$BSC_DENY_BASH` — newline-separated role/user/profile deny patterns. The dangerous floor
    /// itself is compiled into the hook and needs no configuration.
    deny_bash: &'a str,
}

/// Keep only the write-scope globs the CAGED gate can actually match, and say what was dropped.
///
/// The gate normalizes a tool's `file_path` against `BSC_REPO_ROOT=/repo` and then matches the
/// globs against the remainder, so every glob has to be REPO-RELATIVE. That is what the frontend
/// produces today (`src/auth/**`, the planner's plan globs, the director's commons carve-out), and
/// this exists so a future absolute path cannot silently become an enforcement change.
///
/// A host-shaped glob is DROPPED, not rewritten. Rewriting would mean guessing which host prefix
/// corresponds to `/repo`, and guessing wrong widens the scope. Dropping narrows it: the remaining
/// globs still bound the session, and an empty result falls back to the sentinel below rather than
/// to allow-all. Passing it through unchanged would fail closed but wedge the agent on its own
/// worktree, with the gate blocking exactly the writes it was configured to permit.
///
/// The `__bsc_deny_all__` sentinel is path-independent and passes through untouched.
#[cfg(target_os = "linux")]
fn guest_relative_globs(pane_id: &str, scope_globs: &str) -> String {
    if scope_globs.trim().is_empty() || scope_globs.trim() == bsc_util::scope::DENY_ALL {
        return scope_globs.to_string();
    }
    let (keep, drop): (Vec<&str>, Vec<&str>) = scope_globs
        .split_whitespace()
        .partition(|g| !is_host_shaped_glob(g));
    if !drop.is_empty() {
        log::warn!(
            "pty[{pane_id}] dropping {} host-shaped write-scope glob(s) the caged gate cannot match \
             ({}); it matches against {}-relative paths",
            drop.len(),
            drop.join(" "),
            bsc_sandbox::REPO_GUEST_PATH,
        );
    }
    // Every glob dropped is NOT allow-all: fall back to denying writes outright, because a session
    // whose entire scope was unusable is the one case where guessing wide is worst.
    if keep.is_empty() {
        return bsc_util::scope::DENY_ALL.to_string();
    }
    keep.join(" ")
}

/// A glob that names a HOST location rather than a path inside the repo: a POSIX absolute path, or
/// a Windows drive/UNC path (the app is developed on Windows, so those reach here as strings even
/// though the cage is Linux-only).
#[cfg(target_os = "linux")]
fn is_host_shaped_glob(g: &str) -> bool {
    g.starts_with('/')
        || g.starts_with("\\\\")
        || g.chars().nth(1) == Some(':') && g.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

/// The directories a Rust-project scan does not need to see into — build output and dependency
/// trees are exactly where a `*.rs`/`Cargo.toml` match would be noise, not signal, and `target/` on
/// a warm worktree can hold tens of thousands of files a launch must not stat.
#[cfg(target_os = "linux")]
const RUST_SCAN_SKIP: &[&str] = &["target", "node_modules", ".git", ".claude"];

/// A bounded directory walk under `root`: depth-capped and file-count-capped, so a huge or deeply
/// nested tree cannot make a launch hang on a stat. Best-effort — a directory this cannot read
/// (permissions, a dangling symlink) is simply skipped rather than failing the scan.
#[cfg(target_os = "linux")]
fn shallow_listing(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    const MAX_DEPTH: usize = 4;
    const MAX_FILES: usize = 4000;

    let mut out = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, usize)> = vec![(root.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            if out.len() >= MAX_FILES {
                break;
            }
            let path = entry.path();
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let skip = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| RUST_SCAN_SKIP.contains(&n));
                if depth < MAX_DEPTH && !skip {
                    stack.push((path, depth + 1));
                }
            } else {
                out.push(path);
            }
        }
    }
    out
}

/// A directory looks like a RUST project when a shallow scan turns up a `Cargo.toml` or any `*.rs`
/// file. Deliberately NOT gated on a manifest existing at the root — request #143 was filed from a
/// worktree shaped `crates/<name>/Cargo.toml` with no manifest at `cwd`, and the source lives under
/// `src/` regardless of where the nearest manifest sits.
#[cfg(target_os = "linux")]
fn looks_like_rust(cwd: &std::path::Path) -> bool {
    shallow_listing(cwd).iter().any(|p| {
        p.file_name().is_some_and(|n| n == "Cargo.toml") || p.extension().is_some_and(|e| e == "rs")
    })
}

/// The host's rustup layout, resolved into a bindable [`bsc_sandbox::Toolchain`] — `None` when the
/// host paths this needs do not exist. Pure past the two existence checks, so the interesting shape
/// (which paths get bound where) is covered by `bsc-sandbox`'s own tests; this function only decides
/// WHETHER the host has something to offer.
#[cfg(target_os = "linux")]
fn rust_toolchain_for_paths(
    host_cargo_home: &std::path::Path,
    host_rustup_home: &std::path::Path,
    session_cargo_home: &std::path::Path,
) -> Option<bsc_sandbox::Toolchain> {
    let host_cargo_bin = host_cargo_home.join("bin");
    if !host_cargo_bin.join("cargo").is_file() || !host_rustup_home.is_dir() {
        return None;
    }
    Some(bsc_sandbox::rust_toolchain(&host_cargo_bin, host_rustup_home, session_cargo_home))
}

/// The Rust toolchain to bind into a caged launch, resolved from THIS host's rustup layout.
///
/// `CARGO_HOME`/`RUSTUP_HOME` are read from the environment first, falling back to rustup's own
/// defaults (`~/.cargo`, `~/.rustup`) — the same precedence `rustup` itself uses. `None` means the
/// host has no rustup toolchain to offer: the cage cannot fetch one itself, by design (`apt`/`curl`
/// are deliberately not in the curated set), so this is a real dead end, not a smaller grant — the
/// caller logs it rather than silently launching a session that cannot build.
///
/// The session's own `CARGO_HOME` is created under `stores_root` (never the host's — see
/// [`bsc_sandbox::rust_toolchain`]'s docs for why) so it persists across relaunches of the same pane
/// without being writable from any OTHER pane.
#[cfg(target_os = "linux")]
fn rust_toolchain_for(pane_id: &str, stores_root: &std::path::Path) -> Option<bsc_sandbox::Toolchain> {
    let home = crate::platform::paths::home_dir();
    let host_cargo_home = std::env::var_os("CARGO_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".cargo"));
    let host_rustup_home = std::env::var_os("RUSTUP_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| home.join(".rustup"));
    let session_cargo_home = stores_root.join("cargo");
    if let Err(e) = std::fs::create_dir_all(&session_cargo_home) {
        log::warn!("pty[{pane_id}] no session CARGO_HOME ({e}); the Rust toolchain will not be bound");
        return None;
    }
    rust_toolchain_for_paths(&host_cargo_home, &host_rustup_home, &session_cargo_home)
}

// request #143 (network-monitor:director): a Rust-only project's caged workers had no way to build
// or test what they wrote, and no way to signal it beyond a `bsc-ask` a human had to notice.
#[cfg(all(test, target_os = "linux"))]
mod rust_toolchain_detection_tests {
    use super::{looks_like_rust, rust_toolchain_for_paths};
    use crate::testutil::unique_dir;
    use std::fs;

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = unique_dir("bsc-rust-detect", tag);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_root_manifest_is_detected() {
        let dir = scratch("root-manifest");
        fs::write(dir.join("Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        assert!(looks_like_rust(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_manifest_only_in_a_nested_crate_is_still_detected() {
        // Request #143's own worktree: `crates/<name>/Cargo.toml` with nothing at the root — a
        // check gated on a root manifest would have missed exactly this project.
        let dir = scratch("nested-manifest");
        fs::create_dir_all(dir.join("crates/netcon-core")).unwrap();
        fs::write(dir.join("crates/netcon-core/Cargo.toml"), "[package]\nname=\"x\"\n").unwrap();
        assert!(looks_like_rust(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_bare_rs_file_with_no_manifest_anywhere_is_still_detected() {
        let dir = scratch("bare-rs");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/lib.rs"), "// nothing").unwrap();
        assert!(looks_like_rust(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_project_with_neither_signal_is_not_detected() {
        let dir = scratch("not-rust");
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/index.ts"), "export {}").unwrap();
        fs::write(dir.join("package.json"), "{}").unwrap();
        assert!(!looks_like_rust(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_scan_does_not_descend_into_target() {
        // target/ on a warm worktree can hold tens of thousands of files, and `*.rs` there is noise:
        // it does not tell you whether the SOURCE is Rust, and walking it can cost real time on
        // every launch.
        let dir = scratch("skip-target");
        fs::create_dir_all(dir.join("target/debug/build")).unwrap();
        fs::write(dir.join("target/debug/build/generated.rs"), "// build output").unwrap();
        assert!(!looks_like_rust(&dir));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn no_host_toolchain_is_a_clean_none_not_a_panic() {
        let dir = scratch("no-toolchain");
        let cargo_home = dir.join("cargo-home-that-does-not-exist");
        let rustup_home = dir.join("rustup-home-that-does-not-exist");
        let session = dir.join("session-cargo");
        assert!(rust_toolchain_for_paths(&cargo_home, &rustup_home, &session).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_present_host_toolchain_is_described() {
        let dir = scratch("has-toolchain");
        let cargo_bin = dir.join("cargo-home/bin");
        fs::create_dir_all(&cargo_bin).unwrap();
        fs::write(cargo_bin.join("cargo"), "#!/bin/sh\n").unwrap();
        let rustup_home = dir.join("rustup-home");
        fs::create_dir_all(&rustup_home).unwrap();
        let session = dir.join("session-cargo");

        let tc = rust_toolchain_for_paths(&dir.join("cargo-home"), &rustup_home, &session)
            .expect("a real cargo + rustup layout must be described, not skipped");
        assert!(tc.env.iter().any(|(k, v)| k == "CARGO_HOME" && v == bsc_sandbox::RUST_CARGO_HOME_GUEST_PATH));
        assert!(tc.env.iter().any(|(k, v)| k == "RUSTUP_HOME" && v == bsc_sandbox::RUSTUP_GUEST_PATH));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_cargo_binary_refuses_even_with_a_rustup_home() {
        // The directory existing is not enough — this is what the director's own project hit:
        // a host CARGO_HOME with no cargo shim inside it must not be described as a working
        // toolchain.
        let dir = scratch("empty-cargo-home");
        fs::create_dir_all(dir.join("cargo-home/bin")).unwrap();
        let rustup_home = dir.join("rustup-home");
        fs::create_dir_all(&rustup_home).unwrap();
        assert!(rust_toolchain_for_paths(&dir.join("cargo-home"), &rustup_home, &dir.join("session-cargo")).is_none());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_shallow_scan_is_bounded_so_a_huge_tree_cannot_hang_a_launch() {
        let dir = scratch("bounded");
        // Deeper than MAX_DEPTH (4) — a manifest past the bound must not be found, proving the
        // walk actually stops rather than merely being slow.
        let deep = dir.join("a/b/c/d/e/f");
        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join("Cargo.toml"), "[package]\n").unwrap();
        assert!(!looks_like_rust(&dir), "a manifest past MAX_DEPTH must not be found");
        fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(target_os = "linux")]
fn namespace_argv(
    role: Option<&str>,
    pane_id: &str,
    cwd: &str,
    stores_root: Option<&str>,
    shell: &str,
    harness_bins: &[&str],
    gate: GateConfig<'_>,
) -> Option<Vec<String>> {
    use bsc_sandbox::profile::{for_role, Role, SessionPaths};
    use std::path::PathBuf;

    let role_name = role.filter(|r| !r.is_empty())?;
    // A closed set: an unrecognised role is REFUSED, never defaulted to something permissive.
    // Falling back to "no sandbox" here would be worse than failing — the caller asked for
    // isolation and would silently not get it.
    let Some(role) = Role::parse(role_name) else {
        // TWO DIFFERENT THINGS REACHED THIS BRANCH and it reported both as an error, in wording that
        // described neither. A role in `UNCAGED_ROLES` does not parse ON PURPOSE — that is the
        // decision, not a fault — and returning `None` here does not "refuse to launch": the caller
        // falls through to a plain shell, so the session runs UNCAGED. The designer logged this as an
        // ERROR on every launch while working exactly as designed, and the hardcoded role list named
        // `director` and `designer`, neither of which parses.
        if let Some((_, store, blocker)) =
            bsc_sandbox::profile::UNCAGED_ROLES.iter().find(|(n, _, _)| *n == role_name)
        {
            log::info!(
                "pty[{pane_id}] {role_name} runs UNCAGED by decision — its surface is {store}, and \
                 the cage cannot host it yet ({blocker}). Launching without a namespace."
            );
        } else {
            log::error!(
                "pty[{pane_id}] sandbox role {role_name:?} is not a role at all — launching \
                 UNCAGED. Caged roles: {caged}. Uncaged by decision: {uncaged}.",
                caged = bsc_sandbox::profile::ALL_ROLES
                    .iter()
                    .copied()
                    .filter(|r| Role::parse(r.as_str()).is_some())
                    .map(|r| r.as_str())
                    .collect::<Vec<_>>()
                    .join(" "),
                uncaged = bsc_sandbox::profile::UNCAGED_ROLES
                    .iter()
                    .map(|(n, _, _)| *n)
                    .collect::<Vec<_>>()
                    .join(" "),
            );
        }
        return None;
    };
    if cwd.is_empty() {
        log::error!("pty[{pane_id}] sandbox role {role_name:?} needs a cwd to bind at /repo");
        return None;
    }

    // A REFUSAL, not a smaller cage: a session whose cwd fell back to the home directory would
    // bind the user's whole home read-write at /repo. That is not isolation with a wide root, it is
    // the opposite of the thing — so it does not launch sandboxed at all.
    if let Some(why) = sandbox_refusal(cwd) {
        log::error!("pty[{pane_id}] refusing to sandbox: {why}");
        return None;
    }

    let mut paths = SessionPaths {
        root: PathBuf::from(cwd),
        // A private HOME on tmpfs, so the harness's state and transcripts do not land in the git
        // tree and do not outlive the session. `<worktree>/.claude/settings.json` keeps its job;
        // this is the OTHER `.claude`, and conflating them is what left them sharing a directory.
        home: Some(PathBuf::from("/home/agent")),
        // ...and the ONE credential the harness needs, read-only.
        //
        // Without it Claude Code has nothing to authenticate with and stops at its interactive
        // "Select login method" menu — which, in a pane whose input is wired for an agent, reads
        // exactly like a frozen terminal. Observed. The spec has carried this since the harness
        // work; the launcher simply never filled it in.
        credential_file: credential_for_harness(),
        // ...and the harness's own onboarding/account state, as a writable per-session COPY. Without
        // it the private HOME above reads as a first run and Claude asks for a pasted OAuth code.
        harness_state_file: stores_root
            .filter(|r| !r.is_empty())
            .and_then(|r| harness_state_for(pane_id, std::path::Path::new(r))),
        // ...and the one part of the private HOME that must OUTLIVE the session: the harness's
        // transcripts, so `claude --continue` has something to continue. Without it a caged session
        // reported `has_history=false` on every launch and started over — which is not a small
        // annoyance for a STUDIO, whose whole value is a conversation that accumulates.
        history_dir: stores_root
            .filter(|r| !r.is_empty())
            .and_then(|r| history_dir_for(pane_id, std::path::Path::new(r))),
        // ...and the PreToolUse floor, which until now was declared and never bound.
        //
        // `buildSessionSettings` already writes `/bsc-hook scope` and `/bsc-hook bash-deny` into a
        // namespace session's settings.json — that is the WHOLE point of the namespaceHooks branch,
        // which DROPS the pure-shell gates because they cannot load in a cage. But nothing ever
        // filled in `hook_bin`, so `/bsc-hook` did not exist inside the namespace and both hooks
        // were no-ops. The session therefore had neither the shell gates (deliberately removed) nor
        // the binary that replaces them: `bsc-scope` and `bsc-deny` were simply absent, on the one
        // launch path that had been told it did not need them.
        //
        // `bsc-hook`'s own module docs open by naming this exact gap ("inside a namespace the hooks
        // do not run at all"). The binary was written for it and then never reached the launcher.
        //
        // `None` (not built yet) leaves the session with path confinement only — what it already
        // had — rather than refusing to launch. `hook_env` keys the gate's config off this same
        // Option, so nothing declares BSC_REPO_ROOT for a gate that is not there.
        // The shared git dir a worktree needs. Without it the cage carries the tree and not the
        // objects, and every git command in a worker session fails — see `git_common_dir_for`.
        git_common_dir: git_common_dir_for(cwd),
        hook_bin: bsc_hook_bin_path(),
        // ...and the gate's config. Without these the hook is bound and answers Allow to
        // everything: `scope_verdict` treats empty globs as unrestricted, so the write-scope half
        // of the floor was present and inert.
        //
        // A HOST-SHAPED glob is dropped rather than passed on. The gate normalizes against
        // `BSC_REPO_ROOT=/repo`, so an absolute host path cannot strip and every write would read
        // as out-of-scope — which fails closed but wedges the agent on its own worktree, and the
        // cause would show up as the gate blocking writes it was configured to allow.
        scope_globs: guest_relative_globs(pane_id, gate.scope_globs),
        deny_bash: gate.deny_bash.to_string(),
        ..Default::default()
    };
    if let Some(root) = stores_root.filter(|r| !r.is_empty()) {
        let root = PathBuf::from(root);
        // The emitter rc, if the launcher wrote one beside the outbox.
        let rc = root.join("bsc-rc");
        if rc.is_file() {
            paths.rc_file = Some(rc);
        }
        for name in ["plan", "graph", "ui", "coord"] {
            let dir = root.join(name);
            if dir.is_dir() {
                paths.stores.push((name.to_string(), dir));
            }
        }
        // The writable holes, bound AFTER their read-only projections so each lands on top rather
        // than being overmounted. The mountpoint must already exist inside the projection — bwrap
        // cannot mkdir inside a read-only bind.
        for (proj, guest) in [("coord", "/coord/out"), ("ui", "/ui/out"), ("plan", "/plan/out")] {
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

    // The session's HARNESS. Without it the cage is complete and useless: a worker launched with a
    // 3 KB kickoff for `claude`, and the tty answered `bash: claude: command not found` — the agent
    // runtime was never bound. `bins_for(role)` gives git and gh; a runtime is the caller's to name,
    // which is the point of `extra_bins` (the alternative is Usr::All, i.e. every binary on the host).
    match for_role(role, unit, &paths, harness_bins, session_limits(role), scope_mode(), vec![shell.to_string(), "-i".into()]) {
        Ok(mut p) => {
            if let Some(c) = &p.caveat {
                // A profile that knowingly grants more than the model wants must be visible at the
                // point of launch, not only in a doc comment.
                log::warn!("pty[{pane_id}] sandbox caveat: {c}");
            }

            // The PROJECT's toolchain, on top of the role's fixed bin set — request #143
            // (network-monitor:director): a Rust-only project's workers had no `cargo`/`rustc` in
            // the cage, and no way to fetch one (the curated set has no `apt`/`curl` on purpose), so
            // every stream's gate could mark `complete` and never `verified`. `harness_bins` names
            // the RUNTIME (node/claude); this is the same idea one layer up, for the PROJECT.
            if looks_like_rust(std::path::Path::new(cwd)) {
                match stores_root.filter(|r| !r.is_empty()) {
                    Some(root) => match rust_toolchain_for(pane_id, std::path::Path::new(root)) {
                        Some(tc) => {
                            log::info!(
                                "pty[{pane_id}] {role_name} looks like a Rust project — binding the host's cargo/rustc"
                            );
                            p.spec.add_toolchain(tc);
                        }
                        None => log::warn!(
                            "pty[{pane_id}] {role_name} looks like a Rust project but this host has \
                             no rustup toolchain to bind (checked $CARGO_HOME/$RUSTUP_HOME and their \
                             defaults, ~/.cargo and ~/.rustup) — cargo/rustc will be unavailable \
                             inside the cage"
                        ),
                    },
                    None => log::warn!(
                        "pty[{pane_id}] {role_name} looks like a Rust project but has no stores root \
                         to hold a session CARGO_HOME — cargo/rustc will be unavailable inside the cage"
                    ),
                }
            }

            match p.spec.render() {
                Ok(argv) => {
                    log::info!(
                        "pty[{pane_id}] launching sandboxed as {role_name} — {} store(s), {} outbox(es)",
                        paths.stores.len(),
                        paths.outboxes.len()
                    );
                    // Persist the exact argv so a LATER `bsc sandbox replay <pane-id>` can
                    // reconstruct this same cage outside the app — see `write_launch_argv`'s doc
                    // comment for why this exists (request #135). Best-effort: a session that
                    // cannot be replayed later still launches fine right now.
                    if let Some(root) = stores_root.filter(|r| !r.is_empty()) {
                        if let Err(e) = bsc_sandbox::write_launch_argv(std::path::Path::new(root), &argv) {
                            log::warn!("pty[{pane_id}] could not persist the launch argv for replay: {e}");
                        }
                    }
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
    _harness_bins: &[&str],
    _gate: (&str, &str),
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
    use super::{namespace_argv, namespace_supported, GateConfig};

    #[test]
    fn the_probe_agrees_with_what_the_launcher_will_actually_do() {
        // The invariant that matters: `sandbox_available()` must not claim a capability
        // `namespace_argv` then refuses. If it did, the frontend would write a hook list pointing at
        // /bsc-hook for a session that launches unsandboxed — no write-scope, no command floor.
        let rendered = namespace_argv(Some("worker"), "probe", "/tmp/wt", None, "bash", &[], GateConfig::default()).is_some();
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
        assert!(namespace_argv(None, "p", "/tmp", None, "bash", &[], GateConfig::default()).is_none());
        assert!(namespace_argv(Some(""), "p", "/tmp", None, "bash", &[], GateConfig::default()).is_none());
    }

    #[test]
    fn an_unknown_role_refuses_rather_than_launching_unsandboxed() {
        // The security-relevant one. A typo must NOT quietly yield a session with no isolation —
        // the caller asked for a cage and would believe it got one.
        assert!(namespace_argv(Some("wroker"), "p", "/tmp", None, "bash", &[], GateConfig::default()).is_none());
        assert!(namespace_argv(Some("root"), "p", "/tmp", None, "bash", &[], GateConfig::default()).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_known_role_renders_a_scope_wrapping_a_namespace() {
        let a = namespace_argv(Some("worker"), "pane-1", "/tmp/wt", None, "bash", &[], GateConfig::default())
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
        assert!(namespace_argv(Some("worker"), "p", "", None, "bash", &[], GateConfig::default()).is_none());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_scope_name_is_derived_from_the_pane_so_two_launches_do_not_collide() {
        // systemd refuses a --unit that is still loaded, so a FIXED name makes the second launch
        // of a pane silently fail to start.
        let a = namespace_argv(Some("worker"), "studio:worker-1", "/tmp/wt", None, "bash", &[], GateConfig::default()).unwrap();
        let unit = a.iter().find(|x| x.starts_with("--unit=")).expect("a unit is named");
        assert!(unit.contains("studio"), "the pane id is in the unit: {unit}");
        assert!(!unit.contains(':'), "and sanitized to be unit-safe: {unit}");
        let b = namespace_argv(Some("worker"), "studio:worker-2", "/tmp/wt", None, "bash", &[], GateConfig::default()).unwrap();
        assert_ne!(unit, b.iter().find(|x| x.starts_with("--unit=")).unwrap());
    }

    /// `/graph` reaches the cage through a SYMLINK, and that has to keep working.
    ///
    /// The graph projection is 12.4 MB — measured, because every node carries its full `code` — and it
    /// is a GLOBAL store, byte-identical for every session. So it is built once and each pane gets a
    /// symlink to it rather than its own copy (~124 MB across a ten-session fleet, for nothing).
    ///
    /// The reason it is a symlink rather than `namespace_argv` reaching into a machine-global
    /// directory: that would have made "is `/graph` mounted?" depend on whether this machine happened
    /// to have a projection lying around, and the test right below this one asserts exactly that
    /// question. Discovery stays a pure function of the pane's own root.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_symlinked_graph_projection_is_mounted_like_a_real_one() {
        let base = std::env::temp_dir().join(format!("bsc-ns-link-{}", std::process::id()));
        let shared = base.join("shared-graph");
        let root = base.join("pane");
        let _ = std::fs::create_dir_all(&shared);
        let _ = std::fs::create_dir_all(&root);
        std::os::unix::fs::symlink(&shared, root.join("graph")).expect("symlink the shared graph");

        let a = namespace_argv(Some("worker"), "p", "/tmp/wt", Some(root.to_str().unwrap()), "bash", &[], GateConfig::default())
            .unwrap();

        // `Path::is_dir` follows the link, so discovery needs no special case and bwrap binds the
        // resolved target.
        assert!(a.iter().any(|x| x == "/graph"), "a symlinked projection must mount: {a:?}");
        let i = a.iter().position(|x| x == "/graph").unwrap();
        assert_eq!(a[i - 2], "--ro-bind", "the graph is READ-ONLY — every session shares it: {a:?}");
        let _ = std::fs::remove_dir_all(&base);
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
            &[],
            GateConfig::default(),
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

    /// Request #135: a dev session had no way to reproduce a real caged launch outside the app and
    /// resorted to grepping `journalctl` for an argv that was never logged there. `namespace_argv`
    /// itself does not persist the record (that happens one call frame up, in `pty_create`, where
    /// `stores_root` is the real per-pane directory) — this pins that the render this function
    /// produces is exactly what `bsc sandbox replay` would need, byte for byte, if it were handed
    /// the same stores root.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_rendered_argv_is_exactly_what_a_replay_would_persist_and_read_back() {
        let root = std::env::temp_dir().join(format!("bsc-ns-replay-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();

        let a = namespace_argv(Some("worker"), "p", "/tmp/wt", Some(root.to_str().unwrap()), "bash", &[], GateConfig::default())
            .unwrap();

        bsc_sandbox::write_launch_argv(&root, &a).expect("the launcher's own write path");
        assert_eq!(bsc_sandbox::read_launch_argv(&root).unwrap(), a, "a replay reads back the exact argv the launch rendered");

        let _ = std::fs::remove_dir_all(&root);
    }

    // What an agent emits has to REACH someone. It cannot append to coord.log itself — the log is
    // on the host and the cage binds no writable path to it, deliberately — so it writes a file
    // into /coord/out and this side carries it across. Before the drain the emitters completed and
    // reached nobody, which is quieter than the hang they replaced and no better.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_outbox_drain_carries_an_emission_into_the_coordination_log() {
        let base = std::env::temp_dir().join(format!("bsc-drain-{}", std::process::id()));
        let outbox = base.join("coord").join("out");
        std::fs::create_dir_all(&outbox).unwrap();
        let log = base.join("coord.log");

        // Exactly what the shim writes: the FILENAME is the verb, the CONTENTS are the message.
        std::fs::write(outbox.join("ask.123"), "Which branch should I target?").unwrap();
        std::fs::write(outbox.join("nonsense.1"), "not a verb").unwrap();
        std::fs::write(outbox.join(".notes"), "local provenance, not an event").unwrap();

        super::spawn_outbox_drain("demo:worker".into(), outbox.clone(), log.clone());
        let mut text = String::new();
        for _ in 0..40 {
            std::thread::sleep(std::time::Duration::from_millis(200));
            text = std::fs::read_to_string(&log).unwrap_or_default();
            if text.contains("ask") { break; }
        }

        assert!(text.contains("Which branch should I target?"), "the message lands: {text:?}");
        assert!(text.contains("demo:worker"), "tagged with the pane that emitted it: {text:?}");
        assert!(text.contains("	ask	"), "as the ask verb, TSV: {text:?}");
        // An unknown verb is REFUSED with feedback the agent can read, not silently dropped.
        assert!(outbox.join("nonsense.1.rejected").is_file(), "a rejection explains the fix");
        assert!(!text.contains("not a verb"), "and never reaches the log");
        // Local provenance is not an event.
        assert!(outbox.join(".notes").is_file(), ".notes is left alone");
        assert!(!text.contains("local provenance"));

        let _ = std::fs::remove_dir_all(&base);   // also stops the drain thread
    }

    // A caged worker READS its plan as files, because it cannot run `bsc` — binding that would
    // mean binding a writable database, the ambient authority the isolation removes. Before this
    // the launch logged `0 store(s)` and a worker told to consult its plan simply could not.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_projected_plan_is_readable_inside_and_stays_read_only() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let base = std::env::temp_dir().join(format!("bsc-planproj-{}", std::process::id()));
        let wt = base.join("wt");
        let stores = base.join("stores");
        std::fs::create_dir_all(&wt).unwrap();
        // Materialize a projection the way the launcher does, from the same library.
        let items = bsc_storefs::plan::from_json(
            r#"[{"ref":"demo-item","title":"A demo","status":"open","body":"b","acceptance":["a"],"labels":[],"dependsOn":[]}]"#,
        )
        .expect("the FULL shape parses");
        let tree = bsc_storefs::plan::project(&items, "2026-01-01T00:00:00Z");
        bsc_storefs::materialize(&stores.join("plan"), &tree).expect("materialize");

        let argv = namespace_argv(
            Some("worker"), "pp", wt.to_str().unwrap(),
            Some(stores.to_str().unwrap()), "/bin/sh", &[],
            GateConfig::default(),
        )
        .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", r#"cat /plan/items/demo-item/status 2>/dev/null; ls /plan/by-status 2>/dev/null | head -1; test -w /plan && echo PLAN-WRITABLE"#]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let _ = std::fs::remove_dir_all(&base);

        assert!(text.contains("open"), "the item's status reads as a FILE: {text:?}");
        // Read-only by the MOUNT, not by convention — an agent cannot rewrite its own plan.
        assert!(!text.contains("PLAN-WRITABLE"), "/plan must be read-only: {text:?}");
    }

    /// The protocol's OWN caged instructions, executed inside a real cage
    /// (bsc-is-unreachable-inside-the-namespace-cage).
    ///
    /// The defect was a disagreement, not a missing feature: the worker protocol told every worker to
    /// read the stores with `bsc`, and `bsc` cannot exist in the namespace — binding it would mean
    /// binding a writable database, which is the ambient authority the isolation removes, and the
    /// projections in `bsc-storefs` exist precisely so a read surface can be given WITHOUT that. So a
    /// caged worker was handed instructions that fail with `command not found`, which reads to an agent
    /// as a broken environment rather than as a policy.
    ///
    /// This asserts the fix the way the acceptance asks for: it EXTRACTS the commands from the shipped
    /// protocol markdown and runs those, rather than restating them here. A test with its own copy of
    /// the commands proves the copy works; only running the document catches the document going stale.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_protocols_caged_store_commands_actually_run_inside_the_cage() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        // The EMBEDDED seed, via an empty config root, so a stale local mirror cannot decide this.
        let empty_cfg = std::env::temp_dir().join(format!("bsc-cagedoc-{}", std::process::id()));
        std::fs::create_dir_all(&empty_cfg).unwrap();
        let md = crate::platform::config::with_config_root(&empty_cfg, crate::fleet::protocols::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty_cfg);

        let block = md
            .split_once("<!-- caged-store-commands -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-store-commands -->"))
            .map(|(b, _)| b.to_string())
            .expect("the protocol carries a caged-store-commands block");
        let cmds: Vec<String> = block
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("ls ") || l.starts_with("cat "))
            .map(|l| l.split('#').next().unwrap_or(l).trim().to_string())
            .collect();
        assert!(!cmds.is_empty(), "the block must contain runnable commands: {block}");

        let base = std::env::temp_dir().join(format!("bsc-cagedrun-{}", std::process::id()));
        let wt = base.join("wt");
        let stores = base.join("stores");
        std::fs::create_dir_all(&wt).unwrap();
        // Materialize the three record projections from the SAME library the launcher uses.
        let items = bsc_storefs::plan::from_json(
            r#"[{"ref":"demo-item","title":"A demo","status":"open","body":"b","acceptance":["a"],"labels":[],"dependsOn":[]}]"#,
        )
        .expect("plan json parses");
        bsc_storefs::materialize(&stores.join("plan"), &bsc_storefs::plan::project(&items, "2026-01-01T00:00:00Z"))
            .expect("materialize plan");
        let impls = bsc_storefs::graph::from_json(
            r#"[{"id":"fib","name":"fibonacci","role":"algorithm","summary":"s","domain":"math","tech":"typescript","code":"export const f=1;"}]"#,
        )
        .expect("graph json parses");
        bsc_storefs::materialize(&stores.join("graph"), &bsc_storefs::graph::project(&impls, "2026-01-01T00:00:00Z"))
            .expect("materialize graph");
        let comps = bsc_storefs::ui::from_json(
            r#"[{"id":"card","name":"Card","role":"composite","folder":"shared/ui","kitId":"base-studio-code"}]"#,
        )
        .expect("ui json parses");
        bsc_storefs::materialize(&stores.join("ui"), &bsc_storefs::ui::project(&comps, "2026-01-01T00:00:00Z"))
            .expect("materialize ui");

        let argv = namespace_argv(
            Some("worker"), "cagedoc", wt.to_str().unwrap(),
            Some(stores.to_str().unwrap()), "/bin/sh", &[],
            GateConfig::default(),
        )
        .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();

        // Every command runs, and `bsc` is confirmed ABSENT — the premise the block is written for.
        let script = format!(
            "command -v bsc >/dev/null && echo BSC-PRESENT; {}",
            cmds.iter().map(|c| format!("{c} >/dev/null 2>&1 || echo \"FAILED: {c}\"")).collect::<Vec<_>>().join("; ")
        );
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", &script]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let _ = std::fs::remove_dir_all(&base);

        assert!(
            !text.contains("BSC-PRESENT"),
            "the caged block is written for a cage WITHOUT bsc; if bsc is reachable the protocol should \
             say so instead: {text:?}"
        );
        assert!(
            !text.contains("FAILED:"),
            "every command the protocol gives a caged worker must run there — {text:?}"
        );
    }

    /// The WRITE half of the same guarantee: the commands the protocol gives a caged worker for
    /// recording its work actually run in the cage, and what they leave behind is what the drain
    /// accepts.
    ///
    /// A round trip, not two halves asserted separately. Running the commands proves `/plan/out` is
    /// writable through the mount; feeding the result to `drain_writes` proves the shape the
    /// protocol teaches is the shape the host applies. Either alone can pass while the pair is
    /// broken — which is exactly how a worker ends up with a green gate and no record.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_protocols_caged_plan_writes_run_inside_the_cage_and_the_drain_accepts_them() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        // The EMBEDDED seed, so a stale local mirror cannot decide this.
        let empty_cfg = std::env::temp_dir().join(format!("bsc-cagedw-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&empty_cfg).unwrap();
        let md = crate::platform::config::with_config_root(&empty_cfg, crate::fleet::protocols::fleet_protocol_md);
        let _ = std::fs::remove_dir_all(&empty_cfg);

        let block = md
            .split_once("<!-- caged-plan-writes -->")
            .and_then(|(_, rest)| rest.split_once("<!-- /caged-plan-writes -->"))
            .map(|(b, _)| b.to_string())
            .expect("the protocol carries a caged-plan-writes block");
        let script: Vec<String> = block
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("mkdir ") || l.starts_with("echo "))
            .map(str::to_string)
            .collect();
        assert!(!script.is_empty(), "the block must contain runnable commands: {block}");

        let base = std::env::temp_dir().join(format!("bsc-cagedw-{}", std::process::id()));
        let wt = base.join("wt");
        let stores = base.join("stores");
        std::fs::create_dir_all(&wt).unwrap();
        // The read-only projection, and the WRITABLE hole inside it — exactly what the launcher
        // builds: `scaffold_store_root` makes `plan/out` on the host because bwrap cannot mkdir
        // inside a read-only bind.
        let items = bsc_storefs::plan::from_json(
            r#"[{"ref":"my-ref","title":"A demo","status":"open","body":"b","acceptance":["a"],"labels":[],"dependsOn":[]}]"#,
        )
        .expect("plan json parses");
        bsc_storefs::materialize(&stores.join("plan"), &bsc_storefs::plan::project(&items, "2026-01-01T00:00:00Z"))
            .expect("materialize plan");
        std::fs::create_dir_all(stores.join("plan").join("out")).unwrap();

        let argv = namespace_argv(
            Some("worker"), "cagedw", wt.to_str().unwrap(),
            Some(stores.to_str().unwrap()), "/bin/sh", &[],
            GateConfig::default(),
        )
        .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();

        // `bsc` must be ABSENT — the premise the block is written for — and every line must run.
        let sh = format!(
            "command -v bsc >/dev/null && echo BSC-PRESENT; {}",
            script.iter().map(|c| format!("{{ {c} ; }} || echo \"FAILED: {c}\"")).collect::<Vec<_>>().join("; ")
        );
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", &sh]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();

        assert!(
            !text.contains("BSC-PRESENT"),
            "the caged block is written for a cage WITHOUT bsc: {text:?}",
        );
        assert!(
            !text.contains("FAILED:"),
            "every write command the protocol gives a caged worker must run there — {text:?} / {}",
            String::from_utf8_lossy(&out.stderr),
        );

        // ...and now the other half of the round trip: read back what the cage left on the host and
        // put it through the real drain.
        let outbox = stores.join("plan").join("out");
        let mut entries: Vec<(String, Vec<(String, String)>)> = Vec::new();
        for d in std::fs::read_dir(&outbox).expect("outbox exists").filter_map(Result::ok) {
            let name = d.file_name().to_string_lossy().into_owned();
            let mut fields = Vec::new();
            for f in std::fs::read_dir(d.path()).expect("entry dir").filter_map(Result::ok) {
                let k = f.file_name().to_string_lossy().into_owned();
                fields.push((k, std::fs::read_to_string(f.path()).expect("field")));
            }
            entries.push((name, fields));
        }
        let _ = std::fs::remove_dir_all(&base);

        assert_eq!(entries.len(), 4, "the block writes four entries: {entries:?}");
        let (accepted, rejected) = bsc_storefs::plan::drain_writes(&entries);
        assert!(rejected.is_empty(), "the protocol must not teach a shape the drain refuses: {rejected:?}");
        assert_eq!(accepted.len(), 4, "every entry becomes a plan write: {accepted:?}");

        // The four the protocol names, each becoming its `bsc plan …` call.
        let argvs: Vec<Vec<String>> = accepted.iter().map(|(_, w)| w.argv()).collect();
        assert!(argvs.iter().any(|a| a[..3] == ["plan", "change", "new"]), "{argvs:?}");
        assert!(argvs.iter().any(|a| a[..3] == ["plan", "change", "note"]), "{argvs:?}");
        assert!(argvs.iter().any(|a| a[..3] == ["plan", "change", "gate"]), "{argvs:?}");
        assert!(
            argvs.iter().any(|a| a[..2] == ["plan", "status"] && a.last().unwrap() == "complete"),
            "the worker marks its own item COMPLETE, never verified: {argvs:?}",
        );
    }

    // Claude Code with no credential stops at its interactive "Select login method" menu — which,
    // in a pane whose input is wired for an agent, reads exactly like a frozen terminal. That is
    // what shipped: the spec carried `credential_file` and the launcher never filled it in.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_session_carries_its_credential_and_nothing_else_from_home() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        // Only meaningful where the host actually HAS a credential to hand over.
        let Some(_) = super::credential_for_harness() else { return };
        let wt = std::env::temp_dir().join(format!("bsc-cred-{}", std::process::id()));
        std::fs::create_dir_all(&wt).unwrap();
        let argv = namespace_argv(Some("worker"), "c", wt.to_str().unwrap(), None, "/bin/sh", &[], GateConfig::default())
            .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", r#"echo "HOME=$HOME"; test -r "$HOME/.claude/.credentials.json" && echo CRED-READABLE; (echo x > "$HOME/.claude/.credentials.json") 2>/dev/null && echo CRED-WRITABLE; ls -A "$HOME/.claude" | wc -l"#]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let _ = std::fs::remove_dir_all(&wt);

        assert!(text.contains("HOME=/home/agent"), "a PRIVATE home, not the worktree: {text:?}");
        assert!(text.contains("CRED-READABLE"), "the harness can authenticate: {text:?}");
        assert!(!text.contains("CRED-WRITABLE"), "and cannot alter its token: {text:?}");
        // Exactly one entry: never the whole ~/.claude, which holds every project's transcripts.
        assert!(text.trim_end().ends_with("1"), "one file crosses, not a directory: {text:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_session_whose_cwd_is_home_refuses_rather_than_caging_the_whole_home() {
        // Observed: a pane with no cwd fell back to $HOME and launched sandboxed, binding the
        // user's entire home read-write at /repo. A cage containing everything is not a cage.
        let home = crate::platform::paths::home_dir();
        assert!(namespace_argv(Some("worker"), "h", home.to_str().unwrap(), None, "/bin/sh", &[], GateConfig::default()).is_none());
    }

    // The cage shipped complete and USELESS: a worker was launched with a 3 KB kickoff for
    // `claude` and the tty answered `bash: claude: command not found`. Asserting the argv MENTIONS
    // the binaries would not have caught that either — this runs it and asks the shell inside,
    // which is the only answer that counts.
    #[cfg(target_os = "linux")]
    #[test]
    fn the_harness_a_session_needs_is_actually_reachable_inside() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let wt = std::env::temp_dir().join(format!("bsc-harness-{}", std::process::id()));
        std::fs::create_dir_all(&wt).unwrap();
        let wt_s = wt.to_str().unwrap().to_string();
        let argv = namespace_argv(Some("worker"), "h", &wt_s, None, "/bin/sh", &["node", "claude"], GateConfig::default())
            .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", r#"command -v node >/dev/null && echo NODE-OK; command -v claude >/dev/null && echo CLAUDE-OK; command -v bsc >/dev/null && echo BSC-REACHABLE; case ":$PATH:" in *:.:*) echo PATH-HAS-CWD;; esac"#]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let _ = std::fs::remove_dir_all(&wt);
        assert!(text.contains("NODE-OK"), "the harness runtime must be reachable: {text:?}");
        assert!(text.contains("CLAUDE-OK"), "and so must the harness itself: {text:?}");
        // Binding a runtime is not licence to widen the cage.
        assert!(!text.contains("BSC-REACHABLE"), "still no bsc — that would bind a writable store");
        // ...and PATH must not carry the cwd, the agent's own writable worktree.
        assert!(!text.contains("PATH-HAS-CWD"), "PATH must not contain `.`: {text:?}");
    }

    // The end-to-end one: the argv the LAUNCH PATH produces is executed for real, and the escape
    // that a PreToolUse hook cannot see is checked against it. Everything above asserts strings;
    // this asserts behaviour.
    // The one that matters: a sandboxed session must SURVIVE an external command.
    //
    // Every earlier attempt at this failed on HAND-COPYING the init line rather than on the
    // hypothesis, so this copies nothing — it calls `build_bash_init_line` and feeds its exact
    // bytes to a real PTY, which is the app's own shape. `script(1)` and a simplified init line
    // both survive `ls -l`; the app does not, so the difference has to be in what the real builder
    // emits.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_session_survives_an_external_command() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};

        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let wt = std::env::temp_dir().join(format!("bsc-extcmd-{}", std::process::id()));
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("main.rs"), "fn main() {}\n").unwrap();
        let wt_s = wt.to_str().unwrap().to_string();

        let argv = namespace_argv(Some("worker"), "extcmd", &wt_s, None, "/bin/bash", &["node", "claude"], GateConfig::default())
            .expect("a worker renders");

        // The REAL init line, sandboxed. `rc_bash` is the host path the launcher passes today —
        // it is NOT bound inside the namespace, which is exactly the condition under test.
        let claude_fn = "claude() { __bsc_state run; command claude \"$@\"; }; ";
        let init = super::launch::build_bash_init_line(
            &wt_s, false, &wt_s, None, claude_fn,
            "/home/nobody/.base-studio-code/bsc-env.sh", "", true, None);

        let pty = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 165, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        let mut child = pty.slave.spawn_command(cmd).expect("spawn");
        drop(pty.slave);

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let collected = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
            }
            all
        });

        let mut w = pty.master.take_writer().expect("writer");
        let step = |w: &mut Box<dyn Write + Send>, bytes: &[u8]| {
            w.write_all(bytes).ok();
            w.flush().ok();
            std::thread::sleep(std::time::Duration::from_millis(1200));
        };
        step(&mut w, init.as_bytes());
        // The app REFITS the pty a beat after launch — observed in a real session:
        // `refit · grid=165x30 → 165x28`. A resize signals SIGWINCH to the terminal's foreground
        // process group, and inside a PID namespace that group is namespace-relative — the one
        // app behaviour the earlier reproductions never exercised.
        pty.master
            .resize(PtySize { rows: 28, cols: 165, pixel_width: 0, pixel_height: 0 })
            .expect("resize");
        std::thread::sleep(std::time::Duration::from_millis(400));
        step(&mut w, b"ls -l\n");            // EXTERNAL: fork + exec, the step that killed it
        step(&mut w, b"echo SURVIVED-EXT\n"); // only reachable if the shell is still there
        let early = child.try_wait().ok().flatten();
        step(&mut w, b"exit\n");
        drop(w);

        let out = collected.join().unwrap_or_default();
        let text = String::from_utf8_lossy(&out).to_string();
        let _ = std::fs::remove_dir_all(&wt);

        assert!(text.contains("main.rs"), "the external command ran: {} bytes", out.len());
        assert!(
            text.contains("SURVIVED-EXT"),
            "the shell must outlive an external command — exited early: {early:?}\n\
             {} bytes emitted:\n{}",
            out.len(),
            text
        );
    }

    /// The same survival property, but with the STORES BOUND — which is the shape the app actually
    /// launches and the one above does not.
    ///
    /// `a_sandboxed_session_survives_an_external_command` passes `stores_root: None`, so it binds no
    /// `/plan` `/graph` `/ui` `/coord` projections, no writable outboxes, no rc and no harness-state
    /// file. The app passes `Some(...)` and logs `4 store(s), 1 outbox(es)` on every launch. So the
    /// green test covers a cage the app never launches, and a maintainer watched sessions die after
    /// one command while it stayed green — this repo's recurring failure shape.
    ///
    /// Drives the same two steps: an EXTERNAL command (fork + exec), then a marker only a live shell
    /// can print.
    /// The cage's workspace must be PRE-TRUSTED, or the session opens on a modal whose second option
    /// is "No, exit" — and the user's first keystrokes go to that modal, not to the agent.
    ///
    /// Trust is keyed on the ABSOLUTE path, and inside the namespace that path is `/repo`, which never
    /// exists on the host. So this can never be satisfied by the user trusting the real directory; it
    /// has to be written into the per-session copy.
    #[test]
    fn the_guest_workspace_is_pre_trusted_in_the_session_state_copy() {
        let dir = std::env::temp_dir().join(format!("bsc-trust-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join(".claude.json");
        // A realistic starting shape: the host's own projects, none of them the guest path.
        std::fs::write(
            &state,
            r#"{"projects":{"/home/u/code":{"hasTrustDialogAccepted":true}},"autoUpdates":true}"#,
        )
        .unwrap();

        super::trust_guest_repo("test-pane", &state);

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        assert_eq!(
            v["projects"][bsc_sandbox::REPO_GUEST_PATH]["hasTrustDialogAccepted"],
            serde_json::Value::Bool(true),
            "the guest workspace must be trusted: {v}"
        );
        assert_eq!(
            v["projects"][bsc_sandbox::REPO_GUEST_PATH]["hasCompletedProjectOnboarding"],
            serde_json::Value::Bool(true),
            "and must not re-run project onboarding: {v}"
        );
        // Everything else survives — this rewrites one entry, it does not rebuild the file.
        assert_eq!(v["projects"]["/home/u/code"]["hasTrustDialogAccepted"], serde_json::Value::Bool(true));
        assert_eq!(v["autoUpdates"], serde_json::Value::Bool(true), "unrelated state preserved: {v}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The path the cage BINDS and the path the trust write KEYS ON are one value, proved by reading
    /// BOTH ends rather than by asserting each against the same const.
    ///
    /// That distinction is the whole point. `REPO_GUEST_PATH` was introduced for the trust key while
    /// every site that actually binds the tree kept its own `"/repo"` literal, so the guest path had
    /// two definitions and nothing could see them disagree: a test that compared the trust key to the
    /// const would have passed no matter what the BIND said. Here the expected key is taken from a
    /// rendered argv, so changing the bind and leaving the key behind fails — and it fails as a test,
    /// not as the trust dialog reappearing with no obvious cause, which is how this class was found.
    #[test]
    fn the_bound_guest_path_is_the_path_the_trust_write_keys_on() {
        let spec = bsc_sandbox::SandboxSpec::worker(
            "bsc-guest-path-test",
            "/host/worktree",
            "/host/store",
            vec!["bash".to_string()],
        );
        let argv = spec.render().expect("the worker spec renders");
        // `--bind <host> <guest>` — the guest side of the worktree mount IS the cage's repo path.
        let bound = argv
            .windows(3)
            .find(|w| w[0] == "--bind" && w[1] == "/host/worktree")
            .map(|w| w[2].clone())
            .expect("the worker binds its worktree");

        let dir = std::env::temp_dir().join(format!("bsc-guest-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join(".claude.json");
        std::fs::write(&state, r#"{"projects":{}}"#).unwrap();
        super::trust_guest_repo("test-pane", &state);
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&state).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(
            v["projects"][&bound]["hasTrustDialogAccepted"],
            serde_json::Value::Bool(true),
            "the cage binds the repo at {bound}, so that is the path the trust write must key on: {v}"
        );
        // And nothing ELSE was trusted — a write keyed on a stale path would show up as a second entry.
        assert_eq!(
            v["projects"].as_object().map(|m| m.len()),
            Some(1),
            "exactly one project trusted, keyed on the bound path: {v}"
        );
    }

    /// Fail-safe: a state file that is not JSON leaves the plain copy alone rather than destroying it.
    #[test]
    fn an_unparseable_harness_state_is_left_untouched() {
        let dir = std::env::temp_dir().join(format!("bsc-trust-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = dir.join(".claude.json");
        std::fs::write(&state, "not json at all").unwrap();
        super::trust_guest_repo("test-pane", &state);
        assert_eq!(
            std::fs::read_to_string(&state).unwrap(),
            "not json at all",
            "a copy we cannot parse must survive intact"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_sandboxed_session_with_stores_bound_survives_an_external_command() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};

        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let base = std::env::temp_dir().join(format!("bsc-stores-ext-{}", std::process::id()));
        let wt = base.join("wt");
        let stores = base.join("stores");
        std::fs::create_dir_all(&wt).unwrap();
        std::fs::write(wt.join("main.rs"), "fn main() {}\n").unwrap();
        // The projections the launcher builds, in the shape `namespace_argv` looks for: four
        // read-only store dirs, two of them carrying a writable `out/` hole.
        for name in ["plan", "graph", "ui", "coord"] {
            std::fs::create_dir_all(stores.join(name)).unwrap();
        }
        std::fs::write(stores.join("plan").join("items"), "demo\n").unwrap();
        for proj in ["coord", "ui"] {
            std::fs::create_dir_all(stores.join(proj).join("out")).unwrap();
        }
        let wt_s = wt.to_str().unwrap().to_string();
        let stores_s = stores.to_str().unwrap().to_string();

        let argv = super::namespace_argv(
            Some("worker"), "storesext", &wt_s, Some(&stores_s), "/bin/bash", &["node", "claude"],
            GateConfig::default(),
        )
        .expect("a worker with stores renders");

        let claude_fn = "claude() { __bsc_state run; command claude \"$@\"; }; ";
        let init = super::launch::build_bash_init_line(
            &wt_s, false, &wt_s, None, claude_fn,
            "/home/nobody/.base-studio-code/bsc-env.sh", "", true, None);

        let pty = native_pty_system()
            .openpty(PtySize { rows: 30, cols: 165, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(&argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        let mut child = pty.slave.spawn_command(cmd).expect("spawn");
        drop(pty.slave);

        let mut reader = pty.master.try_clone_reader().expect("reader");
        let collected = std::thread::spawn(move || {
            let mut all = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = reader.read(&mut buf) {
                if n == 0 {
                    break;
                }
                all.extend_from_slice(&buf[..n]);
            }
            all
        });

        let mut w = pty.master.take_writer().expect("writer");
        let step = |w: &mut Box<dyn Write + Send>, bytes: &[u8]| {
            w.write_all(bytes).ok();
            w.flush().ok();
            std::thread::sleep(std::time::Duration::from_millis(1200));
        };
        step(&mut w, init.as_bytes());
        // The app refits a beat after launch; SIGWINCH inside a PID namespace is namespace-relative.
        pty.master
            .resize(PtySize { rows: 28, cols: 165, pixel_width: 0, pixel_height: 0 })
            .expect("resize");
        std::thread::sleep(std::time::Duration::from_millis(400));
        step(&mut w, b"ls -l\n");
        step(&mut w, b"echo SURVIVED-STORES\n");
        let early = child.try_wait().ok().flatten();
        step(&mut w, b"exit\n");
        drop(w);

        let out = collected.join().unwrap_or_default();
        let text = String::from_utf8_lossy(&out).to_string();
        let _ = std::fs::remove_dir_all(&base);

        assert!(text.contains("main.rs"), "the external command ran: {} bytes", out.len());
        assert!(
            text.contains("SURVIVED-STORES"),
            "the shell must outlive an external command with stores bound — exited early: {early:?}\n\
             {} bytes emitted:\n{}",
            out.len(),
            text
        );
    }

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

        let argv = namespace_argv(Some("worker"), "exec-test", mine.to_str().unwrap(), None, "sh", &[], GateConfig::default())
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

#[cfg(test)]
mod dead_pane_tests {
    use super::first_write_to_missing;

    /// A pane whose shell has exited takes one keystroke per call here, so the report has to be
    /// once-per-pane: silent hid the bug, and per-keypress would bury it just as well.
    #[test]
    fn a_vanished_pane_reports_itself_exactly_once() {
        let pane = "dead-pane-tests:first:p0";
        assert!(first_write_to_missing(pane), "the first write is the one that reports");
        for _ in 0..50 {
            assert!(!first_write_to_missing(pane), "every later write stays quiet");
        }
    }

    /// The set is keyed by pane, so one dead pane never silences another.
    #[test]
    fn each_pane_gets_its_own_report() {
        assert!(first_write_to_missing("dead-pane-tests:second:p0"));
        assert!(first_write_to_missing("dead-pane-tests:third:p0"));
        assert!(!first_write_to_missing("dead-pane-tests:second:p0"));
    }
}

// ── the PreToolUse floor inside the cage (the-cage-binds-no-bsc-so-every-store-verb-is-127) ──────
//
// `buildSessionSettings` writes `/bsc-hook scope` + `/bsc-hook bash-deny` for a namespace session
// and DROPS the pure-shell gates, because those cannot load in a cage. Nothing ever set
// `SessionPaths::hook_bin`, so the path it pointed at did not exist and both hooks were no-ops —
// the session had neither the shell gates nor the binary meant to replace them.

#[cfg(all(test, target_os = "linux"))]
mod hook_floor_tests {
    use super::{bsc_hook_bin_path, namespace_argv, GateConfig};

    /// THE regression, as a BICONDITIONAL: the argv binds the gate exactly when the launcher
    /// resolved one, and declares its config exactly then too.
    ///
    /// Written this way on purpose. The obvious form — "if the binary is built, assert the bind" —
    /// passes without asserting anything wherever it is not built, and under `cargo nextest` it is
    /// never built: `current_exe()` is `target/debug/deps/<test>`, whose `sidecar_candidates` are
    /// `deps/`, `debug/debug/` and `debug/release/`, none of which is `target/debug/bsc-hook`. The
    /// first draft of this test reported PASS while taking that branch — the same green-gate-that-
    /// sees-less shape the bug it guards was hiding behind. Both branches assert now, so the test
    /// is meaningful in a checkout that has built the sidecar and in one that has not.
    #[test]
    fn the_gate_is_bound_exactly_when_the_launcher_resolved_one() {
        // `worker`, not `director` — the director joined `UNCAGED_ROLES` on 2026-08-25 and no longer
        // resolves to a namespace profile. Any still-caged role exercises this bind identically.
        let a = namespace_argv(Some("worker"), "pane-1", "/tmp/hub", None, "bash", &[], GateConfig::default())
            .expect("a known role with a cwd renders");
        let bound = a.windows(3).any(|w| w[0] == "--ro-bind" && w[2] == bsc_sandbox::HOOK_GUEST_PATH);
        let configured =
            a.windows(3).any(|w| w[0] == "--setenv" && w[1] == "BSC_REPO_ROOT" && w[2] == "/repo");

        match bsc_hook_bin_path() {
            Some(hook) => {
                let host = hook.to_string_lossy().to_string();
                assert!(
                    a.windows(3).any(|w| w[0] == "--ro-bind"
                        && w[1] == host
                        && w[2] == bsc_sandbox::HOOK_GUEST_PATH),
                    "settings.json already invokes {}; without the bind both PreToolUse hooks are \
                     no-ops and the session has neither the shell gates nor their replacement: {a:?}",
                    bsc_sandbox::HOOK_GUEST_PATH,
                );
                // The gate matches paths as the SESSION sees them — a host-shaped root would fail
                // to strip and every write would read as out-of-scope.
                assert!(configured, "a bound gate must be given its guest-relative root: {a:?}");
            }
            None => {
                assert!(!bound, "nothing to bind, so nothing may claim to be bound: {a:?}");
                assert!(
                    !configured,
                    "and no gate config may be declared for a gate that is not there — a session \
                     carrying BSC_REPO_ROOT with no /bsc-hook reads like a working floor: {a:?}",
                );
            }
        }
    }

    /// The guest path is a contract with the frontend: `buildSessionSettings` writes the literal
    /// `/bsc-hook ...` commands, and this is where they have to land. A rename on either side
    /// silently restores the original bug — settings invoking a path nothing binds.
    #[test]
    fn the_guest_path_matches_what_the_frontend_writes() {
        assert_eq!(
            bsc_sandbox::HOOK_GUEST_PATH, "/bsc-hook",
            "sessionLaunch writes `/bsc-hook scope` and `/bsc-hook bash-deny` verbatim",
        );
    }
}

// ── the caged gate's CONFIG (the-caged-gate-is-bound-but-never-told-its-write-scope) ─────────────
//
// Binding `/bsc-hook` made the dangerous-command floor real, because that floor is compiled in.
// The write-scope half is configured, and `namespace_argv` left `scope_globs`/`deny_bash` at their
// empty defaults — where `scope_verdict` reads empty as Allow. So the gate was present and inert
// for every write. These pin the config actually reaching it, and that a host-shaped glob (which
// the gate could never match, since it normalizes against /repo) narrows rather than wedges.

#[cfg(all(test, target_os = "linux"))]
mod gate_config_tests {
    use super::{guest_relative_globs, is_host_shaped_glob, namespace_argv, GateConfig};

    fn argv(role: &str, globs: &str, denies: &str) -> Vec<String> {
        namespace_argv(
            Some(role),
            "cfg-pane",
            "/tmp/wt",
            None,
            "bash",
            &[],
            GateConfig { scope_globs: globs, deny_bash: denies },
        )
            .expect("a known role with a cwd renders")
    }

    fn setenv(a: &[String], key: &str) -> Option<String> {
        a.windows(3).find(|w| w[0] == "--setenv" && w[1] == key).map(|w| w[2].clone())
    }

    /// THE regression: the role's write globs reach the gate as `$BSC_SCOPE_GLOBS`.
    #[test]
    fn a_workers_write_globs_reach_the_gate() {
        if super::bsc_hook_bin_path().is_none() {
            // `hook_env` declares gate config only alongside a bound hook — correctly, since config
            // for an absent gate reads like a working floor. Assert THAT instead of skipping.
            let a = argv("worker", "src/auth/** src/y.ts", "");
            assert_eq!(setenv(&a, "BSC_SCOPE_GLOBS"), None, "no gate ⇒ no gate config");
            return;
        }
        let a = argv("worker", "src/auth/** src/y.ts", "");
        assert_eq!(
            setenv(&a, "BSC_SCOPE_GLOBS").as_deref(),
            Some("src/auth/** src/y.ts"),
            "empty globs are read as ALLOW by scope_verdict, so an unset value is not a safe default",
        );
    }

    /// A `code: none` role carries the sentinel, which `scope_verdict` turns into an outright Deny.
    /// This is what actually stops a caged director from writing feature code.
    #[test]
    fn a_code_none_role_carries_the_deny_all_sentinel() {
        if super::bsc_hook_bin_path().is_none() {
            return;
        }
        // `triage` is the code:none role that is still CAGED — `director` was code:none too but is
        // uncaged now, so it renders no argv at all.
        let a = argv("triage", bsc_util::scope::DENY_ALL, "");
        assert_eq!(setenv(&a, "BSC_SCOPE_GLOBS").as_deref(), Some(bsc_util::scope::DENY_ALL));
    }

    /// The deny patterns travel too — the built-in dangerous floor is compiled in, but the
    /// role/user/profile denies are configuration and were being dropped.
    #[test]
    fn the_role_deny_patterns_reach_the_gate() {
        if super::bsc_hook_bin_path().is_none() {
            return;
        }
        let a = argv("worker", "src/**", "git push *\ngh pr merge *");
        assert_eq!(setenv(&a, "BSC_DENY_BASH").as_deref(), Some("git push *\ngh pr merge *"));
    }

    /// A host-shaped glob cannot match inside the cage — the gate strips `BSC_REPO_ROOT=/repo` and
    /// matches the remainder — so it is dropped rather than passed through. Passing it on fails
    /// closed but wedges the agent on its own worktree, with the gate blocking precisely the writes
    /// it was configured to allow.
    #[test]
    fn a_host_shaped_glob_is_dropped_and_the_rest_still_bounds_the_session() {
        assert_eq!(guest_relative_globs("p", "/home/u/wt/src/** src/ok.rs"), "src/ok.rs");
        assert_eq!(guest_relative_globs("p", "C:/Users/u/wt/** src/ok.rs"), "src/ok.rs");
        assert!(is_host_shaped_glob("/abs/path/**"));
        assert!(is_host_shaped_glob("C:/Users/x"));
        assert!(!is_host_shaped_glob("src/**"));
        assert!(!is_host_shaped_glob("crates/bsc-ui/src/*.rs"));
    }

    /// ...and if EVERY glob was unusable, deny rather than fall back to allow-all. A session whose
    /// entire scope failed to translate is the one case where guessing wide is worst.
    #[test]
    fn a_scope_that_translates_to_nothing_denies_rather_than_allows() {
        assert_eq!(guest_relative_globs("p", "/only/host/paths/**"), bsc_util::scope::DENY_ALL);
    }

    /// The sentinel and the empty case are path-independent and pass through untouched — the empty
    /// case is an UNGATED pane, which has no role and must stay allow-all.
    #[test]
    fn the_sentinel_and_the_ungated_case_pass_through() {
        assert_eq!(guest_relative_globs("p", bsc_util::scope::DENY_ALL), bsc_util::scope::DENY_ALL);
        assert_eq!(guest_relative_globs("p", ""), "");
    }
}

// ── the reconnect gate (a-pane-whose-child-exits-can-never-be-relaunched) ────────────────────────
//
// The gate that decides reconnect-vs-recreate used to ask `contains_key`, and `pty_kill` is the
// only other place that removes an entry. So a child that exited on its own left a tombstone that
// shadowed the pane permanently — every relaunch logged "reconnect to existing session" and
// returned, and the pane could not recover, because the call that would fix it was the one being
// refused. These drive REAL children through a real PTY: the whole failure was that a status
// nobody read looked exactly like a healthy session.

#[cfg(test)]
mod reconnect_tests {
    use super::{reconnect_or_reap, PtySession};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::collections::HashMap;

    /// A real session around `argv`, built the same way `pty_create` builds one.
    fn session(argv: &[&str]) -> PtySession {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("writer");
        PtySession { writer, master: pair.master, child, _job: None }
    }

    /// A child that exits immediately, waited to completion so its status is readable.
    fn exited_session() -> PtySession {
        let mut s = if cfg!(windows) {
            session(&["cmd", "/c", "exit 3"])
        } else {
            session(&["/bin/sh", "-c", "exit 3"])
        };
        s.child.wait().expect("the child exits on its own");
        s
    }

    /// A child that stays up for the length of the test.
    fn running_session() -> PtySession {
        if cfg!(windows) {
            session(&["cmd", "/c", "ping -n 60 127.0.0.1 > NUL"])
        } else {
            session(&["/bin/sh", "-c", "sleep 60"])
        }
    }

    /// THE regression. A director exited 1 ten seconds after launch and every relaunch for the next
    /// ten minutes was refused, because the map still held it.
    #[test]
    fn a_pane_whose_child_exited_is_recreated_not_reconnected_to() {
        let mut sessions = HashMap::new();
        sessions.insert("proj:director".to_string(), exited_session());

        assert!(
            !reconnect_or_reap(&mut sessions, "proj:director"),
            "a dead child must not be reconnected to — that is the tombstone that shadowed the pane",
        );
        assert!(
            !sessions.contains_key("proj:director"),
            "and the tombstone must be REAPED, or the next call refuses all over again",
        );
    }

    /// The case the gate exists for, which the fix must not cost: switching tabs away and back
    /// reconnects to the running agent rather than starting a second one on top of it.
    #[test]
    fn a_pane_whose_child_is_running_is_still_reconnected_to() {
        let mut sessions = HashMap::new();
        sessions.insert("proj:worker".to_string(), running_session());

        assert!(
            reconnect_or_reap(&mut sessions, "proj:worker"),
            "a live child is the reconnect case",
        );
        assert!(
            sessions.contains_key("proj:worker"),
            "and a live session is never dropped",
        );

        sessions.get_mut("proj:worker").unwrap().child.kill().ok();
    }

    /// A pane with no session at all is a plain create — no reconnect, nothing to reap.
    #[test]
    fn an_unknown_pane_creates() {
        let mut sessions = HashMap::new();
        assert!(!reconnect_or_reap(&mut sessions, "proj:never-launched"));
        assert!(sessions.is_empty());
    }
}

// ── liveness answers a confirmed state, not map presence (request #154) ──────────────────────────
//
// `bsc session list` reported `designerReact` as `live: true, busy: true` with a real pid while the
// session was actually off. The cause was the same shape as `reconnect_or_reap`'s tombstone (see
// `reconnect_tests` above): a session whose child had exited on its own — no reconnect, no
// `pty_kill` — stays in the map forever, and `pane_liveness` used to answer purely from
// `contains_key`. These tests drive real child processes (`try_wait` on a mock has nothing to
// disagree with the map about) through `pane_liveness` itself, the function both `bsc session list`
// and `bsc fleet list` share.

#[cfg(test)]
mod pane_liveness_tests {
    use super::{pane_liveness, PtySession, PtyState};
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    /// A real session around `argv`, built the same way `pty_create` builds one.
    fn session(argv: &[&str]) -> PtySession {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new(argv[0]);
        for a in &argv[1..] {
            cmd.arg(a);
        }
        let child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("writer");
        PtySession { writer, master: pair.master, child, _job: None }
    }

    /// A child that exits immediately, waited to completion so its status is readable — the exact
    /// tombstone shape `reconnect_or_reap` guards against on the create path.
    fn exited_session() -> PtySession {
        let mut s = if cfg!(windows) {
            session(&["cmd", "/c", "exit 3"])
        } else {
            session(&["/bin/sh", "-c", "exit 3"])
        };
        s.child.wait().expect("the child exits on its own");
        s
    }

    /// A child that stays up for the length of the test.
    fn running_session() -> PtySession {
        if cfg!(windows) {
            session(&["cmd", "/c", "ping -n 60 127.0.0.1 > NUL"])
        } else {
            session(&["/bin/sh", "-c", "sleep 60"])
        }
    }

    /// THE regression: a pane whose child has already exited must be reported dead, not live with a
    /// stale pid — and the withheld pid must not leak into the busy/agent process-table walk either.
    #[test]
    fn a_pane_whose_child_has_exited_reports_dead_with_no_pid() {
        let state = PtyState::new();
        state.0.lock().unwrap().insert("studio:designer".to_string(), exited_session());

        let out = pane_liveness(vec!["studio:designer".to_string()], &state);
        assert_eq!(out.len(), 1);
        assert!(!out[0].live, "an exited child must not be reported live");
        assert!(!out[0].busy, "a dead pane cannot be busy");
        assert!(!out[0].agent, "a dead pane cannot be running an agent");
        assert!(out[0].pid.is_none(), "the stale pid must be withheld, not reported");
    }

    /// The case the fix must not cost: a session whose child is genuinely still running is still
    /// reported live, with its pid.
    #[test]
    fn a_pane_whose_child_is_running_reports_live_with_a_pid() {
        let state = PtyState::new();
        state.0.lock().unwrap().insert("studio:designer".to_string(), running_session());

        let out = pane_liveness(vec!["studio:designer".to_string()], &state);
        assert_eq!(out.len(), 1);
        assert!(out[0].live, "a running child must still be reported live");
        assert!(out[0].pid.is_some(), "and its pid is still reported");

        state.0.lock().unwrap().get_mut("studio:designer").unwrap().child.kill().ok();
    }

    /// A pane the map has never heard of is dead, not an error — same answer as before the fix.
    #[test]
    fn an_unknown_pane_reports_dead() {
        let state = PtyState::new();
        let out = pane_liveness(vec!["studio:nonexistent".to_string()], &state);
        assert_eq!(out.len(), 1);
        assert!(!out[0].live);
        assert!(out[0].pid.is_none());
    }
}

// ── the caged pane's store root (the-emitter-rc-is-written-before-its-directory-exists) ──────────
//
// The rc write used to precede the `create_dir_all` that makes its directory, so a pane's FIRST
// caged session silently got no coordination emitters at all. The second launch worked, which is
// exactly why nobody noticed. These tests run against a root that does NOT exist, because a root
// that already exists is the case that always passed.

#[cfg(test)]
mod store_root_tests {
    use super::scaffold_store_root;

    /// THE regression: a first launch, into a store root nothing has created yet.
    #[test]
    fn a_first_launch_gets_its_emitter_rc() {
        let root = crate::testutil::unique_dir("bsc-store-root", "first-launch");
        assert!(!root.exists(), "the point of the test is that nothing has created it");

        assert!(scaffold_store_root("proj:director", &root).is_some(), "the scaffold succeeds");

        assert!(
            root.join("bsc-rc").is_file(),
            "the rc must exist on the FIRST launch — namespace_argv binds it only `if rc.is_file()`, \
             so a missing one means the session has no bsc-ask / bsc-wait / completion emitters",
        );
        assert!(root.join("coord").join("out").is_dir(), "and the outbox it is written beside");

        std::fs::remove_dir_all(&root).ok();
    }

    /// The rc has to be the real one, not an empty file that satisfies `is_file()`.
    #[test]
    fn the_rc_written_is_the_emitter_rc() {
        let root = crate::testutil::unique_dir("bsc-store-root", "contents");
        scaffold_store_root("proj:worker", &root).expect("scaffold");

        let written = std::fs::read_to_string(root.join("bsc-rc")).expect("readable");
        assert_eq!(written, super::launch::sandbox_emitter_rc(), "verbatim, not a truncated write");
        assert!(!written.is_empty(), "and not empty");

        std::fs::remove_dir_all(&root).ok();
    }

    /// The plan outbox is created too, and it has to SURVIVE the projection that lands on top of
    /// it. `scaffold_store_root` runs first and makes `plan/out`; `project_stores_for` then
    /// materializes `plan/{README,schema,items/…}` into the same directory. That works only
    /// because `materialize` is additive — a `remove_dir_all` added later "for freshness" would
    /// delete the outbox, and bwrap cannot recreate it inside a read-only bind, so the session
    /// would come up unable to record anything with nothing said anywhere.
    #[test]
    fn the_plan_outbox_survives_the_projection_landing_on_top_of_it() {
        let root = crate::testutil::unique_dir("bsc-store-root", "plan-out");
        scaffold_store_root("proj:worker", &root).expect("scaffold");
        assert!(root.join("plan").join("out").is_dir(), "the mountpoint bwrap will bind");

        let items = bsc_storefs::plan::from_json(
            r#"[{"ref":"r","title":"t","status":"open","body":"b","acceptance":[],"labels":[],"dependsOn":[]}]"#,
        )
        .expect("parses");
        bsc_storefs::materialize(&root.join("plan"), &bsc_storefs::plan::project(&items, "T"))
            .expect("materialize");

        assert!(root.join("plan").join("out").is_dir(), "the outbox must survive the projection");
        assert!(root.join("plan").join("schema").is_file(), "...and the write contract lands beside it");
        assert!(root.join("plan").join("items").join("r").is_dir(), "...and so does the snapshot");

        std::fs::remove_dir_all(&root).ok();
    }

    /// A relaunch re-scaffolds the same root without failing on what is already there.
    #[test]
    fn a_relaunch_over_an_existing_root_still_succeeds() {
        let root = crate::testutil::unique_dir("bsc-store-root", "relaunch");
        scaffold_store_root("proj:director", &root).expect("first launch");
        scaffold_store_root("proj:director", &root).expect("second launch");

        assert!(root.join("bsc-rc").is_file());
        assert!(root.join("coord").join("out").is_dir());

        std::fs::remove_dir_all(&root).ok();
    }
}

// ── the cgroup ceilings (the-sandbox-limits-are-rendered-from-a-default-that-caps-nothing) ───────
//
// Every namespace launch passed `Limits::default()`, so `render_limits` emitted nothing and the
// systemd scope enforced nothing. `bsc-sandbox` already tests the RENDERING; what was missing is a
// test at the LAUNCH SITE, which is where the default was being passed.

#[cfg(all(test, target_os = "linux"))]
mod limits_tests {
    use super::{host_memory_kb, namespace_argv, session_limits, GateConfig};
    use bsc_sandbox::profile::Role;
    use crate::testutil::prelude::ENV_LOCK;

    /// THE regression: the argv a real launch renders carries the caps.
    ///
    /// Asserted through `namespace_argv` rather than through `session_limits` alone, because the
    /// bug was never in the values — it was that the launcher passed `Default::default()` and the
    /// flags never reached the scope at all.
    #[test]
    fn a_launch_renders_the_cgroup_flags() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("BSC_SANDBOX_MEMORY_MAX");
        std::env::set_var("BSC_SANDBOX_TASKS_MAX", "4096");

        let a = namespace_argv(Some("worker"), "lim", "/tmp/wt", None, "bash", &[], GateConfig::default())
            .expect("renders");

        assert!(a.iter().any(|x| x == "TasksMax=4096"), "a fork-bomb ceiling: {a:?}");
        assert!(a.iter().any(|x| x.starts_with("CPUWeight=")), "agents yield to the app: {a:?}");
        if host_memory_kb().is_some() {
            assert!(a.iter().any(|x| x.starts_with("MemoryMax=")), "a memory ceiling: {a:?}");
            assert!(
                a.iter().any(|x| x == "MemorySwapMax=0"),
                "a memory cap that can swap is not a cap: {a:?}",
            );
        }
        std::env::remove_var("BSC_SANDBOX_TASKS_MAX");
    }

    /// A worker writes code, so its work can legitimately be large; every other role is
    /// `code: none` and reviews. The worker's ceiling must be the higher of the two.
    #[test]
    fn the_role_that_writes_code_gets_the_larger_share() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("BSC_SANDBOX_MEMORY_MAX");

        let (worker, director) = (session_limits(Role::Worker), session_limits(Role::Director));
        match (worker.memory_max, director.memory_max) {
            (Some(w), Some(d)) => {
                let mb = |s: String| s.trim_end_matches('M').parse::<u64>().expect("rendered as MB");
                assert!(mb(w) > mb(d), "a worker builds; a director reviews");
            }
            // No readable host size ⇒ no cap either way, which is the documented fallback.
            (None, None) => {}
            other => panic!("the two roles must agree on whether a cap is knowable: {other:?}"),
        }
    }

    /// The override exists so a machine that disagrees does not need a rebuild — and `0` is how you
    /// turn the memory cap off, since an empty value is indistinguishable from an unset one.
    #[test]
    fn the_env_override_wins_and_zero_disables() {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        std::env::set_var("BSC_SANDBOX_MEMORY_MAX", "3G");
        assert_eq!(session_limits(Role::Worker).memory_max.as_deref(), Some("3G"));

        std::env::set_var("BSC_SANDBOX_MEMORY_MAX", "0");
        assert_eq!(session_limits(Role::Worker).memory_max, None, "0 opts out explicitly");

        std::env::remove_var("BSC_SANDBOX_MEMORY_MAX");
    }

    /// An unreadable host size must yield NO cap rather than a guessed one: `MemoryMax` renders
    /// `MemorySwapMax=0` beside it, so a cap that is too small kills a build instead of slowing it.
    #[test]
    fn an_unknown_host_size_declines_to_guess() {
        // `/proc/meminfo` is present wherever this runs, so drive the decision directly: the
        // fallback is `host_memory_kb() -> None`, and the contract is that None means no cap.
        assert!(host_memory_kb().is_some_and(|kb| kb > 0), "a Linux host reports MemTotal");
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::remove_var("BSC_SANDBOX_MEMORY_MAX");
        // With a readable size the cap IS set — the negative half is pinned by `zero disables`
        // above, which exercises the same `None` branch the unreadable case falls into.
        assert!(session_limits(Role::Worker).memory_max.is_some());
    }
}

// ── the plan outbox reaches the store (a-caged-worker-cannot-record-what-it-did) ─────────────────
//
// The pure layer is tested in `bsc-storefs`, and the cage-side write is tested by
// `the_protocols_caged_plan_writes_run_inside_the_cage_and_the_drain_accepts_them`. What neither
// covers is the JOIN: that the argv a `PlanWrite` renders is one the real `bsc plan` accepts. That
// is the seam where a plausible-looking command silently records nothing.

#[cfg(all(test, target_os = "linux"))]
mod plan_drain_tests {
    use bsc_storefs::plan::{accept_write, PlanWrite};

    fn fields(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// The `bsc` binary, for a TEST process rather than for the app.
    ///
    /// `env::bsc_bin_path` resolves relative to `current_exe()`, which under nextest is
    /// `target/<profile>/deps/<test>` — not a profile dir, so the staged-sidecar branch is skipped
    /// and the candidates are `deps/bsc`, `debug/debug/bsc`, `debug/release/bsc`, none of which
    /// exist. The first draft of this test therefore printed "no bundled bsc" and asserted nothing.
    ///
    /// So try the production resolver first, then the two places a developer's binary actually is:
    /// this workspace's own `target/<profile>/`, and the staged copy the app boots from.
    fn bsc_for_test() -> Option<std::path::PathBuf> {
        if let Some(p) = super::env::bsc_bin_path() {
            return Some(p);
        }
        let exe = if cfg!(windows) { "bsc.exe" } else { "bsc" };
        let mut cands: Vec<std::path::PathBuf> = Vec::new();
        // `target/` sits beside `src-tauri/`, whose manifest dir is where this crate is compiled.
        if let Some(root) = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            for profile in ["debug", "release"] {
                cands.push(root.join("target").join(profile).join(exe));
            }
        }
        cands.push(crate::platform::paths::bsc_base_dir().join("bin").join(exe));
        // `is_file()` is NOT enough, and this is not hypothetical: `target/<profile>/bsc` is
        // unlinked and rewritten by every `cargo build`, so between a build starting and the link
        // finishing it is a 0-byte, mode-0644 placeholder. This test picked exactly that and failed
        // with `PermissionDenied` — the same shape `stage_dev_sidecars`'s `source_is_plausible`
        // exists to refuse. Require something that could actually exec.
        cands.into_iter().find(|p| {
            std::fs::metadata(p).is_ok_and(|md| {
                #[cfg(unix)]
                let runnable = {
                    use std::os::unix::fs::PermissionsExt;
                    md.permissions().mode() & 0o111 != 0
                };
                #[cfg(not(unix))]
                let runnable = true;
                md.is_file() && md.len() > 0 && runnable
            })
        })
    }

    /// A note written through the outbox reaches the change record, verbatim.
    ///
    /// Runs the REAL binary against a REAL plan.db — the same `bsc` and the same `BSC_PLAN_DB` the
    /// drain uses — so a verb renamed or an argument reordered on either side fails here rather
    /// than in a worker's session, where the only symptom is a record that never appears.
    #[test]
    fn a_note_from_the_outbox_lands_in_the_change_record() {
        let Some(bsc) = bsc_for_test() else {
            // Saying so out loud, because a test that quietly asserts nothing is the failure mode
            // this repo keeps getting caught by.
            eprintln!("no `bsc` binary found — `npm run build:plan` builds it; nothing asserted");
            return;
        };
        let dir = crate::testutil::unique_dir("bsc-plandrain", "note");
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("plan.db");

        let run = |argv: Vec<String>| {
            std::process::Command::new(&bsc).args(&argv).env("BSC_PLAN_DB", &db).output().expect("bsc runs")
        };

        // An item to hang the change off — the same shape `bsc plan add` takes elsewhere.
        let add = std::process::Command::new(&bsc)
            .args(["plan", "add"])
            .env("BSC_PLAN_DB", &db)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .and_then(|mut c| {
                use std::io::Write;
                c.stdin.as_mut().unwrap().write_all(
                    br#"[{"ref":"caged-demo","title":"A caged demo","status":"open"}]"#,
                )?;
                c.wait_with_output()
            })
            .expect("bsc plan add runs");
        assert!(add.status.success(), "seeding the item: {}", String::from_utf8_lossy(&add.stderr));

        // Prose with the characters that make a shell dangerous — the reason it travels as argv.
        let text = "tried `cargo build`, then $(which bsc) — neither exists in the cage";
        for entry in [
            ("c", fields(&[("verb", "change"), ("ref", "caged-demo"), ("title", "Doing the thing"), ("description", "why")])),
            ("n", fields(&[("verb", "note"), ("ref", "caged-demo"), ("text", text), ("from", "worker")])),
            ("g", fields(&[("verb", "gate"), ("ref", "caged-demo"), ("gate", "typecheck"), ("result", "pass")])),
            ("s", fields(&[("verb", "status"), ("ref", "caged-demo"), ("status", "complete")])),
        ] {
            let w = accept_write(entry.0, &entry.1).expect("the outbox accepts it");
            let out = run(w.argv());
            assert!(
                out.status.success(),
                "the store must accept the argv the outbox renders — `bsc {}` failed: {}",
                w.argv().join(" "),
                String::from_utf8_lossy(&out.stderr),
            );
        }

        let rendered = String::from_utf8_lossy(&run(vec!["plan".into(), "change".into(), "render".into(), "caged-demo".into()])
            .stdout).to_string();
        assert!(rendered.contains("Doing the thing"), "the change record exists: {rendered}");
        assert!(rendered.contains(text), "the note survives byte-for-byte through argv: {rendered}");
        assert!(rendered.contains("typecheck"), "the gate evidence is recorded: {rendered}");

        let listed = String::from_utf8_lossy(&run(vec!["plan".into(), "list".into()]).stdout).to_string();
        assert!(listed.contains("complete"), "and the item moved: {listed}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The refusal is enforced where it matters. `accept_write` never produces a `verified`
    /// status, so there is no argv for the drain to run — the narrowing is structural, not a
    /// string check somewhere downstream.
    #[test]
    fn there_is_no_argv_that_marks_an_item_verified() {
        assert!(accept_write("s", &fields(&[("verb", "status"), ("ref", "r"), ("status", "verified")])).is_err());
        // ...and nothing else in the vocabulary can reach that transition either.
        for verb in bsc_storefs::plan::WRITE_VERBS {
            let f = fields(&[
                ("verb", verb), ("ref", "r"), ("text", "t"), ("title", "t"), ("description", "d"),
                ("gate", "typecheck"), ("result", "pass"), ("status", "complete"),
            ]);
            if let Ok(w) = accept_write("e", &f) {
                assert!(
                    !w.argv().iter().any(|a| a == "verified" || a == "merged"),
                    "{verb} must not be able to render a reviewer's verdict: {:?}",
                    w.argv(),
                );
            }
        }
        // A sanity check on the enum itself, so a new variant cannot quietly add one.
        assert!(matches!(
            accept_write("s", &fields(&[("verb", "status"), ("ref", "r"), ("status", "complete")])),
            Ok(PlanWrite::Status { .. }),
        ));
    }
}

// ── the defunct child is collected (a-cage-that-dies-at-launch-leaves-a-silent-zombie) ───────────
//
// A PTY reaching EOF reaps nothing: the child is a separate process, and until something waits on
// it the kernel keeps a zombie. The observed symptom was `[bwrap] <defunct>` — State Z, no cmdline,
// no children — sitting for the app's whole lifetime, findable only with `ps`.

#[cfg(all(test, unix))]
mod reap_tests {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    /// A child that has exited is COLLECTED, not left defunct.
    ///
    /// Drives a real PTY and a real child rather than mocking `try_wait`, because the whole failure
    /// is about what the kernel does with an uncollected process — which a mock cannot have.
    /// `/proc/<pid>/stat` field 3 is the state character; `Z` is the bug.
    #[test]
    fn an_exited_child_does_not_stay_a_zombie() {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/sh");
        cmd.arg("-c");
        cmd.arg("exit 7");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn");
        drop(pair.slave);
        let pid = child.process_id().expect("a pid");

        // Wait for it to actually exit — the same bounded grace `reap` uses, for the same reason:
        // EOF arrives a beat before the child is collectable.
        let mut status = None;
        for _ in 0..40 {
            if let Ok(Some(s)) = child.try_wait() {
                status = Some(s.exit_code());
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert_eq!(status, Some(7), "the child's status is readable once collected");

        // ...and having collected it, the process is GONE rather than defunct.
        let state = std::fs::read_to_string(format!("/proc/{pid}/stat"))
            .ok()
            .and_then(|s| s.rsplit_once(would_be_comm_end()).map(|(_, rest)| rest.trim().chars().next()))
            .flatten();
        assert!(
            !matches!(state, Some('Z')),
            "a collected child must not remain a zombie — got state {state:?} for pid {pid}",
        );
    }

    /// `/proc/<pid>/stat`'s second field is the command in parentheses and MAY CONTAIN SPACES or
    /// parens, so the state character is found after the LAST ')' rather than by splitting on
    /// whitespace. Naming it here rather than inlining a bare `")"` so the reason travels with it.
    fn would_be_comm_end() -> &'static str {
        ")"
    }
}

// ── the designer's surface actually exists (complete-the-caged-designer-surface) ─────────────────
//
// Three gaps, and only two were in the item. `/ui` projected no source, so a caged designer could
// not READ what it was asked to edit. `/ui/out` had a bind entry, a tested pure drain, and no
// caller — so a write went into a directory nothing read. And the outbox directory was never
// created, so `namespace_argv` skipped the bind entirely: a real launch logged `1 outbox(es)`, and
// that one was coord.

#[cfg(all(test, target_os = "linux"))]
mod designer_surface_tests {
    use super::{namespace_argv, scaffold_store_root, GateConfig};

    /// THE bind that never happened. An outbox is bound only if its host directory exists, and
    /// nothing created this one.
    #[test]
    fn the_component_outbox_is_created_and_therefore_bound() {
        let root = crate::testutil::unique_dir("bsc-designer", "outbox");
        scaffold_store_root("studio:designer", &root).expect("scaffold");
        assert!(root.join("ui").join("out").is_dir(), "the mountpoint bwrap will bind");

        // The projection lands on top of it, exactly as /plan/out's does.
        let comps = bsc_storefs::ui::from_json(
            r#"[{"id":"card","name":"Card","role":"composite","folder":"shared/ui","kitId":"k","srcText":"export const Card = () => null;"}]"#,
        )
        .expect("parses");
        bsc_storefs::materialize(&root.join("ui"), &bsc_storefs::ui::project(&comps, "T"))
            .expect("materialize");
        assert!(root.join("ui").join("out").is_dir(), "and survives the projection");

        let argv = namespace_argv(
            Some("worker"), "d", "/tmp/wt", Some(root.to_str().unwrap()), "bash", &[], GateConfig::default(),
        )
        .expect("renders");
        let host = root.join("ui").join("out").to_string_lossy().to_string();
        assert!(
            argv.windows(3).any(|w| w[0] == "--bind" && w[1] == host && w[2] == "/ui/out"),
            "the component outbox must be bound READ-WRITE at /ui/out: {argv:?}",
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// The spec's own caged commands, EXECUTED in a real cage against a real projection.
    ///
    /// The same guarantee the worker protocol gets: what the document tells a session to run has to
    /// run there. The designer's spec was the counter-example — it taught `bsc ui`, the cage has no
    /// `bsc`, and every caged designer session died on its first instructed command.
    #[test]
    fn the_designer_specs_caged_commands_run_inside_the_cage() {
        if std::process::Command::new("bwrap").arg("--version").output().is_err() {
            panic!("bubblewrap is required for the namespace launch path — install it");
        }
        let cfg = std::env::temp_dir().join(format!("bsc-dsgncfg-{}", std::process::id()));
        std::fs::create_dir_all(&cfg).unwrap();
        let md = crate::platform::config::with_config_root(&cfg, || {
            crate::platform::config::load_str("designer/claude.md")
        });
        let _ = std::fs::remove_dir_all(&cfg);

        let block = md
            .split_once("<!-- caged-designer-commands -->")
            .and_then(|(_, r)| r.split_once("<!-- /caged-designer-commands -->"))
            .map(|(b, _)| b.to_string())
            .expect("the spec carries a caged-designer-commands block");
        let cmds: Vec<String> = block
            .lines()
            .map(str::trim)
            .filter(|l| l.starts_with("ls ") || l.starts_with("cat "))
            .map(|l| l.split('#').next().unwrap_or(l).trim().replace("<id>", "card"))
            .collect();
        assert!(!cmds.is_empty(), "the block must contain runnable commands: {block}");

        let base = std::env::temp_dir().join(format!("bsc-dsgnrun-{}", std::process::id()));
        let wt = base.join("wt");
        let stores = base.join("stores");
        std::fs::create_dir_all(&wt).unwrap();
        let comps = bsc_storefs::ui::from_json(
            r#"[{"id":"card","name":"Card","role":"composite","folder":"shared/ui","kitId":"k","srcText":"export const Card = () => null;"}]"#,
        )
        .expect("parses");
        bsc_storefs::materialize(&stores.join("ui"), &bsc_storefs::ui::project(&comps, "T"))
            .expect("materialize ui");
        std::fs::create_dir_all(stores.join("ui").join("out")).unwrap();

        let argv = namespace_argv(
            Some("worker"), "dsgn", wt.to_str().unwrap(),
            Some(stores.to_str().unwrap()), "/bin/sh", &[], GateConfig::default(),
        )
        .expect("renders");
        let sep = argv.iter().rposition(|x| x == "--").unwrap();

        // Every read command runs, AND the write path the spec teaches is actually writable.
        let script = format!(
            "command -v bsc >/dev/null && echo BSC-PRESENT; {}; \
             mkdir -p /ui/out/mycard && echo x > /ui/out/mycard/srcText || echo \"FAILED: author\"",
            cmds.iter()
                .map(|c| format!("{c} >/dev/null 2>&1 || echo \"FAILED: {c}\""))
                .collect::<Vec<_>>()
                .join("; ")
        );
        let mut cmd = std::process::Command::new(&argv[0]);
        cmd.args(&argv[1..=sep]);
        cmd.args(["/usr/bin/sh", "-c", &script]);
        let out = cmd.output().expect("executes");
        let text = String::from_utf8_lossy(&out.stdout).to_string();
        let authored = stores.join("ui").join("out").join("mycard").join("srcText").is_file();
        let _ = std::fs::remove_dir_all(&base);

        assert!(!text.contains("BSC-PRESENT"), "the caged block is written for a cage WITHOUT bsc: {text:?}");
        assert!(
            !text.contains("FAILED:"),
            "every command the spec gives a caged designer must run there — {text:?} / {}",
            String::from_utf8_lossy(&out.stderr),
        );
        assert!(authored, "and the authored component must land on the HOST side of /ui/out");
    }

    /// The SOURCE tier. Without it a caged designer can see that a component exists and cannot read
    /// the thing it was asked to edit — which is why the designer had to be let out of its cage.
    #[test]
    fn a_components_source_is_readable_from_the_projection() {
        let src = "export const Card = () => <div>{`a ${tricky} one`}</div>;";
        let comps = bsc_storefs::ui::from_json(&format!(
            r#"[{{"id":"card","name":"Card","role":"composite","folder":"shared/ui","kitId":"k","srcText":{}}}]"#,
            serde_json::to_string(src).unwrap(),
        ))
        .expect("parses");
        let tree = bsc_storefs::ui::project(&comps, "T");

        assert_eq!(
            tree.get("components/card/srcText").map(String::as_str),
            Some(src),
            "byte-for-byte, backticks and ${{…}} included — it is TSX, and those are content",
        );
        assert!(
            tree["README"].contains("srcText"),
            "and the README says the tier is here: {}",
            tree["README"],
        );
    }

    /// A SUMMARY read must still say plainly that there is no source, rather than leaving a reader
    /// to conclude the component has none.
    #[test]
    fn a_summary_projection_says_it_carries_no_source() {
        let comps = bsc_storefs::ui::from_json(
            r#"[{"id":"card","name":"Card","role":"composite","folder":"shared/ui","kitId":"k"}]"#,
        )
        .expect("parses");
        let tree = bsc_storefs::ui::project(&comps, "T");

        assert!(!tree.contains_key("components/card/srcText"));
        assert!(
            tree["README"].contains("NOT projected"),
            "the absence has to be stated, not inferred: {}",
            tree["README"],
        );
    }
}

/// A caged session must resume from ITS OWN transcripts, not from a host path it never writes to.
#[cfg(all(test, target_os = "linux"))]
mod caged_resume_tests {
    use super::*;

    #[test]
    fn an_uncaged_launch_still_asks_the_host() {
        // `None` is what routes the caller back to `detect_history(&cwd)` — the host rule, unchanged.
        assert_eq!(caged_history_dir(Some("/stores/pane"), false), None, "not caged ⇒ host lookup");
        assert_eq!(caged_history_dir(None, true), None, "no stores root ⇒ nothing to look in");
        assert_eq!(caged_history_dir(Some(""), true), None, "an empty root is not a root");
    }

    /// The directory the CAGED harness actually writes to: `<stores_root>/home/projects/<slug(/repo)>`.
    /// The slug is fixed because the guest cwd is fixed — it is never derived from the host path, which
    /// is exactly why the host lookup could not find it.
    #[test]
    fn a_caged_launch_points_at_the_bound_transcripts_dir() {
        let dir = caged_history_dir(Some("/stores/pane"), true).expect("caged ⇒ a path");
        assert_eq!(dir, std::path::Path::new("/stores/pane/home/projects/-repo"));
        // …and it agrees with where `history_dir_for` BINDS, or the resume would read a different
        // directory from the one the harness writes into.
        let bound = std::path::Path::new("/stores/pane").join("home").join("projects");
        assert!(dir.starts_with(&bound), "{dir:?} must sit inside the bound dir {bound:?}");
    }

    /// The rule itself — a `.jsonl` present means there is something to continue.
    #[test]
    fn a_transcript_in_the_caged_dir_is_what_makes_it_resumable() {
        let root = std::env::temp_dir().join(format!("bsc-caged-hist-{}", std::process::id()));
        let dir = root.join("home").join("projects").join("-repo");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let resolved = caged_history_dir(Some(&root.to_string_lossy()), true).expect("caged");
        assert_eq!(resolved, dir);

        assert!(
            !crate::session::launch::dir_holds_a_transcript(&resolved),
            "an empty cage has nothing to continue — it must start fresh so the kickoff is delivered",
        );
        std::fs::write(dir.join("a-session.jsonl"), "{}\n").expect("write");
        assert!(
            crate::session::launch::dir_holds_a_transcript(&resolved),
            "with a transcript present the caged launch must resume instead of starting over",
        );
        // A non-transcript file is not a conversation.
        let other = root.join("home").join("projects").join("-repo-2");
        std::fs::create_dir_all(&other).expect("mkdir2");
        std::fs::write(other.join("notes.txt"), "x").expect("write2");
        assert!(!crate::session::launch::dir_holds_a_transcript(&other));
        let _ = std::fs::remove_dir_all(&root);
    }
}

/// A caged worker must be able to use git — the tree alone is not a repository.
#[cfg(all(test, target_os = "linux"))]
mod caged_git_tests {
    use super::*;

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-cagedgit-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("mkdir");
        d
    }

    #[test]
    fn an_ordinary_clone_needs_no_extra_bind() {
        let root = tmp("clone");
        std::fs::create_dir_all(root.join("repo").join(".git")).expect("mkdir .git");
        assert_eq!(
            git_common_dir_for(&root.join("repo").to_string_lossy()),
            None,
            "a real .git DIRECTORY rides along inside the tree bind",
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The shape that actually broke: `.git` is a FILE pointing at the parent clone.
    #[test]
    fn a_worktree_resolves_the_shared_git_dir_through_commondir() {
        let root = tmp("wt");
        let common = root.join("clone").join(".git");
        let gitdir = common.join("worktrees").join("w1");
        std::fs::create_dir_all(&gitdir).expect("mkdir gitdir");
        // git writes `commondir` relative to the gitdir.
        std::fs::write(gitdir.join("commondir"), "../..\n").expect("commondir");
        let wt = root.join("w1");
        std::fs::create_dir_all(&wt).expect("mkdir wt");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).expect(".git");

        let got = git_common_dir_for(&wt.to_string_lossy()).expect("a worktree needs the shared dir");
        assert_eq!(
            std::fs::canonicalize(&got).unwrap(),
            std::fs::canonicalize(&common).unwrap(),
            "it must resolve to the parent clone's .git, where the objects live",
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// No `commondir` (older layout) ⇒ two levels up from the gitdir.
    #[test]
    fn a_worktree_without_commondir_falls_back_to_two_levels_up() {
        let root = tmp("nocommon");
        let common = root.join("clone").join(".git");
        let gitdir = common.join("worktrees").join("w1");
        std::fs::create_dir_all(&gitdir).expect("mkdir");
        let wt = root.join("w1");
        std::fs::create_dir_all(&wt).expect("mkdir wt");
        std::fs::write(wt.join(".git"), format!("gitdir: {}\n", gitdir.display())).expect(".git");
        let got = git_common_dir_for(&wt.to_string_lossy()).expect("still resolvable");
        assert_eq!(std::fs::canonicalize(&got).unwrap(), std::fs::canonicalize(&common).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A DANGLING pointer degrades to today's behaviour rather than taking the launch down: bwrap
    /// fails the whole session if a bind source is missing, and a broken git beats no session at all.
    #[test]
    fn a_missing_target_binds_nothing_rather_than_failing_the_launch() {
        let root = tmp("dangle");
        let wt = root.join("w1");
        std::fs::create_dir_all(&wt).expect("mkdir");
        std::fs::write(wt.join(".git"), "gitdir: /nowhere/at/all/.git/worktrees/w1\n").expect(".git");
        assert_eq!(git_common_dir_for(&wt.to_string_lossy()), None);
        assert_eq!(git_common_dir_for(""), None, "no cwd, nothing to resolve");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The bind itself: at its OWN path, read-write, because the pointer git reads is absolute and
    /// committing writes objects and refs back into it.
    #[test]
    fn the_shared_git_dir_is_bound_at_its_own_path_and_writable() {
        use bsc_sandbox::profile::{for_role, Role, SessionPaths};
        use bsc_sandbox::{Limits, Scope};
        let git = std::path::PathBuf::from("/host/clone/.git");
        let paths = SessionPaths {
            root: std::path::PathBuf::from("/host/wt/repo--stream"),
            git_common_dir: Some(git.clone()),
            ..Default::default()
        };
        let a = for_role(Role::Worker, "u", &paths, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .unwrap()
            .spec
            .render()
            .unwrap();
        let i = a
            .windows(3)
            .position(|w| w[0] == "--bind" && w[1] == git.to_string_lossy() && w[2] == git.to_string_lossy())
            .expect("the shared git dir must be bound at its own path, read-write");
        // …and it must not ALSO appear read-only, which would refuse every commit.
        let _ = i;
        assert!(
            !a.windows(3).any(|w| w[0] == "--ro-bind" && w[1] == git.to_string_lossy()),
            "read-only would refuse every commit: {a:?}",
        );
    }

    #[test]
    fn no_git_dir_means_no_such_bind() {
        use bsc_sandbox::profile::{for_role, Role, SessionPaths};
        use bsc_sandbox::{Limits, Scope};
        let paths = SessionPaths { root: std::path::PathBuf::from("/host/wt/r"), ..Default::default() };
        let a = for_role(Role::Worker, "u", &paths, &[], Limits::default(), Scope::User, vec!["bash".into()])
            .unwrap().spec.render().unwrap();
        assert!(!a.iter().any(|x| x.ends_with("/.git")), "nothing to bind: {a:?}");
    }
}
