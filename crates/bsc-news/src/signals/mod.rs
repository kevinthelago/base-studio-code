//! The digest signals.
//!
//! Every one of them is **computed, not narrated**: a pure function over stored article text that
//! reports counts alongside the [`Span`](crate::types::Span)s that produced them. No model runs
//! here, and that is the crate's central constraint rather than a stage not yet reached — a digest
//! whose findings cannot be checked against the text has replaced one opaque narrator with another,
//! which is the thing this layer exists to expose.

pub mod agency;
pub mod corroborate;
pub mod framing;
