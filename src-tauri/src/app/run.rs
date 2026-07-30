use crate::prelude::*;
// Domain modules whose Tauri commands the invoke handler below registers (#1918): explicit per-domain
// imports replace the old `use crate::*` glob, so each command path names its domain.
use crate::{app, extensions, fleet, planner, session};
use crate::console::{bsc, discovery, ledger, pty};
use crate::github::{self, git_hooks, oauth};
use crate::mobile::tunnel;
use crate::observability::{self, collector, graph_log, logs, perf, tokens};
use crate::platform::docstore;
use crate::project;
use crate::sources::{credentials, data, oauth as source_oauth};
use tauri::{Manager, RunEvent};

pub(crate) fn level_color(level: log::Level) -> &'static str {
    match level {
        log::Level::Error => "\x1b[31m", // red
        log::Level::Warn  => "\x1b[33m", // yellow
        log::Level::Info  => "\x1b[32m", // green
        log::Level::Debug => "\x1b[36m", // cyan
        log::Level::Trace => "\x1b[90m", // bright black
    }
}
pub fn run() {
    // rustls 0.23 can't auto-determine a CryptoProvider from features at runtime, so
    // the relay dial's TLS handshake (tokio-tungstenite) would panic the tunnel thread
    // ("could not automatically determine the process-level CryptoProvider"). Install
    // `ring` explicitly before any TLS; Err just means one is already installed.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Startup timing (#perf): wall clock from here to `setup` ≈ native + plugin init, before the
    // WebView even loads our page. The frontend logs the doc→paint portion separately.
    let boot_start = std::time::Instant::now();

    // Crash recovery (#1041): if the session-lock marker SURVIVED the last run, the previous
    // shutdown was unclean (the Exit handler never ran to delete it). Read it BEFORE re-writing, then
    // claim the lock for this run. Existence is the signal; the pid is just for debugging.
    let unclean_shutdown = claim_session_lock(&session_lock_path());
    if unclean_shutdown {
        log::warn!("[startup] previous shutdown was UNCLEAN (session-lock survived) — offering session restore");
    }

    // Reap PTY children leaked by a prior run that never reached RunEvent::Exit (#1049). The ledger is
    // authoritative about what THIS app spawned, so this only ever kills our own orphans (owner gone +
    // same process) — never the user's terminals. Runs before any session launches.
    let reaped = ledger::reconcile_on_boot();
    if reaped > 0 {
        log::warn!("[startup] reaped {reaped} orphaned PTY child process(es) from a prior unclean run");
    }

    let mut builder = tauri::Builder::default();
    // Single-instance guard (#1303): a duplicate launch focuses the running window instead of
    // spawning a second process (which owns its own PtyState and can't see the live sessions, and
    // would race over the same on-disk hubs). The plugin MUST be registered first. Bypass with
    // BSC_ALLOW_MULTIPLE_INSTANCES=1 to run two dev builds side by side.
    if super::single_instance::guard_enforced() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            super::single_instance::focus_main(app);
        }));
    }
    // The runtime log-scope graph (#1389): the custom dual-sink `GraphLogger` replaces
    // `tauri-plugin-log`. The scope registry is created here so it can be BOTH managed state (for the
    // Tauri commands) and captured by the logger installed in `setup` (which needs the app handle to
    // resolve the log-dir file path). It loads the persisted `log-scopes.json` (or the defaults).
    let scope_registry = graph_log::ScopeRegistry::new(graph_log::scope_config_path());

    builder
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .manage(crate::console::pty::PtyState::new())
        .manage(tunnel::TunnelState::new())
        .manage(perf::PerfState::new(perf_db()))
        .manage(logs::LogState::new(logs::LogConfig::default()))
        // In-flight `bsc navigate` requests (#3274): the appchan watcher parks on a receiver here and
        // `navigate_ack` (invoked by the frontend once it has applied the view) delivers into it.
        .manage(crate::navigate::NavPending::default())
        // In-flight `bsc debug` inspections (#3437) — the same park-and-ack shape as navigate.
        .manage(crate::debug::DebugPending::default())
        .manage(scope_registry.clone())
        // Runtime fault-ingest collector (#2261): the loopback receiver a generated app POSTs
        // faults/heartbeats to. Started (bound + accept loop spawned) in `setup` below.
        .manage(collector::CollectorState::new())
        .manage(project::preview::PreviewServers::default())
        .manage(crate::shot::ShotTargets::default())
        .manage(UncleanShutdown(unclean_shutdown))
        .setup(move |app| {
            // Install the dual-sink GraphLogger (#1389) in place of tauri-plugin-log — FIRST, so the
            // startup logs below are captured. The FILE sink writes the rotating app log (the #1607
            // reader's `app` stream, `<app_log_dir>/base-studio-code.log`); the CONSOLE sink is gated
            // by the scope registry. A missing log-dir falls back under the base dir (still readable).
            let app_log = logs::app_log_file(app.handle())
                .unwrap_or_else(|| bsc_base_dir().join("base-studio-code.log"));
            graph_log::install(scope_registry.clone(), app_log.clone());
            // Force the main window's taskbar/title icon from the icon Tauri embedded from
            // `bundle.icon` (#2683). A bundled/installed build shows the app icon via the exe's Windows
            // resource, but under `tauri dev` the debug exe doesn't reliably apply it, so the taskbar
            // shows a blank square while developing. Re-applying the already-embedded icon at startup
            // makes dev match the shipped build — no new asset, and it's a no-op elsewhere.
            if let (Some(win), Some(icon)) = (app.get_webview_window("main"), app.default_window_icon().cloned()) {
                if let Err(e) = win.set_icon(icon) {
                    log::warn!("[startup] could not apply window icon: {e}");
                }
            }
            // External-write watch: a `bsc log set` from a console session rewrites `log-scopes.json`;
            // poll its mtime and reload the in-memory graph live (cheap stat; read only on a change).
            let reg_poll = scope_registry.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
                    reg_poll.reload_if_changed();
                }
            });
            log::info!("[startup] process→setup {}ms (native + plugin init)", boot_start.elapsed().as_millis());
            // One-time layout migration (#922): consolidate legacy draft/ hubs back under
            // projects/ while nothing holds them as a cwd. Idempotent + cheap once draft/ is gone.
            migrate_draft_hubs_into_projects();
            // One-time plan.db relocation (#2996): move each hub's plan.db to the central plans/ store
            // so the plan is folder-independent (the DB is the source of truth; the hub is materialized
            // at triage, epic #2993). After the draft consolidation, before any session opens a plan.db.
            crate::project::plan_db::migrate_plan_dbs_to_central();
            // One-time backfill (#2998): fold every existing on-disk hub into the durable projects.db
            // registry (title + lifecycle state), so the DB is the source of truth for what projects
            // exist — recovering hubs that only lived on disk. Additive + idempotent; never deletes.
            crate::project::hub::backfill_projects_db_from_hubs();
            // Seed the runtime config dir (#2027 P2): copy the embedded `data/` tree into
            // ~/.base-studio-code/config/ on first run (only absent files — never clobbers a user
            // edit), so prompts/taxonomies can be edited without a rebuild. Best-effort: on failure
            // the embedded fallback stays in force, so a seed error is non-fatal.
            if let Err(e) = crate::platform::config::ensure_seeded() {
                log::warn!("[startup] config seed skipped ({e}); using embedded defaults");
            }
            // Dev sidecar staging (#3457): in a dev build, copy `bsc`/`bsc-agent` out of the cargo
            // target dir into a stable dir so a live session's long-lived `bsc` (the MCP servers) locks
            // the staged copy — leaving `target/<profile>/bsc.exe` free for the next `cargo build` to
            // relink. No-op in a release bundle. Runs BEFORE the self-check so it reports staged paths.
            crate::console::pty::stage_dev_sidecars();
            // Sidecar self-check (#1988): `bsc`/`bsc-agent` are built by a SEPARATE step
            // (`npm run build:plan` in dev / `stage:sidecar` for a release) and resolved beside the app
            // exe. If that step was skipped they'd be missing — silently unsetting $BSC_BIN so every
            // agent shell loses the `bsc` CLI mid-task. Surface it LOUDLY at boot (with the fix) instead.
            for (name, path) in crate::console::pty::sidecar_status() {
                match path {
                    Some(p) => log::info!("[startup] sidecar `{name}` → {}", p.display()),
                    None => log::error!(
                        "[startup] sidecar `{name}` NOT FOUND beside the app exe or in target/{{debug,release}} \
                         — agent sessions will lack `{name}`. Build it: `npm run build:plan` (dev) or \
                         `npm run stage:sidecar` (release)."
                    ),
                }
            }
            // Cap unbounded log files to reclaim disk space — OFF the synchronous boot path
            // (#1047). A full read/rewrite of audit.log (≈520 KB) + the other TSV streams is
            // housekeeping, not first-paint work; doing it inline blocked every startup. Defer
            // past the cold-start window, then run the blocking I/O on a worker thread so it
            // never stalls first paint or the async runtime. Config-driven (#1060): uses the
            // LogState default (10k lines) until the frontend pushes the user's value.
            let cap_base = bsc_base_dir();
            let cap_cfg = app.state::<logs::LogState>().get();
            // The rotating app log now belongs to the GraphLogger (#1389) — no plugin rotates it — so
            // include it in the boot cap alongside the TSV streams.
            let cap_app_log = app_log.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(perf::STARTUP_GRACE_SECS)).await;
                tauri::async_runtime::spawn_blocking(move || {
                    logs::cap_logs(&cap_base, &cap_cfg);
                    logs::cap_log(&cap_app_log, &cap_cfg);
                });
            });
            // Reclaim stale fleet worktrees so they don't accumulate to GBs (#worktree-disk): orphans
            // (deleted project) + merged-and-clean worktrees. Off the synchronous boot path + on a
            // worker thread (the git probes + recursive deletes are I/O-heavy); never touches a dirty
            // worktree, so it can't lose work.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(perf::STARTUP_GRACE_SECS)).await;
                tauri::async_runtime::spawn_blocking(fleet::teardown::gc_worktrees_on_boot);
            });
            // Spawn the background performance sampler.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(perf::run_sampler(handle));
            // Answer `bsc shot` capture requests (#3261, epic #3260). `bsc` cannot call us — the bridge
            // only runs app→bsc — so the CLI drops a request in ~/.base-studio-code/shots/ and this
            // watcher snapshots the webview and answers. Cheap poll on a worker thread; a missing dir
            // just disables captures rather than aborting startup.
            crate::appchan::spawn_watcher(app.handle().clone());
            // Log-stream change watcher (#3638): emit `logs://<stream>` when a unified log file's mtime
            // advances, so the frontend reads each stream on CHANGE instead of polling it every ~1s.
            observability::log_watch::spawn(app.handle().clone());
            // Start the localhost fault-ingest receiver (#2261): binds 127.0.0.1:0 and runs its accept
            // loop on a background thread. A bind failure is logged and leaves the port at 0 (ingest
            // unavailable) rather than aborting startup.
            app.state::<collector::CollectorState>().start();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            crate::session::llm::llm_complete,
            crate::session::llm::ollama_models,
            github::github_request,
            github::gist_create,
            github::gist_update,
            github::github_cache_clear,
            github::github_graphql,
            github::github_post,
            github::github_put,
            github::github_patch,
            github::github_delete,
            oauth::github_client_id,
            oauth::github_device_start,
            oauth::github_device_poll,
            pty::pty_create,
            pty::pty_write,
            pty::pty_pane_runtime,
            pty::pty_broadcast,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_set_app_runner,
            bsc::bsc,
            app::dialog::pick_directory,
            app::dialog::pick_save_file,
            app::dialog::pick_open_file,
            data::pick_csv_file,
            data::data_preview_csv,
            data::data_load_csv,
            data::data_reconcile_csvs,
            #[cfg(feature = "source-stage")]
            data::data_source_inventory,
            #[cfg(feature = "source-stage")]
            data::data_source_sample,
            #[cfg(feature = "source-stage")]
            data::data_infer_model,
            #[cfg(feature = "source-stage")]
            data::data_get_model,
            #[cfg(feature = "source-stage")]
            data::data_load_reconciled,
            #[cfg(feature = "source-stage")]
            data::data_platform_scan,
            credentials::source_save_secret,
            credentials::source_has_secret,
            credentials::source_delete_secret,
            source_oauth::source_oauth_begin,
            planner::workspace::setup_workspaces,
            planner::directives::planner_intro_prompt,
            planner::directives::planner_stage_directive,
            crate::platform::config::export_config_bundle,
            crate::platform::config::import_config_bundle,
            crate::platform::config::get_config_files,
            crate::platform::path_expose::path_expose_status,
            crate::platform::path_expose::path_expose_configure,
            github::repos::clone_repo,
            extensions::mcp::mcp_clone,
            extensions::mcp::mcp_build,
            extensions::mcp::mcp_status,
            extensions::mcp::mcp_check_update,
            fleet::worktree::ensure_worktree,
            fleet::teardown::teardown_worktree,
            fleet::teardown::reclaim_worktrees,
            fleet::disk::worktrees_disk_usage,
            fleet::director::ensure_director_protocol,
            docstore::get_base_dir,
            session::claude_config::read_claude_config,
            session::claude_config::write_claude_config,
            session::settings::ensure_session_settings,
            session::designer::setup_designer_workspace,
            session::architect::setup_architect_workspace,
            session::librarian::setup_librarian_workspace,
            session::sound_designer::setup_sound_designer_workspace,
            session::integrator::setup_integrator_workspace,
            session::debug::debug_repo_root,
            crate::shot::set_shot_target_rect,
            session::sandbox::wsl_sandbox_status,
            session::sandbox::provision_sandbox,
            session::sandbox::sandbox_run,
            session::sandbox::sandbox_disk_usage,
            session::sandbox::remove_sandbox,
            session::sandbox::setup_sandbox_hub,
            session::sandbox::sandbox_read_file,
            session::sandbox::read_sandbox_plan_stages,
            session::sandbox::sync_sandbox_plan_db,
            session::sandbox::sandbox_clone_repo,
            session::sandbox::ensure_sandbox_worktree,
            session::sandbox::ensure_sandbox_user,
            app::recovery::was_unclean_shutdown,
            crate::navigate::navigate_ack,
            crate::debug::debug_ack,
            github::readiness::github_readiness,
            github::readiness::preflight,
            github::readiness::get_preferred_shell,
            github::readiness::set_preferred_shell,
            project::plan_files::read_plan_stages,
            project::hub::delete_project_dir,
            project::hub::mark_published,
            project::hub::set_project_title,
            project::hub::relink_project_hub,
            project::plan_files::clear_all_plan_files,
            project::plan_files::clear_project_plan_files,
            project::hub::list_local_projects,
            project::files::write_project_file,
            project::files::write_project_file_bytes,
            project::dead_code::scan_dead_code,
            project::files::read_project_files,
            planner::workspace::get_context_signature,
            planner::workspace::compute_context_signature,
            docstore::read_document,
            tunnel::tunnel_start,
            tunnel::tunnel_stop,
            tunnel::tunnel_status,
            tunnel::tunnel_set_input_granted,
            tunnel::tunnel_unpair,
            tunnel::tunnel_set_panes,
            tunnel::tunnel_set_sessions,
            tunnel::tunnel_set_plan_state,
            tunnel::tunnel_emit_plan_state,
            tunnel::tunnel_emit_plan_event,
            tunnel::tunnel_emit_plan_status,
            tunnel::tunnel_ack_plan_push,
            tunnel::apply_pushed_plan_files,
            tunnel::tunnel_check_relay,
            tunnel::tunnel_emit_coord_event,
            tunnel::tunnel_set_automations,
            tunnel::tunnel_automation_failed,
            tunnel::tunnel_set_hook_telemetry,
            tunnel::tunnel_set_store_state,
            tunnel::tunnel_emit_alert,
            fleet::inspect::read_worktree_changes,
            fleet::inspect::read_worktree_changes_batch,
            fleet::inspect::fleet_landed_streams,
            fleet::inspect::dir_exists,
            fleet::inspect::read_worktree_branch,
            fleet::inspect::read_worktree_commits,
            fleet::inspect::find_branch_pr,
            fleet::inspect::claude_transcript_path,
            // The observability READ commands (audit/skill/hook/mcp/coord tails, token usage, pane
            // activity, done panes) moved to the `bsc logs` CLI over the `bsc` bridge (#2144).
            tokens::read_pane_messages,
            project::ui_skeleton::read_ui_skeleton,
            project::ui_skeleton::sync_design_to_skeleton,
            project::hub::project_dir_path,
            project::hub::materialize_hub,
            project::hub::repo_dir_path,
            project::preview::verify_build,
            observability::logs::append_coord_woke,
            observability::collector::collector_info,
            observability::collector::project_liveness,
            observability::collector::fault_rows_batch,
            git_hooks::read_git_hooks,
            perf::perf_get_config,
            perf::perf_set_config,
            perf::perf_record_frontend_sample,
            perf::perf_clear_history,
            perf::perf_get_recent_samples,
            discovery::discover_sessions,
            discovery::reap_session,
            logs::list_log_files,
            logs::read_log_tail,
            logs::logs_tail,
            logs::logs_pane_activity,
            logs::logs_done_panes,
            logs::clear_log,
            logs::export_log,
            logs::log_get_config,
            logs::log_set_config,
            logs::enforce_log_caps,
            // Runtime log-scope graph (#1389): the console-view control surface + the frontend bridge.
            graph_log::log_get_scopes,
            graph_log::log_set_scope,
            graph_log::log_reset_scopes,
            graph_log::frontend_log,
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
                // Clean shutdown (#1041): delete the session-lock marker so the NEXT launch reads a
                // clean exit and doesn't offer to restore. A crash/kill skips this handler, leaving
                // the marker → the next launch detects the unclean shutdown.
                let _ = std::fs::remove_file(session_lock_path());
                // Signal the tunnel transport (#242b) to close before tearing down PTYs.
                app_handle.state::<tunnel::TunnelState>().shutdown();
                crate::console::pty::kill_all_pty_sessions(app_handle.state::<crate::console::pty::PtyState>().inner());
            }
        });
}

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

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
}
