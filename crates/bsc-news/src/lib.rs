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

pub mod cli;
pub mod engine;
pub mod entities;
pub mod gazetteer;
pub mod http;
pub mod outlets;
pub mod signals;
pub mod sources;
pub mod store;
pub mod types;

pub use types::{ArticleVersion, Bloc, FeedItem, FeedKind, Outlet, OutletKind, Span};
