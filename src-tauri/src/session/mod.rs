//! Session launch, configuration & settings (#1917): the consolidated home for everything that
//! decides how an agent session is launched and what it can do — the harness seam (launch/resume in a
//! PTY), the `~/.claude.json` trust state, the `.claude/settings.json` permission file the session
//! runs under, and the one-shot LLM completion command. (The #1880 role/profile/permission
//! composition lands here too, so the security-critical logic sits in ONE directory.)

pub mod harness;
pub mod claude_config;
pub mod launch;
pub mod fresh_only;

// ── the permission derivation now lives in a CRATE ───────────────────────────────────────────────
//
// `role_gate`, `profile_settings`, `denies`, `write_scope`, `agent_perms`, `access_env`,
// `hook_chain` and `tool_rules` moved to `crates/bsc-perms`
// (#the-session-permission-derivation-lives-in-a-crate-not-src-tauri). They were always pure — their
// whole non-std import surface was serde, `bsc_util::scope` and each other — but living here meant
// that changing which commands a role may run cost a new binary and a restarted window with a fleet
// in it, and that no live session could ask what its own role resolved to.
//
// RE-EXPORTED UNDER THEIR OLD PATHS ON PURPOSE. The ~20 call sites are almost all in
// `console/pty/mod.rs`, the highest-churn file in the app and the one the routing rule exists to
// protect; rewriting them would put this move INTO that file for no behavioural gain. `crate::session::role_gate::X`
// keeps resolving, and the code it resolves to is now hot-swappable.
pub use bsc_perms::access_env;
pub use bsc_perms::agent_perms;
pub use bsc_perms::denies;
pub use bsc_perms::hook_chain;
pub use bsc_perms::profile_settings;
pub use bsc_perms::role_gate;
pub use bsc_perms::tool_rules;
pub use bsc_perms::write_scope;
pub mod resume_cmd;
pub mod launch_cmd;
pub mod settings;
pub mod sandbox;
pub mod llm;
/// The shared way a studio workspace is created — one directory per technology, and the session's
/// context written into its `CLAUDE.md` instead of typed into its chat.
pub mod studio_ws;
pub mod designer;
pub mod architect;
pub mod librarian;
pub mod sound_designer;
pub mod integrator;
pub mod debug;
/// `bsc persona use` — the emit-and-ack that changes which persona a pane runs as.
pub mod persona_use;
/// `bsc session` — start/stop/list the app-owned system sessions over a closed registry
/// (#architect-starts-and-stops-system-sessions). Lives here rather than under `fleet/` because these
/// are the APP's own studios, not a project's fleet.
pub mod system;
/// How an ask REACHES its target — started with it, injected at idle, or interrupted with it
/// (#an-ask-is-delivered-not-left-to-be-found). Crosses `#only-the-user-resumes-a-session` on the
/// maintainer's explicit call; see the module doc.
pub mod deliver;
