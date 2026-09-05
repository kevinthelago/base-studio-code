//! `bsc lan` — the command surface for the emit-only LAN sensor.
//!
//! DENY rather than FORBID, for exactly one module. `capture` opens an
//! AF_PACKET socket, which std does not expose, so it carries a scoped
//! `#[allow(unsafe_code)]` with a SAFETY note per call. `forbid` cannot be
//! overridden anywhere, which would mean either no capture at all or the
//! unsafe living in a crate that has no business holding a file descriptor —
//! and the narrower blast radius is one audited module here.
#![deny(unsafe_code)]

#[allow(unsafe_code)]
pub mod capture;
pub mod cli;
pub mod unit;
