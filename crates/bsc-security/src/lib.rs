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


pub use engine::Engine;
pub use finding::{Finding, Kind, Locator};
pub use types::{Advisory, Ecosystem, Package, PackageReport, ScanReport, Severity};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cache.rs, src/finding.rs, src/secrets.rs, src/security_cli.rs, src/cli.rs, src/engine.rs, src/install.rs, src/lockfile.rs, src/mcp.rs, src/osv.rs, src/types.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-security--<module>.rs
//     bsc graph impl set --id bsc-security--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-security--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-security--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));