// Token + cost accounting (#416), extracted from lib.rs (#758); split into
// cost / activity / messages submodules (#1659).
//
// Claude Code hooks don't expose token usage, so the only per-session source is the
// session transcript (JSONL, one message per line, each assistant line carrying a
// per-message `usage` object). The `bsc-tokens` Stop hook records `pane → session_id →
// transcript_path` to `tokens.log`; `read_token_usage` takes the latest transcript per
// pane, sums its usage, prices it, and returns one record per pane. The pricing engine
// (price table + usage parser + cost math) lives ONCE in `crates/logs` (`logs::cost`);
// `cost::read_token_usage` delegates to it and maps the result to the frontend shape (#1686).

mod activity;
mod cost;
mod messages;

// Glob re-export each submodule so the `tokens::*` command paths in `app/run.rs` stay valid —
// a `#[tauri::command]` generates hidden `__cmd__*` / `__tauri_command_name_*` items next to the
// fn that `generate_handler!` resolves through the same path, so the whole submodule is re-exported
// (matching the `github/mod.rs` pattern). This also keeps `crate::tokens::json_unescape_path`
// (console/shell_rc.rs) resolving.
pub(crate) use activity::*;
pub(crate) use cost::*;
pub(crate) use messages::*;
