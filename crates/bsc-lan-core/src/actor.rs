//! `Actor`: minimal attribution vocabulary shared by [`crate::proposal`] and
//! [`crate::audit`].
//!
//! This is deliberately narrow. Resolving a real caller (an SSH session, a
//! Telegram user, a paired browser) to one of these values, and enforcing
//! what each may do, is `identity-tiers-and-device-pairing` and
//! `policy-engine-and-never-touch-enforcement`'s job -- this crate only
//! needs a closed set of values to attribute "who raised this" and "who did
//! this" on its own types.

use std::fmt;

/// Who or what caused a proposal to be raised or an action to execute.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Actor {
    /// An unrecognised or minimally-trusted caller. A strict subset of
    /// Tier 0 (see the policy-engine contract): even most Tier 0 endpoints
    /// are refused to guest.
    Guest,
    /// An authenticated human below principal.
    Operator,
    /// The fully-trusted human identity. Required for every Tier 2 action.
    Principal,
    /// The LLM investigator. May raise a Tier 1 proposal; can never
    /// execute one.
    Investigator,
    /// The fixed, unattended scheduler identity. May execute only its
    /// fixed assurance job set and is never reachable from the LLM tool
    /// registry.
    Automation,
}

impl fmt::Display for Actor {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Actor::Guest => "guest",
            Actor::Operator => "operator",
            Actor::Principal => "principal",
            Actor::Investigator => "investigator",
            Actor::Automation => "automation",
        };
        write!(f, "{s}")
    }
}
