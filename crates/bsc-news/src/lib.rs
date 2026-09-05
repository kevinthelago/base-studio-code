//! Low-trust news ingestion — the visibility layer over what outlets publish.
//!
//! **This is deliberately not [`research`].** That crate holds citable sources; this one holds
//! *claims*. An [`Article`](types::ArticleVersion) earns nothing by existing — its value comes from
//! being corroborated against other articles and from the framing it reveals when set beside them.
//! The two stores stay separate and there is no verb that converts one into the other, because
//! letting an outlet's assertion enter a plan with a paper's authority is the exact failure this
//! layer exists to expose.
//!
//! Layering, mirroring the research crate: [`sources`] hold per-format *pure parsers*
//! (fixture-tested, no network) plus thin fetch entry points; [`http`] is the only place that
//! touches the network; [`store`] retains **every fetched version** so a stealth edit stays
//! observable and first-seen ordering survives; [`signals`] are pure functions that compute the
//! digest; and [`engine`] ties them into the two things [`cli`] exposes — poll and brief.
//!
//! The constraint that shapes all of it: **every number is computed and carries the span that
//! produced it.** No model runs in this crate.


pub use types::{ArticleVersion, Bloc, FeedItem, FeedKind, Outlet, OutletKind, Span};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/engine.rs, src/entities.rs, src/gazetteer.rs, src/http.rs, src/outlets.rs, src/signals/mod.rs, src/signals/agency.rs, src/signals/corroborate.rs, src/signals/framing.rs, src/sources/mod.rs, src/sources/rss.rs, src/sources/sitemap.rs, src/store.rs, src/types.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-news--<module>.rs
//     bsc graph impl set --id bsc-news--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-news--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));