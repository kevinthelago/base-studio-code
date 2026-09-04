//! `bsc perms` — what a session role actually resolves to.
//!
//! ## This crate is a MOVE, not a port, and the distinction is the whole point
//!
//! Every module here was already Rust, already correct, and already bound to the TypeScript by a
//! generated fixture with a live Rust reader. What was wrong was WHERE IT LIVED. All eight sat in
//! `src-tauri/src/session/`, so:
//!
//! - **Changing a role's permissions cost a new binary and a restarted window with a fleet in it.**
//!   The routing rule measures a crate edit at ~1235 ms to live behaviour against that. The call
//!   sites are almost entirely `console/pty/mod.rs` — the highest-churn file in the app, 84 edits in
//!   30 days, and the specific file the routing rule was written to protect.
//! - **No session could ask what a role resolves to.** The one surface that most needs to be
//!   inspectable by an agent — which commands may I run, which files may I write — was readable only
//!   by recompiling the app. `bsc perms` fixes that half.
//!
//! ## Purity was MEASURED before the move, not assumed
//!
//! The complete non-std import surface of all 3,870 lines was `serde`, `bsc_util::scope`, and each
//! other. Zero `tauri`, zero `AppHandle`, zero `State<>`, zero `crate::app`, zero `crate::console`.
//! That is why the move is mechanical: nothing here ever needed the app.
//!
//! ## The shape: one root, seven leaves
//!
//! [`role_gate`] is the root — it defines `RoleCapability` and `Tier` and answers what a role may do
//! in the abstract. Everything else renders that answer into one concrete artifact:
//!
//! | module              | renders                                                     |
//! |---------------------|-------------------------------------------------------------|
//! | [`denies`]          | the mutating git/gh commands a role may not run              |
//! | [`tool_rules`]      | the file-write tool rules                                    |
//! | [`write_scope`]     | the write-scope confinement                                  |
//! | [`access_env`]      | the access environment                                       |
//! | [`agent_perms`]     | the `bsc-agent` permission document                          |
//! | [`hook_chain`]      | the PreToolUse hook chain                                    |
//! | [`profile_settings`]| the per-agent profile applied at launch                      |
//!
//! ## WHICH WAY THIS FAILS: CLOSED, and that is not negotiable
//!
//! This crate decides which commands a worker may run and which files it may write. A boundary that
//! degrades to "no denies" when it cannot answer is not a graceful degradation, it is a privilege
//! escalation — a session would launch with a permission set nobody computed. So every resolution
//! path here either returns a complete answer or returns an error that the caller must treat as
//! fatal to the launch. **Never start a session with half a gate.**
//!
//! The `bsc perms` verb is READ-ONLY for the same reason: it exists so an agent can inspect what it
//! is subject to, never to negotiate it.
//!
//! ## The fixtures came with the modules
//!
//! Eight generated contracts (`roleGate`, `toolRules`, `sessionDenies`, `writeScopeEnv`,
//! `accessEnv`, `bscAgentPerms`, `hookChain`, `profileEnforcement`), each generated from the live
//! TypeScript and each asserting EXACTLY ONE name match under the source root. That assert is what
//! makes the move safe: at the new crate depth the root is `../../src` rather than `../src`, and a
//! wrong path yields zero matches and a loud failure, never a silent read of nothing.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/access_env.rs, src/agent_perms.rs, src/cli.rs, src/denies.rs, src/hook_chain.rs, src/profile_settings.rs, src/role_gate.rs, src/tool_rules.rs, src/write_scope.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-perms--<module>.rs
//     bsc graph impl set --id bsc-perms--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-perms--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));