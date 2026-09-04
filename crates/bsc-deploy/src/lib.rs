//! `bsc deploy` — push a binary to a device, verify it on the far end, and be able to take it back.
//!
//! # Why push, and never pull
//!
//! This is forced by the network, not chosen for taste. LAB (VLAN 6) is egress-denied by design —
//! `lumpy-space` can answer but can never reach out — so a device can never fetch its own update. The
//! workstation pushes over SSH, and no device needs inbound internet for a deploy to work.
//!
//! # Verification happens on the DESTINATION
//!
//! A local checksum proves the bytes you made, not the bytes that arrived. `docs/backup-and-restore.md`
//! already states this rule for backups; a deploy has exactly the same failure mode and it matters more,
//! because a half-written binary on the monitor Pi is the whole network going blind.
//!
//! # The shape on the device
//!
//! ```text
//! ~/.bsc-deploy/
//!   bin/<name>-<sha256>     content-addressed; the sha IS the version
//!   current  -> bin/…       what runs
//!   previous -> bin/…       what ran before, so a rollback needs no network
//! ```
//!
//! Content addressing means a redeploy of identical bytes is a no-op the planner can SEE, rather than
//! a restart nobody needed. `previous` is a local symlink, so **rollback never depends on the link to
//! the workstation still being up** — which is the state you are most likely in when you need it.
//!
//! # The health probe is the point
//!
//! Swapping a symlink always "succeeds". The only question that matters is whether the thing you
//! shipped actually RUNS on that machine, so the probe executes the new binary on the device. That is
//! what catches an architecture mismatch, a glibc that is too old, and a truncated transfer — three
//! failures that every other step reports as fine.
//!
//! A failed probe reverts and says so. It never exits green.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/plan.rs, src/remote.rs, src/roster.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-deploy--<module>.rs
//     bsc graph impl set --id bsc-deploy--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-deploy--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));