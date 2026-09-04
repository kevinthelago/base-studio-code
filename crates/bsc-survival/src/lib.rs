//! `bsc survival` — the caveman network's offline survival corpus.
//!
//! Two kinds of record, because the two questions asked in the field are different shapes: a
//! **procedure** is a thing you DO with materials (stop a bleed, boil water, start a fire), and a
//! **remedy** is a thing that GROWS with a medicinal function (an antiseptic, a clotting agent, an
//! analgesic). Both live in a packaged corpus of reviewable JSON, seeded into a store on this machine
//! that a person extends with what they learned on their own ground.
//!
//! # Why a store and not a document
//!
//! The two lookups that matter are INVERSE ones a document cannot serve. "What can I make with what
//! is in my hands" runs from materials to procedures; "what growing here stops bleeding" crosses
//! function with location. Both are queries over rows. The document is then the OUTPUT —
//! [`engine::Engine::compile`] renders the whole corpus as one markdown field manual — which is also
//! what keeps the printed copy and the queryable one from drifting apart.
//!
//! # Safety is in the data model
//!
//! [`types::Procedure::limits`] (what a method does NOT do) and [`types::Remedy::lookalikes`] (with
//! the tell that separates a plant from the thing that kills you) are required fields, pinned by
//! `seed`'s guards. The failure mode of a corpus like this is a confident half-truth read by somebody
//! who cannot check it, and a schema that cannot state a limit is a schema that omits one.
//!
//! # Local
//!
//! No verb here reaches the network. The corpus is packaged, the store is on this machine, and the
//! whole point of the surface is that it answers when nothing else does.
//!
//! Layering: [`types`] is the model (pure data + serde); [`seed`] is the packaged corpus; [`store`]
//! is the user-owned SQLite source of truth; [`engine`] is the query + render logic; [`cli`] is the
//! `bsc survival` surface.

pub mod cli;
pub mod engine;
pub mod seed;
pub mod store;
pub mod types;

pub use types::{Category, Function, Procedure, Remedy};
