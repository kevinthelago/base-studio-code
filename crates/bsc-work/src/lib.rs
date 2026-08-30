//! `bsc work` — the seam between a branch's GIT state and its PLAN record
//! (#the-gate-does-not-record-its-own-evidence-so-a-session-transcribes-it).
//!
//! ## Why a noun for this
//!
//! Not permissions. `src-tauri/data/permissions/base.json` puts `git` in the same 3-command mandatory
//! tier as `bsc`, so every role can already run git unprompted — the argument that carries
//! `record-operations-belong-on-the-bsc-surface-not-in-scripts` does not apply here.
//!
//! What applies is that the plan record and the git state are kept in agreement BY HAND, with values
//! copied between them. Measured over five slices in one session: each one's gate results were read
//! off a terminal and retyped as `bsc plan change gate <ref> <leg> <result>`, and each merge sha was
//! copy-pasted out of `bsc plan integrate` into `bsc plan change status --command`. About twenty-five
//! hand-transcribed judgements, every one a place where the record can disagree with what happened.
//!
//! The change record is meant to be EVIDENCE — `crates/plandb/src/changes.rs` says so in as many
//! words. Transcription makes it a claim.
//!
//! ## Slice one is the gate
//!
//! [`gate`] runs the real gate, streams its output untouched, and records each leg from the artifact
//! the gate itself writes. The gate stays an npm script: it is a build-tree operation, and the
//! scripts-to-`bsc` epic already puts it in the KEEP bucket. What moves here is the RECORDING.

pub mod cli;
pub mod gate;
