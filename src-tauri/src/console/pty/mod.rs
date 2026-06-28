// PTY session lifecycle: state registry, the pty_* commands, the session env
// (`wire_bsc_env` + the bsc-* sidecar resolvers), the reader/emitter IO pump,
// and the mobile-tunnel bridge (extracted from lib.rs, #758). The process-tree
// kill primitive (`PtyJob`) lives in the `job` submodule (#1660).

use crate::{
    bsc_base_dir, to_bash_path, to_native_path, nearest_existing_ancestor, split_utf8_at_boundary,
};
use crate::console::shell_rc::bsc_rc_body;
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
    crate::pty_ledger::forget_all_owned();
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

/// The per-project session skill group id for a pane, or None for non-planner panes (#1419). Only
/// the planner pane (`planning_<key>`) authors session skills, so only it gets `BSC_SESSION_SKILL_GROUP`
/// — workers/director/manual panes don't. The id is deterministic from the (already-sanitized) key so
/// the Planning pane and the `bsc-skill` CLI resolve the same group. Pure for testing.
pub(crate) fn session_skill_group_for_pane(pane_id: &str) -> Option<String> {
    pane_id.strip_prefix("planning_").map(|key| format!("grp-session-{key}"))
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
        crate::pty_ledger::forget_pane(&pane_id);
        // Dropping `session` runs the Job Object / pgid teardown, terminating the whole tree.
    }
    if n > 0 {
        log::info!("killed {n} live PTY session(s) for project {key:?} before delete");
    }
    n
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

/// The project's per-project DuckDB **data store** (`~/.base-studio-code/data/<key>.duckdb`) for a
/// session under a project hub — the Data Model + PlatformScan the planner reads via `bsc-data`
/// (#1446). Same key derivation as [`plan_db_for_cwd`]; None for a non-project session.
fn data_db_for_cwd(cwd: &str) -> Option<std::path::PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    let projects_root = bsc_base_dir().join("projects");
    let rel = std::path::Path::new(cwd).strip_prefix(&projects_root).ok()?;
    let key = rel.components().next()?.as_os_str().to_string_lossy().into_owned();
    Some(bsc_base_dir().join("data").join(format!("{key}.duckdb")))
}

/// The absolute path of a bundled `bsc-*` sidecar binary (CLI or MCP server) named `stem` — the
/// binary sitting beside the running app exe (the cargo target dir in dev; a bundled sidecar in a
/// release), or None if it isn't there. `stem` is the bare name without the platform extension
/// (`.exe` is appended on Windows). Sessions get the resolved paths as `$BSC_*_BIN` env vars for the
/// shell helpers to exec — no PATH change; the two MCP servers are rewritten into `.mcp.json`
/// (which Claude Code spawns directly, no shell-rc) via the `pub(crate)` wrappers below.
fn sidecar_bin_path(stem: &str) -> Option<std::path::PathBuf> {
    let exe = if cfg!(windows) { format!("{stem}.exe") } else { stem.to_string() };
    let p = std::env::current_exe().ok()?.with_file_name(exe);
    p.exists().then_some(p)
}

/// The absolute path of the bundled `bsc-research-mcp` server (#1196), or None if absent. Used by
/// `extensions/mcp.rs` to rewrite the Research server's `.mcp.json` command to the real binary path,
/// since Claude Code spawns `.mcp.json` commands directly (no PATH/shell-rc), unlike the
/// `$BSC_*_BIN` shell helpers. Thin wrapper over [`sidecar_bin_path`].
pub(crate) fn bsc_research_mcp_bin_path() -> Option<std::path::PathBuf> {
    sidecar_bin_path(bsc_util::RESEARCH_MCP)
}

/// The absolute path of the bundled `bsc-compliance-mcp` server (#1005), or None if absent. Used by
/// `extensions/mcp.rs` to rewrite the built-in Compliance server's `.mcp.json` command to the real
/// binary path, like [`bsc_research_mcp_bin_path`]. Thin wrapper over [`sidecar_bin_path`].
pub(crate) fn bsc_compliance_mcp_bin_path() -> Option<std::path::PathBuf> {
    sidecar_bin_path(bsc_util::COMPLIANCE_MCP)
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

/// Wire the per-session `BSC_*` environment the `bsc-*` shell helpers read into `cmd`, and write the
/// rc file that defines them. Covers: the triage checkpoint doc, the `BASH_ENV` rc (which installs the
/// helpers into the agent's non-interactive `bash -c` subshells), the app-wide analytics logs
/// (audit / skill / hook / mcp / tokens / activity / done / coord), the FS-confinement repo root,
/// the per-project plan + data stores and their CLIs, the global skills store + CLI, the planner's
/// per-project session skill group, and the `bsc-agent` sidecar + per-cwd session file. `cwd` is the
/// already-native session cwd; `pane_id` tags the logs; `provider_id` gates the bsc-agent vars.
///
/// Returns the bash-style path of the rc file so the caller can `source` it into the interactive
/// shell too (BASH_ENV only covers non-interactive subshells).
fn wire_bsc_env(
    cmd: &mut CommandBuilder,
    pane_id: &str,
    cwd: &str,
    checkpoint_doc: Option<&str>,
    provider_id: Option<&str>,
) -> String {
    // Install the bsc-* shell helpers via an rc file pointed to by BASH_ENV (so the
    // agent's non-interactive `bash -c` subshells get them) and sourced into the
    // interactive shell by the caller. The rc is universal — bsc-checkpoint (triage) and
    // bsc-note / bsc-blocked (fleet assume-and-log) cost nothing in sessions that
    // don't use them. Per-session doc paths the helpers read are exposed as env
    // vars when applicable; bsc-note/bsc-blocked default to a DECISIONS.md in cwd.
    let base = bsc_base_dir();
    let _ = std::fs::create_dir_all(&base);
    // Expose the triage checkpoint doc (resolved to an absolute, bash-style path) so the
    // `bsc-checkpoint` helper can write "where we left off" to it. The helper itself is installed via
    // the rc below; it must be reachable from the agent's OWN bash subprocesses (Claude's Bash tool
    // runs a non-interactive `bash -c`, which sources BASH_ENV at startup), and the hyphenated name
    // can't be `export -f`'d (bash won't import non-identifier function names).
    if let Some(rel) = checkpoint_doc.filter(|s| !s.is_empty()) {
        let abs = base.join(rel);
        cmd.env("BSC_CHECKPOINT_DOC", to_bash_path(&abs.to_string_lossy()));
    }
    let rc = base.join("bsc-env.sh");
    let _ = std::fs::write(&rc, bsc_rc_body());
    let rc_bash = to_bash_path(&rc.to_string_lossy());
    cmd.env("BASH_ENV", &rc_bash);
    // Shared package-manager caches/stores so the fleet's per-repo worktrees don't each keep a full
    // copy of node_modules / target/ (#worktree-disk). App-native, every package manager; NATIVE OS
    // paths (read by cargo/npm/etc., not the bash shell). A no-op for non-worktree sessions.
    for (k, v) in crate::platform::pkgcache::package_cache_env(&base, cwd) {
        cmd.env(k, v);
    }
    // Observability log streams (#1847): every per-pane TSV a `bsc-*` hook appends to is a row in the
    // canonical `bsc_util::LOG_STREAMS` registry — the ONE list shared with the unified `bsc-logs`
    // reader (`crates/logs`); each row's doc comment is the stream's spec (which hook writes it + the
    // line shape). Point each `$BSC_*_LOG` at the app-wide file under `base`; setting them for every
    // pane is harmless (only a pane whose settings.json installs the hook actually writes). `pane_id`
    // is the id every line is tagged with (via `$BSC_AUDIT_PANE`).
    cmd.env("BSC_AUDIT_PANE", pane_id);
    for s in bsc_util::LOG_STREAMS {
        cmd.env(s.env_var, to_bash_path(&base.join(s.filename).to_string_lossy()));
    }
    // bsc-logs (#1716): point every session at the log directory the unified `bsc-logs` query CLI
    // reads (the `logs::log_dir` resolver honors $BSC_LOG_DIR, else `~/.base-studio-code`). It's the
    // same `base` dir that holds all the *_LOG TSVs above + `perf.db`, so a live agent can drill into
    // its own audit/coord/tokens/perf streams from its own shell. Set for every pane (read-only).
    cmd.env("BSC_LOG_DIR", to_bash_path(&base.to_string_lossy()));
    // FS confinement (#158): the session's repo root (bash-style), against which the
    // `bsc-confine` hook (installed on gated panes) checks file-tool paths. The cwd is
    // the repo root. Set for every pane; only gated panes install the hook.
    if !cwd.is_empty() {
        cmd.env("BSC_REPO_ROOT", to_bash_path(cwd));
    }
    // bsc-plan (#plan-db): point this session at its project's canonical plan store. Both vars feed
    // the `bsc-plan` shell helper (installed via the rc above, like every other bsc-*): $BSC_PLAN_DB
    // is the plan.db it reads/writes, $BSC_PLAN_BIN the absolute path of the CLI it execs — no PATH
    // changes, no copies. The DB is derived from the cwd — every project session runs under
    // `~/.base-studio-code/projects/<key>/...` (the director/planner at the hub, workers in a
    // worktree beneath it) — so the whole fleet shares one plan.db. Non-project sessions (a plain
    // console in some repo) get no BSC_PLAN_DB and never call bsc-plan.
    if let Some(db) = plan_db_for_cwd(cwd) {
        cmd.env("BSC_PLAN_DB", to_bash_path(&db.to_string_lossy()));
    }
    // bsc-skill (#1338, B-global): point EVERY session at the one GLOBAL skills.db so a group
    // authored anywhere is reachable + resolvable from any live session's own shell. $BSC_SKILL_DB
    // is the shared store the `bsc-skill` helper reads/writes; $BSC_SKILL_BIN the CLI it execs when
    // invoked with a subcommand (a no-arg fire stays the #406 telemetry hook). Unlike BSC_PLAN_DB
    // (per-project, cwd-derived), this is global — set unconditionally for every pane.
    cmd.env("BSC_SKILL_DB", to_bash_path(&base.join("skills.db").to_string_lossy()));
    // bsc-data (#1446): the project's per-project DuckDB data store — the canonical Data Model +
    // PlatformScan the planner reads at the UI-kickoff stage via the `bsc-data` CLI. $BSC_DATA_DB is
    // the project's .duckdb (cwd-derived, like BSC_PLAN_DB); $BSC_DATA_BIN the CLI the shell helper execs.
    if let Some(db) = data_db_for_cwd(cwd) {
        cmd.env("BSC_DATA_DB", to_bash_path(&db.to_string_lossy()));
    }
    // bsc-compliance (#1718): point every session at the GLOBAL compliance standards store + its CLI.
    // $BSC_COMPLIANCE_STORE is the store.db the `bsc-compliance` helper reads/writes (and which the
    // bundled `bsc-compliance-mcp` server reads — same `Store::default_path` default), $BSC_COMPLIANCE_BIN
    // the absolute path of the CLI it execs. Unlike BSC_PLAN_DB (per-project, cwd-derived), the corpus is
    // global — set unconditionally for every pane (like bsc-skill's skills.db), so any live session can
    // inspect/refresh the standards from its own shell.
    cmd.env(
        "BSC_COMPLIANCE_STORE",
        to_bash_path(&base.join("compliance").join("store.db").to_string_lossy()),
    );
    // Sidecar CLI binaries: every bsc-* shell helper execs its sidecar via $BSC_*_BIN — the absolute,
    // bash-style path of the bundled CLI (no PATH changes, no copies; the helper falls back to a PATH
    // lookup when its BIN is unset, e.g. in the test target where the sidecar isn't present). The export
    // is byte-identical per CLI, so it's driven by the shared `bsc_util::SIDECARS` registry (#1843) —
    // the ONE sidecar list. The per-CLI store/db vars above stay separate: they
    // are heterogeneous (cwd-derived Option vs global unconditional vs none, like bsc-logs' BSC_LOG_DIR
    // and bsc-blueprint/bsc-project which need no store-dir env), so they do NOT belong in this loop.
    for s in bsc_util::SIDECARS {
        if let Some(bin) = sidecar_bin_path(s.name) {
            cmd.env(s.bin_env, to_bash_path(&bin.to_string_lossy()));
        }
    }
    // The planner's per-project session skill group (#1419): only the planner pane (`planning_<key>`)
    // gets it. Skills the planner authors with `bsc-skill add --group "$BSC_SESSION_SKILL_GROUP"` join
    // this group, which the Planning pane resolves + highlights as "authored this session". The id is
    // deterministic from the (already-sanitized) key so the pane and the CLI agree; the app names the
    // group after the project. Persistent — reopening the planner keeps collecting into it.
    if let Some(group) = session_skill_group_for_pane(pane_id) {
        cmd.env("BSC_SESSION_SKILL_GROUP", group);
    }
    // bsc-agent resume (#1144): hand the sidecar the per-cwd conversation file so it persists the
    // conversation (and, with --continue, resumes it). The app owns the keying; the sidecar just
    // reads/writes this native path via std::fs. Only meaningful for bsc-agent panes.
    if provider_id == Some("bsc-agent") {
        // Hand the runtime the SAME real bash the session shell uses (Git Bash on Windows), so its
        // `bash` tool never falls through to `Command::new("bash")` → the WSL launcher
        // (System32\bash.exe), which fails `execvpe(/bin/bash)` with no WSL distro. `resolve_shell`
        // already locates Git Bash and avoids that stub.
        cmd.env("BSC_AGENT_BASH", crate::shell::resolve_shell());
        if let Some(p) = crate::bsc_agent_session_path(cwd) {
            cmd.env("BSC_AGENT_SESSION", p.to_string_lossy().into_owned());
        }
    }
    rc_bash
}

/// Reader thread: decode PTY bytes and forward complete UTF-8 chunks over `tx`. The `leftover` buffer
/// holds any trailing incomplete multi-byte sequence (e.g. ✓, →, box-drawing) so we never split a
/// character across reads. Exits on EOF/error or when the emitter is gone; flushes any tail first so
/// `tx` dropping signals the emitter (Disconnected) to finish.
fn spawn_reader(
    pane_id: String,
    mut reader: Box<dyn Read + Send>,
    tx: std::sync::mpsc::Sender<String>,
) {
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 8192];
        let mut leftover: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => { log::info!("pty[{pane_id}] reader EOF"); break; }
                Err(e) => { log::warn!("pty[{pane_id}] reader error: {e}"); break; }
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
}

/// Emitter thread: batch reader chunks and emit at most once per ~16ms frame to the frontend (and tee
/// to the mobile tunnel when paired). Coalescing collapses per-read emits — the dominant UI-lag source
/// when many sessions stream at once — into one event per frame per session. Emits `pty_exit_<pane>`
/// when the reader's `tx` disconnects.
fn spawn_emitter(
    pane_id: String,
    app: AppHandle,
    rx: std::sync::mpsc::Receiver<String>,
) {
    std::thread::spawn(move || {
        use std::sync::mpsc::RecvTimeoutError;
        use std::time::{Duration, Instant};
        const FLUSH: Duration = Duration::from_millis(16);
        const MAX_PENDING: usize = 64 * 1024;
        let evt = format!("pty_data_{}", pane_id);
        // Tee PTY output to the mobile tunnel (#242) when a client is connected.
        // Looked up once; `broadcast_output` is a no-op while nobody is paired.
        let tunnel_state = app.try_state::<tunnel::TunnelState>();
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
                    ts.broadcast_output(&pane_id, &data);
                }
                let _ = app.emit(&evt, data);
                win_emits += 1;
                last_emit = Instant::now();
            }
            let secs = win_start.elapsed().as_secs_f64();
            if secs >= 2.0 {
                let eps = win_emits as f64 / secs;
                let bps = win_bytes as f64 / secs;
                if eps > 60.0 || bps > 128_000.0 {
                    log::warn!("pty[{pane_id}] high output: {eps:.0} emits/s, {bps:.0} B/s");
                }
                win_start = Instant::now();
                win_bytes = 0;
                win_emits = 0;
            }
        }
        let _ = app.emit(&format!("pty_exit_{}", pane_id), ());
        log::info!("pty[{pane_id}] session ended ({total} bytes)");
    });
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
    // #1819: an EMPTY cwd is as dangerous as a missing one — with no cwd set the shell inherits the
    // APP's working directory, so the session's per-cwd settings.json (role gate + shell allowlist)
    // was never written there and a claude launch runs permission-less. We can't manufacture a dir,
    // but flag it loudly here (and again, claude-specifically, once the launch plan is resolved).
    if cwd.is_empty() {
        log::warn!("pty[{pane_id}] launched with an EMPTY cwd — no per-session settings.json was written; the shell inherits the app's working directory (#1819)");
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
    // Wire every per-session BSC_* env var the bsc-* shell helpers read (checkpoint doc, the
    // BASH_ENV rc, the analytics logs, the plan/skill/data stores + their CLIs, the planner skill
    // group, and the bsc-agent sidecar/session). Returns the bash-style rc path so the interactive
    // shell below can source the same helpers.
    let rc_bash = wire_bsc_env(&mut cmd, &pane_id, &cwd, checkpoint_doc.as_deref(), provider_id.as_deref());

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

    #[test]
    fn session_skill_group_only_for_the_planner_pane() {
        // #1419: only the planner pane carries the per-project session skill group; the id is
        // deterministic from the key so the pane + the bsc-skill CLI agree.
        assert_eq!(
            super::session_skill_group_for_pane("planning_acme-crm"),
            Some("grp-session-acme-crm".to_string()),
        );
        // Workers/director/triage/manual panes get nothing.
        for miss in ["acme-crm:director", "acme-crm:auth-ui", "acme-crm:own/web:triage", "man:t0:p1", "acme-crm"] {
            assert_eq!(super::session_skill_group_for_pane(miss), None, "{miss} must not get a session group");
        }
    }

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
    use std::collections::HashMap;

    // The PtyJob process-tree-kill tests (`pty_job_drop_kills_assigned_process` /
    // `pty_job_drop_kills_process_group`) live with the type they exercise, in `job.rs`.

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
    fn wire_bsc_env_exports_the_log_dir_for_bsc_logs() {
        // #1716: every session must be able to query its own log streams + perf.db via the unified
        // `bsc-logs` CLI, which reads $BSC_LOG_DIR. wire_bsc_env stages it for every pane (the same
        // base dir that holds the *_LOG TSVs). The sidecar binary isn't present in the test target,
        // so BSC_LOGS_BIN is only set when staged — BSC_LOG_DIR is the unconditional contract.
        use super::CommandBuilder;
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", "", None, None);
        assert!(cmd.get_env("BSC_LOG_DIR").is_some(), "BSC_LOG_DIR must be exported for bsc-logs");
    }

    #[test]
    fn wire_bsc_env_exports_every_registry_log_stream() {
        // #1847: the pty writer stages every `bsc_util::LOG_STREAMS` row's $BSC_*_LOG — the same
        // registry the unified `bsc-logs` reader resolves filenames from — so the writer + reader
        // can't drift on the stream set. Plus the pane tag every line carries.
        use super::CommandBuilder;
        let mut cmd = CommandBuilder::new("bash");
        let _ = super::wire_bsc_env(&mut cmd, "t0p1", "", None, None);
        for s in bsc_util::LOG_STREAMS {
            assert!(cmd.get_env(s.env_var).is_some(), "{} ({}) must be exported", s.key, s.env_var);
        }
        assert!(cmd.get_env("BSC_AUDIT_PANE").is_some(), "the pane tag must be exported");
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

