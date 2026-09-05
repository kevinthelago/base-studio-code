//! `bsc-persona` — the persona-specific shim over the shared `bsc-json-store` (#2158). The user
//! persona store (`~/.base-studio-code/personas/<id>.json`, #2094, an instance of #1325) is a
//! verbatim-JSON-per-id file store; the store CRUD + the `list/get/set/remove` CLI now live once in
//! [`bsc_json_store`], and this crate supplies only the persona-specific nouns + lean `list` fields.
//!
//! A **persona** is the CRUD-able behavioral identity of an agent — a start prompt + attached skills +
//! default model, running under a referenced ROLE (its permission floor). It is the one store the
//! desktop Personas library and every live console session + the planner share: the desktop UI reaches
//! it through the generic `bsc` command (`bsc persona …`, over the #2114 bridge), and a session's own
//! shell reaches the same store through the [`cli`] module — so the planner can mint a persona the same
//! way it mints a skill. Packaged (built-in) personas are seeded into this store on first hydrate + kept
//! reconciled by the frontend, exactly like the user blueprint library.



use serde::{Deserialize, Serialize};

/// `bsc persona use` — the routing key for "change which persona a pane runs as".
///
/// Its own key, for the reason `fleet-wake` has one: this is not a question Rust can answer. The
/// assignment lives in the frontend store (`panePersonas`), so the verb is an emit-and-ack round trip
/// through [`bsc_appchan`] rather than a pure-Rust read.
pub const USE_KIND: &str = "persona-use";

/// Ask the app to run a pane as a different persona.
///
/// ## Why a relaunch is the default
/// A persona is the LAUNCH primitive — capability, MCP servers and hooks are all resolved from it when
/// the session starts. Rewriting `panePersonas` under a running session therefore changes nothing the
/// agent can observe, and a caller who saw a success would reasonably believe otherwise. So the verb
/// relaunches by default and says which it did; `--no-relaunch` is for staging an identity that the
/// next launch will pick up.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseRequest {
    /// The pane to change. Identity-keyed (`<project>:<stream>`), the same grammar `bsc fleet` uses.
    pub pane_id: String,
    /// The persona id to run as — validated against the store BEFORE anything is killed.
    pub persona_id: String,
    /// Restart the session so the new identity is actually in effect. Default true; the CLI's
    /// `--no-relaunch` clears it.
    pub relaunch: bool,
    /// Relaunch even when the pane is BUSY. A relaunch kills the PTY, so interrupting work in flight
    /// is a deliberate act rather than a default — the same rule `fleet wake` applies.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// What actually happened — including what the pane used to be, so a change is reversible from the
/// output alone rather than requiring the caller to have looked first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UseResult {
    pub pane_id: String,
    pub persona_id: String,
    /// The persona the pane was running as, or `None` if it carried none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous: Option<String>,
    /// Whether the session was restarted. False under `--no-relaunch`, where the identity applies at
    /// the next launch.
    pub relaunched: bool,
    /// Whether the pane had work in flight — only ever true alongside `force`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub was_busy: bool,
}

/// `bsc persona whatami` — the READ beside [`USE_KIND`]'s write.
///
/// Its own key for the same reason: the answer lives in the app's `panePersonas` / `paneRoles`, so it
/// is an emit-and-ack round trip rather than something Rust can answer.
pub const WHATAMI_KIND: &str = "persona-whatami";

/// Ask the app what a pane is running as.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatamiRequest {
    /// The pane to describe. The CLI defaults this to `$BSC_AUDIT_PANE`, which every session carries,
    /// so an agent can simply run `bsc persona whatami` without knowing its own id.
    pub pane_id: String,
}

/// What a pane is running as.
///
/// Every field past `pane_id` is optional on purpose: a pane with no persona is a REAL state (a plain
/// interactive console), not an error, and reporting the role alone is the truthful answer rather than
/// inventing an identity for it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatamiResult {
    pub pane_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub persona_name: Option<String>,
    /// The session role the capability gate is applied from — the field that answers "what am I
    /// allowed to do". Absent for a pane that never launched with one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The persona's own start prompt, when it has one — what the agent was told to be.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_prompt: Option<String>,
    /// WHAT THE USER IS LOOKING AT, worded as the titlebar words it: `Components — React — bsc-kit`.
    ///
    /// A studio's launch prompt names its technology and stops there — coarse (a technology holds
    /// many kits), and fixed at launch while the tab is not. The studios whose axis is not technology
    /// run ONE session across every value, so their prompt can never name the current one. Told to
    /// "simplify the graph", the designer had to ask which one; this is the answer it could not see.
    ///
    /// Built by the app's own `locationCrumb` — the same function the titlebar renders — so the
    /// session is told exactly what is on screen rather than a second opinion about it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewing: Option<String>,
    /// The rail destination being rendered (`components`, `algorithms`, `teams`, `data`, `sounds`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    /// The active tab id — the graph's own AXIS VALUE (a technology, a team, a kit, a language).
    /// The structured half of [`Self::viewing`], for a session that acts on it rather than prints it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_tab: Option<String>,
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/baseline.rs, src/cli.rs, src/floor.rs, src/packaged.rs, src/tests.rs, src/view_tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-persona--<module>.rs
//     bsc graph impl set --id bsc-persona--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-persona--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-persona--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));