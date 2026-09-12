//! `bsc ear` — the listening half of the local voice loop.
//!
//! Always-on rather than push-to-talk, deliberately: the value is catching the half-formed thought
//! you did not know to record, and push-to-talk only ever captures what you already decided was
//! worth capturing. That inverts the usual privacy posture, so the bound on what is kept is not a
//! README paragraph — [`retention`] is a pure function and its guard runs against a synthetic
//! over-budget directory.
//!
//! The two modules here hold everything interesting and neither needs a microphone to test:
//! [`segment`] decides what is speech from frame energies alone, and [`retention`] decides what may
//! be kept. Capture and the daemon are plumbing around them.

pub mod audio;
pub mod cli;
pub mod capture;
pub mod chain;
pub mod clean;
pub mod deepfilternet;
pub mod embed;
pub mod classify;
pub mod liveness;
pub mod prosody;
pub mod store;
pub mod stream;
pub mod retention;
pub mod transcribe;
pub mod transcript;
pub mod segment;
pub mod detect;
pub mod diarize;
pub mod imprint;
pub mod tunnel;
pub mod room;
