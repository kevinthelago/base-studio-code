//! `bsc say` — speech as a command surface rather than a UI capability.
//!
//! Two halves, split so the decisions are testable without a sound card: [`voice`] is pure (which
//! engine, what rate, what argv) and [`cli`] is everything that probes the machine or spawns a
//! process. The pure half is where the failures that matter live — a provider substituted without
//! saying so, a rate mapped onto the wrong scale, or spoken text reaching something that parses it.

pub mod cli;
pub mod kokoro;
pub mod voice;
