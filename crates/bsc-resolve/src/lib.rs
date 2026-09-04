//! `bsc resolve` — what a session RECEIVES: its skills, and its MCP servers.
//!
//! ## Why this is a crate and not part of the app
//!
//! Both resolutions were already derived in Rust and already parity-proved against the TypeScript
//! (`the-session-skill-resolution-is-derived-in-rust-at-parity`,
//! `the-launch-resolves-its-own-skills-instead-of-receiving-them`). They were derived in the WRONG
//! PLACE: `src-tauri/src/extensions/`, which is the app's live process behind a webview. Changing a
//! pure decision over serde-able data there means a new binary and a RESTARTED WINDOW WITH A FLEET IN
//! IT, against ~1235 ms and no restart for the same code reached through `bsc`.
//!
//! That was not hypothetical. `mcp_resolution` is called from `console/pty/mod.rs` — the highest-churn
//! file in the app, 84 edits in 30 days, whose recent subjects were largely this migration landing in
//! it. The migration was causing the restarts it existed to escape.
//!
//! MEASURED before the move: across all 1,031 lines there were exactly THREE couplings to the app
//! crate — `crate::skills_db()` twice and `crate::platform::config::load_str` once. All three were
//! GATHERING, none was a decision. So the split this crate makes is the one that was already there.
//!
//! ## Gathering takes EXPLICIT PATHS
//!
//! [`skill::library`] and [`mcp::builtin_mcp_servers_at`] take the path they read. They do not consult
//! the environment, because env mutation behaves differently under `cargo test` (threads in one
//! process) and `cargo nextest` (a process per test) — a test written against env passes on the gate
//! and races locally, which makes the gate BLINDER than a local run on exactly the code that decides
//! what a session may do.
//!
//! ## WHICH WAY THIS FAILS, and why each direction was chosen
//!
//! The two halves fail in OPPOSITE directions, deliberately, because they are not the same kind of
//! thing.
//!
//! * **Skills degrade to NONE.** An unreadable `skills.db` yields an empty library, which resolves to
//!   no skills. This is safe ONLY because the reconciliation is a UNION with the list the renderer
//!   sent: the frontend's skills still stand, so the floor is "what the frontend already resolved",
//!   never "nothing". The alternative — failing the launch — makes an unreadable store fatal to every
//!   session on the box, which is a far worse outcome than a session that starts with the skills it
//!   would have had before this code existed.
//!
//!   THE PART THAT WOULD BE WRONG is letting that degradation reach a caller that REPLACES rather
//!   than unions. [`skill::reconcile_session_skills`] is the only sanctioned consumer for the launch
//!   path, and it unions. A future caller that takes `effective_session_skills` and writes it as the
//!   whole answer inherits a silent "no skills" on an I/O error, and must not.
//!
//! * **MCP loses only the AMBIENT servers.** An unreadable `builtin-servers.json` yields no built-ins;
//!   everything a persona explicitly CARRIES still resolves, because carrying is intent and is read
//!   from a different source. A session with fewer capabilities than intended is recoverable;
//!   inventing them from a hardcoded copy would be a second source of truth free to drift.
//!
//! Neither half may be given the fail-safe-and-return-Ok contract that `bsc disk`'s janitors have.
//! A janitor that silently does nothing costs disk. A resolution that silently returns nothing costs
//! a session the instructions it was configured to have, and nothing downstream notices a prompt that
//! is merely shorter.
//!
//! ## Batched by construction
//!
//! [`cli`]'s verbs take a LIST of sessions and read each store ONCE. A per-session command is the
//! shape #3908 and then #3954 were filed to undo: at ~39 panes it saturated the command pool and
//! `pty_write` measured 3280 ms. The stores here are opened per call, so a per-session verb would
//! reopen `skills.db` once per pane.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cfg.rs, src/cli.rs, src/mcp.rs, src/skill.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-resolve--<module>.rs
//     bsc graph impl set --id bsc-resolve--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-resolve--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));