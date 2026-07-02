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

pub mod cli;
