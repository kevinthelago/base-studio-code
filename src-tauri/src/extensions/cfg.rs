//! The extension wire types — RE-EXPORTED from `crates/bsc-resolve`.
//!
//! They moved with the resolution that produces them
//! (`the-resolution-decisions-live-in-the-app-binary-not-a-crate`): a payload type owned by a
//! different crate from the decision that fills it is the shape that lets the two drift.

pub(crate) use bsc_resolve::cfg::{HookCfg, McpServerCfg, SkillCfg};
