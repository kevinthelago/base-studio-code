//! `bsc-teams` — the teams-specific shim over the shared `bsc-json-store` (#2158). The user teams store
//! (`~/.base-studio-code/orgs/<id>.json`, #2193/#2700, an instance of #1325) is a verbatim-JSON-per-id
//! file store; the store CRUD + the `list/get/set/remove` CLI live once in [`bsc_json_store`], and this
//! crate supplies only the teams-specific nouns + lean `list` fields. (The on-disk store directory keeps
//! its `orgs/` name — a rename would orphan existing users' saved data — while the crate + CLI verb are
//! now "teams", #2700.)
//!
//! A **team** is a named composition of PERSONAS as **positions** wired by **relationships** — the
//! persona-relationship graph. Each relationship is an archetype (Manages / Serves / Oversees /
//! Consults / Peers / Stewards) that expands into directed **communication forms** (Directive /
//! Escalation / Decision / Report / Request / Consult / Review / Handoff). It is the store the desktop
//! Team designer and every live console session + the planner share: the desktop UI reaches it through
//! the generic `bsc` command (`bsc teams …`, over the #2114 bridge; `bsc org` remains a deprecated
//! alias), and a session's own shell reaches the same store through the [`cli`] module — so the planner
//! can compose a fleet's interaction topology the same way it mints a persona. Packaged (built-in) teams
//! are seeded into this store on first hydrate + kept reconciled by the frontend, exactly like the user
//! persona/blueprint libraries.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-teams--<module>.rs
//     bsc graph impl set --id bsc-teams--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-teams--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));