use crate::*;
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
    let reaped = pty_ledger::reconcile_on_boot();
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
    builder
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
        .plugin(tauri_plugin_opener::init())
        .manage(crate::pty::PtyState::new())
        .manage(tunnel::TunnelState::new())
        .manage(perf::PerfState::new(bsc_base_dir().join("perf.db")))
        .manage(logs::LogState::new())
        .manage(UncleanShutdown(unclean_shutdown))
        .setup(move |app| {
            log::info!("[startup] process→setup {}ms (native + plugin init)", boot_start.elapsed().as_millis());
            // One-time layout migration (#922): consolidate legacy draft/ hubs back under
            // projects/ while nothing holds them as a cwd. Idempotent + cheap once draft/ is gone.
            migrate_draft_hubs_into_projects();
            // Cap unbounded log files to reclaim disk space — OFF the synchronous boot path
            // (#1047). A full read/rewrite of audit.log (≈520 KB) + the other TSV streams is
            // housekeeping, not first-paint work; doing it inline blocked every startup. Defer
            // past the cold-start window, then run the blocking I/O on a worker thread so it
            // never stalls first paint or the async runtime. Config-driven (#1060): uses the
            // LogState default (10k lines) until the frontend pushes the user's value.
            let cap_base = bsc_base_dir();
            let cap_cfg = app.state::<logs::LogState>().get();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(tokio::time::Duration::from_secs(perf::STARTUP_GRACE_SECS)).await;
                tauri::async_runtime::spawn_blocking(move || logs::cap_logs(&cap_base, &cap_cfg));
            });
            // Spawn the background performance sampler.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(perf::run_sampler(handle));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            knowledge::chat::kb_chat,
            github::github_request,
            github::gist_create,
            github::gist_update,
            github::github_cache_clear,
            github::github_graphql,
            github::github_post,
            github::github_put,
            github::github_patch,
            oauth::github_client_id,
            oauth::github_device_start,
            oauth::github_device_poll,
            pty::pty_create,
            pty::pty_write,
            pty::pty_broadcast,
            pty::pty_resize,
            pty::pty_kill,
            app::dialog::pick_directory,
            data::pick_csv_file,
            data::data_preview_csv,
            data::data_load_csv,
            data::data_reconcile_csvs,
            data::data_source_inventory,
            data::data_source_sample,
            data::data_infer_model,
            data::data_persist_model,
            data::data_get_model,
            data::data_load_reconciled,
            data::data_platform_scan,
            data::data_connector_catalog,
            credentials::source_save_secret,
            credentials::source_has_secret,
            credentials::source_delete_secret,
            source_oauth::source_oauth_begin,
            planner::workspace::setup_workspaces,
            planner::directives::planner_intro_prompt,
            knowledge::workspace::setup_kb_workspace,
            github::repos::clone_repo,
            extensions::mcp::mcp_clone,
            extensions::mcp::mcp_build,
            extensions::mcp::mcp_status,
            extensions::mcp::mcp_check_update,
            extensions::skill_store::skill_store_list,
            extensions::skill_store::skill_store_upsert,
            extensions::skill_store::skill_store_remove,
            extensions::skill_store::skill_group_list,
            extensions::skill_store::skill_group_upsert,
            extensions::skill_store::skill_group_remove,
            extensions::skill_store::skill_group_resolve,
            fleet::worktree::ensure_worktree,
            fleet::teardown::teardown_worktree,
            fleet::teardown::reclaim_worktrees,
            fleet::teardown::worktrees_disk_usage,
            fleet::director::ensure_director_protocol,
            docstore::get_base_dir,
            config::read_claude_config,
            config::write_claude_config,
            console::settings::ensure_session_settings,
            app::recovery::was_unclean_shutdown,
            github::readiness::github_readiness,
            github::readiness::preflight,
            github::readiness::get_preferred_shell,
            github::readiness::set_preferred_shell,
            project::plan_files::read_plan_sections,
            docstore::write_project_plan,
            project::hub::delete_project_dir,
            project::hub::mark_published,
            project::plan_files::clear_all_plan_files,
            project::plan_files::clear_project_plan_files,
            project::blueprints::list_blueprints,
            project::blueprints::write_blueprint,
            project::blueprints::delete_blueprint,
            project::hub::list_local_projects,
            fleet::staging::write_project_file,
            fleet::staging::write_project_file_bytes,
            project::inspect::scan_dead_code,
            fleet::staging::read_project_files,
            planner::workspace::get_context_signature,
            planner::workspace::compute_context_signature,
            docstore::list_documents,
            docstore::read_document,
            docstore::write_document,
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
            tunnel::tunnel_check_relay,
            tunnel::tunnel_set_fleet_state,
            tunnel::tunnel_emit_coord_event,
            tunnel::tunnel_set_automations,
            tunnel::tunnel_automation_ran,
            tunnel::tunnel_automation_failed,
            tunnel::tunnel_set_mcp_state,
            observability::audit::read_audit_log,
            observability::audit::read_worktree_changes,
            observability::audit::read_worktree_branch,
            observability::audit::read_worktree_commits,
            observability::audit::find_branch_pr,
            observability::audit::claude_transcript_path,
            observability::audit::read_skill_log,
            observability::audit::read_hook_log,
            observability::audit::read_mcp_log,
            tokens::read_token_usage,
            tokens::read_pane_messages,
            tokens::read_pane_activity,
            tokens::read_done_panes,
            observability::audit::read_coord_log,
            project::inspect::read_ui_skeleton,
            project::inspect::sync_design_to_skeleton,
            project::hub::project_dir_path,
            observability::audit::append_coord_woke,
            githooks::read_git_hooks,
            perf::perf_get_config,
            perf::perf_set_config,
            perf::perf_record_frontend_sample,
            perf::perf_clear_history,
            perf::perf_get_recent_samples,
            session_discovery::discover_sessions,
            session_discovery::reap_session,
            logs::list_log_files,
            logs::read_log_tail,
            logs::clear_log,
            logs::export_log,
            logs::log_get_config,
            logs::log_set_config,
            logs::enforce_log_caps,
            plan_db::plan_upsert_issue,
            plan_db::plan_list_issues,
            plan_db::plan_remove_issue,
            plan_db::plan_set_issue_status,
            plan_db::plan_upsert_feature,
            plan_db::plan_list_features,
            plan_db::plan_remove_feature,
            plan_db::plan_add_repo,
            plan_db::plan_list_repos,
            plan_db::plan_remove_repo,
            plan_db::plan_upsert_phase,
            plan_db::plan_list_phases,
            plan_db::plan_remove_phase,
            plan_db::plan_set_fleet,
            plan_db::plan_get_fleet,
            plan_db::plan_remove_stream,
            plan_db::plan_set_deploy,
            plan_db::plan_get_deploy,
            plan_db::plan_set_deps,
            plan_db::plan_get_deps,
            plan_db::plan_add_mcp,
            plan_db::plan_list_mcp,
            plan_db::plan_remove_mcp,
            plan_db::plan_set_blueprint,
            plan_db::plan_get_blueprint,
            plan_db::plan_list_context,
            plan_db::plan_require_context,
            plan_db::plan_triage_record_run,
            plan_db::plan_triage_last_run,
            plan_db::plan_issues_changed_since,
            plan_db::plan_lesson_list,
            plan_db::plan_lesson_confirm,
            plan_db::plan_lesson_discard,
            plan_db::plan_lesson_remove,
            plan_db::plan_lesson_expire,
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
                crate::pty::kill_all_pty_sessions(app_handle.state::<crate::pty::PtyState>().inner());
            }
        });
}
