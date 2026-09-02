//! Which skills a session receives — RE-EXPORTED from `crates/bsc-resolve`.
//!
//! The decision moved out of this binary on
//! `the-resolution-decisions-live-in-the-app-binary-not-a-crate`. It was pure — the only couplings to
//! the app were `crate::skills_db()`, twice — and while it lived here, changing it meant a new binary
//! and a restarted window with a fleet in it.
//!
//! This module survives as a SHIM so no call site or test had to change with the move, and so the two
//! store lookups the crate now takes as arguments still have exactly one place that answers them.

// EXACTLY what this binary uses, not the crate's whole surface. A shim that re-exports names nobody
// calls is dead weight the compiler warns about, and it invites the belief that the app is the way to
// reach this logic. Everything else — `session_skill_state`, `SkillReason`, `SkillReconciliation` —
// is on `bsc_resolve::skill`, and `bsc resolve skills` is how you ask without the app running.
pub use bsc_resolve::skill::{
    effective_session_skills, reconcile_session_skills, to_skill_cfgs, SessionSkillOverride, SkillDef,
};

/// The library, read from the store Rust already owns.
///
/// The crate takes the path; this is the one place that knows which path the APP means. A missing or
/// unreadable store yields an EMPTY library — safe only because the caller UNIONS with the list the
/// renderer sent (see [`reconcile_session_skills`]), so the floor is what the frontend resolved and
/// never "no skills". A caller that replaces instead of unioning must not use this.
pub fn library() -> Vec<SkillDef> {
    bsc_resolve::skill::library(&crate::skills_db())
}

/// Expand toggled-on skill GROUPS into the skill ids they carry.
pub fn group_skill_ids(group_ids: &[String]) -> Vec<String> {
    bsc_resolve::skill::group_skill_ids(&crate::skills_db(), group_ids)
}
