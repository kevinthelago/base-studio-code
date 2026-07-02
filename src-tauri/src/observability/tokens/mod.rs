// Token + cost accounting (#416), extracted from lib.rs (#758); split into
// cost / messages submodules (#1659).
//
// Claude Code hooks don't expose token usage, so the only per-session source is the
// session transcript (JSONL, one message per line, each assistant line carrying a
// per-message `usage` object). The `bsc-tokens` Stop hook records `pane → session_id →
// transcript_path` to `tokens.log`. The per-pane token-usage READ + the per-pane turn
// activity/done READs moved to the `bsc logs` CLI over the `bsc` bridge (#2144 —
// `bsc logs cost --full` / `pane-activity` / `done-panes`); the pricing engine + those
// rollups live ONCE in `crates/logs`. What stays here is the transcript→conversation
// projection (`messages`, still a Tauri command — it parses Claude's transcript, not a log
// stream) plus the shared `tokens.log` parsing helpers (`latest_transcript_per_pane` /
// `json_unescape_path`, also used by `console/shell_rc`).

mod cost;
mod messages;

// Glob re-export `messages` so the `tokens::read_pane_messages` command path in `app/run.rs` stays
// valid — a `#[tauri::command]` generates hidden `__cmd__*` / `__tauri_command_name_*` items next to
// the fn that `generate_handler!` resolves through the same path (matching the `github/mod.rs`
// pattern). From `cost`, only `json_unescape_path` is reached cross-module — via
// `crate::observability::tokens::json_unescape_path` (a `console/shell_rc` transcript-path decode
// test); the other `cost` helpers are used through `super::cost::…` directly. That one re-export is
// consumed only by a test, so it's `allow(unused_imports)` for the non-test lib build.
pub(crate) use messages::*;
#[allow(unused_imports)]
pub(crate) use cost::json_unescape_path;
