//! Session launch, configuration & settings (#1917): the consolidated home for everything that
//! decides how an agent session is launched and what it can do — the harness seam (launch/resume in a
//! PTY), the `~/.claude.json` trust state, the `.claude/settings.json` permission file the session
//! runs under, and the one-shot LLM completion command. (The #1880 role/profile/permission
//! composition lands here too, so the security-critical logic sits in ONE directory.)

pub mod harness;
pub mod claude_config;
pub mod launch;
pub mod settings;
pub mod sandbox;
pub mod llm;
pub mod designer;
pub mod architect;
pub mod librarian;
pub mod sound_designer;
pub mod integrator;
pub mod debug;
