//! base-studio-code Tauri backend (#1300). The crate root is **only** module declarations + crate-root
//! re-exports — every subsystem lives in its own domain folder, and the re-exports preserve the
//! pre-restructure `crate::<name>` paths so the invoke handler and sibling modules resolve unchanged.

mod planner;
mod platform;
mod app;
mod console;
mod agent;
mod github;
mod sources;
mod llm;
mod observability;
mod mobile;
mod project;
mod fleet;
mod extensions;

pub use app::run::run;

// ── stage 1/2 domain modules, re-exported under their pre-restructure names ──
pub(crate) use console::{pty, ledger as pty_ledger, discovery as session_discovery, shell_rc as bsc};
pub(crate) use agent::{harness, claude_config as config};
pub(crate) use github::{oauth, git_hooks as githooks};
pub(crate) use sources::{data, oauth as source_oauth, credentials};
pub(crate) use platform::docstore;
pub(crate) use observability::{logs, perf, tokens};
pub(crate) use mobile::{push as fcm, tunnel};
pub(crate) use project::plan_db;

// ── platform primitives ──
pub(crate) use platform::shell;
pub(crate) use platform::paths::{
    home_dir, bsc_base_dir, project_dir, repo_dir, worktrees_dir,
    plan_dir_for, discovery_dir_for, published_marker, is_published, legacy_draft_dir,
    nearest_existing_ancestor,
};
pub(crate) use platform::git::{git_lines, git_output, git_exclude};
pub(crate) use platform::process::no_window;
pub(crate) use platform::fsx::{is_safe_relpath, read_files_dir, read_text_files, ingest_section_files, sanitize_project_key, worktree_slug};
pub(crate) use platform::shell::{split_utf8_at_boundary, to_bash_path, to_native_path, bash_ansi_c_quote};

// ── stage 3: helpers carved from lib.rs that are referenced cross-module (commands are referenced
//    by module path directly in app/run.rs's invoke handler, so they need no crate-root re-export) ──
pub(crate) use app::state::UncleanShutdown;
pub(crate) use app::recovery::{session_lock_path, claim_session_lock};
pub(crate) use project::hub::migrate_draft_hubs_into_projects;
pub(crate) use agent::launch::{
    claude_launch, claude_model_flag, claude_project_dir_name,
    has_claude_history, has_bsc_agent_history, bsc_agent_session_path,
};
pub(crate) use observability::perf::PerfSpan;
pub(crate) use extensions::mcp::write_mcp_json;
pub(crate) use extensions::hooks::write_session_hooks;
pub(crate) use extensions::skills::write_session_skills;
pub(crate) use extensions::cfg::{McpServerCfg, HookCfg, SkillCfg};
pub(crate) use fleet::protocols::{FLEET_PROTOCOL_MD, INJECTION_RESISTANCE_MD, INJECTION_RESISTANCE_MARKER};

#[cfg(test)]
pub(crate) mod testutil;
#[cfg(test)]
mod tests;
