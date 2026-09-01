//! Session launch, configuration & settings (#1917): the consolidated home for everything that
//! decides how an agent session is launched and what it can do — the harness seam (launch/resume in a
//! PTY), the `~/.claude.json` trust state, the `.claude/settings.json` permission file the session
//! runs under, and the one-shot LLM completion command. (The #1880 role/profile/permission
//! composition lands here too, so the security-critical logic sits in ONE directory.)

pub mod harness;
pub mod claude_config;
pub mod launch;
pub mod role_gate;
pub mod profile_settings;
pub mod denies;
pub mod write_scope;
pub mod agent_perms;
pub mod access_env;
pub mod fresh_only;
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
