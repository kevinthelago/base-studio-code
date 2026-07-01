//! The canonical registry of the app's observability log streams (#1847).
//!
//! Each per-pane TSV the `bsc-*` hooks append to was named in three places that drift independently:
//!   - `console/pty/mod.rs` (`wire_bsc_env`) — set `$BSC_*_LOG` to `<base>/<file>` for every pane,
//!   - `crates/logs` — the unified `bsc-logs` reader's `STREAMS` table (`key` → `file`),
//!   - `console/shell_rc.rs` — the helpers read the `$BSC_*_LOG` names.
//!
//! This is the ONE source of truth the writer (pty) and the reader (`crates/logs`) now share. The
//! per-row doc comment is the stream's spec — which hook writes it and the line shape — so it lives
//! beside the data instead of scattered across the env-writer.

/// One observability log stream: a TSV file under the session log dir that a `bsc-*` hook appends to.
pub struct LogStream {
    /// The unified reader's canonical short name (`"tool"`) — also a `bsc-logs` query target.
    pub key: &'static str,
    /// The env var the pty writer sets and the shell helper reads (`"BSC_AUDIT_LOG"`).
    pub env_var: &'static str,
    /// The file under the log dir (`"audit.log"`).
    pub filename: &'static str,
    /// Whether the unified `bsc-logs` reader parses this stream (`crates/logs::read_stream`). The
    /// token/cost stream is written + env-staged but read via the separate cost path, so it's `false`.
    pub reader_stream: bool,
}

/// Every observability stream the app wires into a session. Order is the unified reader's order (so
/// the `bsc-logs` default-all query is unchanged), with the writer-only token/cost stream last. The
/// pty writer iterates the whole set (env vars — order-independent); the reader takes the
/// `reader_stream` subset.
pub const LOG_STREAMS: &[LogStream] = &[
    // Tool-attempt audit (#257): the `bsc-audit` PreToolUse hook appends one redacted
    // `ts·pane·tool·target` line per tool attempt.
    LogStream { key: "tool", env_var: "BSC_AUDIT_LOG", filename: "audit.log", reader_stream: true },
    // Skill usage (#406): the `bsc-skill` Skill-tool hook appends one `ts·pane·event·skill` line per
    // skill invocation.
    LogStream { key: "skill", env_var: "BSC_SKILL_LOG", filename: "skills.log", reader_stream: true },
    // MCP calls (#879): the `bsc-mcp` PreToolUse+PostToolUse pair appends one
    // `ts·pane·server·tool·outcome·ms·detail` line per MCP call (legacy lines lack the pane column).
    LogStream { key: "mcp", env_var: "BSC_MCP_LOG", filename: "mcp.log", reader_stream: true },
    // User-hook fires (#867): the `bsc-hook` wrapper appends one `ts·pane·event·name·outcome` line
    // per fire (legacy lines lack the pane column).
    LogStream { key: "hook", env_var: "BSC_HOOK_LOG", filename: "hooks.log", reader_stream: true },
    // Turn-activity (#1184): the `bsc-activity` UserPromptSubmit/Stop hooks append one
    // `ts·pane·run|idle` line per turn boundary (gates the status dot's silence timer).
    LogStream { key: "activity", env_var: "BSC_ACTIVITY_LOG", filename: "activity.log", reader_stream: true },
    // Worker self-close (#1379): a finished worker's `bsc-done` appends one `ts·pane` line; the
    // frontend reaps the pane.
    LogStream { key: "done", env_var: "BSC_DONE_LOG", filename: "done.log", reader_stream: true },
    // Coordination (#199): the coord emitters (`bsc-landed`/`bsc-ask`/`bsc-answer`/…) append
    // structured `ts·pane·kind·…` events the Coordination inbox reads.
    LogStream { key: "coord", env_var: "BSC_COORD_LOG", filename: "coord.log", reader_stream: true },
    // Permission denials (#1607 slice 2): the deny hooks — `bsc-confine`/`bsc-scope` (via `__bsc_perm`)
    // and the Rust `bsc hook bash-deny` — append one `ts·pane·gate·verdict·target·reason` line per
    // block, so a denial is joinable to its session in `bsc logs perm`/`session` (it was unlogged).
    LogStream { key: "perm", env_var: "BSC_PERM_LOG", filename: "perm.log", reader_stream: true },
    // Token + cost accounting (#416): the `bsc-tokens` Stop/SubagentStop hook appends one
    // `ts·pane·session_id·transcript_path` line; `read_token_usage` parses + prices the transcript.
    // Read via the separate cost path (`crates/logs::cost`), so NOT a unified reader stream.
    LogStream { key: "tokens", env_var: "BSC_TOKENS_LOG", filename: "tokens.log", reader_stream: false },
];

/// The `(key, filename)` pairs the unified `bsc-logs` reader knows about — the `reader_stream` subset,
/// in registry order. `crates/logs` reads this instead of its own hand-kept table.
pub fn reader_streams() -> Vec<(&'static str, &'static str)> {
    LOG_STREAMS.iter().filter(|s| s.reader_stream).map(|s| (s.key, s.filename)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn registry_is_internally_consistent() {
        let mut keys = HashSet::new();
        let mut envs = HashSet::new();
        let mut files = HashSet::new();
        for s in LOG_STREAMS {
            assert!(s.env_var.starts_with("BSC_") && s.env_var.ends_with("_LOG"), "{} bad env_var", s.key);
            assert!(s.filename.ends_with(".log"), "{} bad filename", s.key);
            assert!(keys.insert(s.key), "duplicate key {}", s.key);
            assert!(envs.insert(s.env_var), "duplicate env_var {}", s.env_var);
            assert!(files.insert(s.filename), "duplicate filename {}", s.filename);
        }
    }

    #[test]
    fn reader_subset_matches_the_unified_streams_set_and_order() {
        // This pins the contract `crates/logs` previously hardcoded in its own `STREAMS` table — same
        // pairs, same order — so the registry is a behavior-preserving single source.
        assert_eq!(
            reader_streams(),
            vec![
                ("tool", "audit.log"),
                ("skill", "skills.log"),
                ("mcp", "mcp.log"),
                ("hook", "hooks.log"),
                ("activity", "activity.log"),
                ("done", "done.log"),
                ("coord", "coord.log"),
                ("perm", "perm.log"),
            ],
        );
        // The token/cost stream is staged + written but read via the cost path, so it's excluded.
        assert!(!reader_streams().iter().any(|(k, _)| *k == "tokens"));
        assert_eq!(LOG_STREAMS.iter().find(|s| s.key == "tokens").unwrap().env_var, "BSC_TOKENS_LOG");
    }
}
