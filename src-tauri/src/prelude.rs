//! The crate's internal prelude (#1918): a curated, NAMED set of leaf helpers (paths, git, shell, fs,
//! plus a few cross-cutting items) that nearly every module uses. Modules do `use crate::prelude::*;`
//! to pull these in by bare name — an honest named prelude that replaces the old whole-crate-root glob
//! (`use crate::*`) over the #1300 re-export shim. Domain MODULES are now imported explicitly at each site
//! (`use crate::console::pty;`), so a reference always names its domain; only these leaf helpers arrive
//! via the glob.

pub(crate) use crate::platform::paths::{
    bsc_base_dir, data_db_path, discovery_dir_for, error_db_path, home_dir, ingest_port_file,
    ingest_token_path, is_published, legacy_draft_dir, nearest_existing_ancestor, parse_worktree_dir_name,
    perf_db, plan_db_path, plan_dir_for, planning_cwd, planning_workspace_dir, project_dir, projects_root,
    repo_dir, skills_db, worktree_dir_name, worktrees_dir,
};
pub(crate) use crate::platform::git::{git_exclude, git_lines, git_ok, git_output, git_run};
pub(crate) use crate::platform::process::{
    no_window, run_capture, run_capture_stdin, run_ok, run_output, run_status,
};
pub(crate) use crate::platform::errs::StrErr;
pub(crate) use crate::platform::fsx::{
    append_block_once, ingest_stage_files, is_safe_relpath, read_files_dir, read_text_files,
    sanitize_project_key, worktree_slug,
};
pub(crate) use crate::platform::shell::{
    bash_ansi_c_quote, split_utf8_at_boundary, to_bash_path, to_native_path,
};
pub(crate) use crate::app::state::UncleanShutdown;
pub(crate) use crate::app::recovery::{claim_session_lock, session_lock_path};
pub(crate) use crate::project::hub::migrate_draft_hubs_into_projects;
pub(crate) use crate::session::launch::{
    bsc_agent_session_path, claude_launch, claude_model_flag, claude_project_transcripts_dir,
    has_bsc_agent_history, has_claude_history,
};
pub(crate) use crate::observability::perf::PerfSpan;
pub(crate) use crate::extensions::mcp::write_mcp_json;
pub(crate) use crate::extensions::hooks::write_session_hooks;
pub(crate) use crate::extensions::skills::write_session_skills;
pub(crate) use crate::extensions::cfg::{HookCfg, McpServerCfg, SkillCfg};
pub(crate) use crate::fleet::protocols::{
    fleet_protocol_md, injection_resistance_md, INJECTION_RESISTANCE_MARKER,
};
