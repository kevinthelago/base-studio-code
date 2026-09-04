//! The USE layer's data — what a network can DO, as opposed to what it is building.
//!
//! # The three layers, and why this one needed a type of its own
//!
//! The STORE layer (components, algorithms, sounds, data) holds what the app builds FROM. The BUILD
//! layer (the fleet, Glance) holds what is being built. Neither can answer "what has this network
//! finished, and can I drive it now" — a project row says a thing exists, not that it works.
//!
//! A CAPABILITY IS NOT A PROJECT. A project is a unit of work; a capability is a unit of use. The same
//! project is both at different times, and what separates them is LIVE STATE rather than a field
//! somebody remembered to set.
//!
//! # Freshness is the load-bearing part
//!
//! Live state rendered without its observation time is how `docs/llm-operator/context.md` in the
//! network-monitor repo drifted for seven weeks and pointed a local model at a dead host and a Loki
//! that had moved — while reading, at a glance, exactly as authoritative as the day it was written.
//! Nothing about a stale fact looks stale.
//!
//! So an observation carries WHEN, every read applies a budget, and a capability past its budget
//! renders as UNKNOWN rather than as its last value. That direction is deliberate: "I do not know" is
//! recoverable and "it was fine an hour ago, presented as now" is not.
//!
//! # One source, two consumers
//!
//! The same read serializes as CONTEXT for a network's root session and renders as the use-layer
//! screen. That is the whole reason this is data first and a screen second — a screen built first
//! invents a shape, and the session then gets a second copy of it, and the two drift. There is a test
//! pinning that the two views come from one value.


pub use freshness::{Freshness, Observation};
pub use model::{Capability, CapabilityKind, NetworkCapabilities, ProjectCapabilities};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/freshness.rs, src/model.rs, src/read.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-capability--<module>.rs
//     bsc graph impl set --id bsc-capability--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-capability--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));