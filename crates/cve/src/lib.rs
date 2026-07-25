//! The CVE / vulnerability data layer for base-studio-code (supply-chain #2433, #3797).
//!
//! Queries [OSV.dev](https://osv.dev) — free, key-less, one schema across every ecosystem the fleet
//! installs — for the advisories affecting a package/version or a whole lockfile, caching results in
//! SQLite so a repeat scan is fast + offline-friendly. Reachable from any live session as `bsc cve …`
//! (the [`cli`]) and the `bsc mcp cve` server (the [`mcp::Server`]). This is the DATA layer the
//! install-time `bsc-supply` hook (a later #2433 slice) builds on.
//!
//! Layering: [`types`] is the normalized model (Ecosystem/Package/Severity/Advisory + OSV mapping);
//! [`osv`] is the one network seam (the [`osv::VulnSource`] trait + the OSV client); [`cache`] is the
//! SQLite result cache with a TTL; [`lockfile`] parses manifests into packages; [`engine`] is the
//! cache-first query logic; [`cli`] + [`mcp`] are the two session-facing surfaces over it.

pub mod cache;
pub mod cli;
pub mod engine;
pub mod install;
pub mod lockfile;
pub mod mcp;
pub mod osv;
pub mod types;

pub use engine::Engine;
pub use types::{Advisory, Ecosystem, Package, PackageReport, ScanReport, Severity};
