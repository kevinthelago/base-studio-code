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


#[cfg(test)]
mod tests {
    use bsc_json_store::Store;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A per-test unique suffix so parallel tests never share a base dir.
    fn uniq() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// #2986 (epic #2982) regression: the persona store persists to a SQLite **`personas.db`**, NOT to
    /// per-id `personas/<id>.json` files. #2983 migrated the shared `bsc-json-store` backend
    /// JSON-files → SQLite transparently; `bsc-persona` rides it over `bsc_json_store::Store` with
    /// segment `personas` / noun `persona` (the [`cli::SPEC`](crate::cli) config). This pins that a
    /// round-trip write/read through the persona store leaves a `<base>/personas.db` and creates no
    /// `<base>/personas/<id>.json`.
    ///
    /// The crate exposes no base-dir-injectable persona API (only the `bsc persona` CLI), so — per the
    /// #2986 spec — it drives the shared `Store` directly with the persona store's own segment + noun.
    #[test]
    fn persona_store_persists_to_sqlite_not_json_files() {
        // A fresh temp base — the `~/.base-studio-code` root the persona store lives under.
        let base = std::env::temp_dir().join(format!("bsc-persona-sqlite-{}", uniq()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // The persona store exactly as its CLI configures it (mirrors `cli::SPEC.dir_segment` / `.noun`).
        let store = Store::new(base.join("personas"), "persona");

        // Round-trip: write a persona, read it back verbatim (and via list).
        let persona = r#"{"id":"review-bot","name":"Review Bot","role":"reviewer"}"#;
        store.set("review-bot", persona).unwrap();
        assert_eq!(
            store.get("review-bot").unwrap().as_deref(),
            Some(persona),
            "the persona reads back verbatim",
        );
        assert_eq!(store.list(), vec![persona.to_string()], "and lists from the db");

        // The claim — SQLite, not files: the sibling `<base>/personas.db` exists after the write…
        let db = base.join("personas.db");
        assert!(db.is_file(), "personas.db exists after the write: {}", db.display());
        // …and NO legacy per-id file (nor even the `personas/` dir) was created.
        let legacy = base.join("personas").join("review-bot.json");
        assert!(!legacy.exists(), "no per-id json file was written: {}", legacy.display());
        assert!(
            !base.join("personas").exists(),
            "no file-based `personas/` store dir was created",
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}

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

#[cfg(test)]
mod view_tests {
    use super::*;

    /// The view fields are OPTIONAL on the wire, and that has to stay true.
    ///
    /// `whatami` answers a session that may be running against an older app (the CLI and the app are
    /// separate binaries, and a `bsc` on PATH outlives the build that shipped it). An ack from an app
    /// that predates these fields must still deserialize — otherwise adding an observability field
    /// breaks the verb an agent uses to find out what it is, which is the worst possible thing to
    /// break with a diagnostic.
    #[test]
    fn an_ack_without_the_view_still_deserializes() {
        let old = r#"{"paneId":"p","role":"designer"}"#;
        let res: WhatamiResult = serde_json::from_str(old).expect("an older app's ack must parse");
        assert_eq!(res.role.as_deref(), Some("designer"));
        assert!(res.viewing.is_none() && res.workspace.is_none() && res.page_tab.is_none());
    }

    /// ...and an absent view is OMITTED rather than serialized as null.
    ///
    /// `viewing: null` reads as "the app answered, and the answer is nothing"; an absent key reads as
    /// "unknown". They are different states — a workspace with no tab selected yet is the first, a
    /// stale app is the second — and the CLI prints the line only when it has something to say.
    #[test]
    fn an_absent_view_is_omitted_not_nulled() {
        let json = serde_json::to_string(&WhatamiResult {
            pane_id: "p".into(),
            role: Some("designer".into()),
            ..Default::default()
        })
        .unwrap();
        assert!(!json.contains("viewing"), "absent view must not appear at all: {json}");
        assert!(!json.contains("null"), "no field should serialize as null: {json}");
    }

    /// The wire name is `pageTab`, not `page_tab` — the frontend sends camelCase.
    #[test]
    fn the_tab_field_crosses_as_camel_case() {
        let res: WhatamiResult =
            serde_json::from_str(r#"{"paneId":"p","viewing":"Components — React","pageTab":"react"}"#)
                .expect("the frontend's camelCase ack must parse");
        assert_eq!(res.page_tab.as_deref(), Some("react"));
        assert_eq!(res.viewing.as_deref(), Some("Components — React"));
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/baseline.rs, src/floor.rs, src/packaged.rs do not exist — they are records in the
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