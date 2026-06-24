//! Agent launch & configuration (#1300): how an agent runtime is launched/resumed in a PTY
//! (the harness seam) and the `~/.claude.json` trust-state management.

pub mod harness;
pub mod claude_config;
pub mod launch;
