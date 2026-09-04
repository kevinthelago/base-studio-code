//! `Proposal`: the record that carries an [`Action`] from being raised
//! through to execution.
//!
//! Recording the action's typed arguments at raise time -- not re-deriving
//! them at approval -- is what makes `evidence()` safe despite the
//! investigator never executing anything: approving at any point inside the
//! PCAP ring window replays the exact same coordinates. The state machine
//! transitions themselves (which moves are legal, and their side effects)
//! are `proposal-lifecycle-dry-run-and-undo`'s job (`src/lifecycle/**`);
//! this type only defines the shape both that crate and every caller of it
//! (raising a proposal from the LLM, the investigator or a human) build
//! against.

use std::time::SystemTime;

use crate::action::Action;
use crate::actor::Actor;

/// Where a [`Proposal`] sits in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProposalState {
    /// Stored with its full spec and coordinates; not yet approved.
    Raised,
    /// A dry-run rendering has been produced and is available to review.
    DryRunAvailable,
    /// Approved by a caller with sufficient tier; not yet executing.
    Approved,
    /// Adapter dispatch is in flight.
    Executing,
    /// Executed and read-back verified.
    Executed,
    /// Execution did not verifiably succeed.
    Failed,
    /// Never approved (or approved-but-unexecuted) before its window
    /// closed.
    Expired,
    /// Executed, then reverted via `undo`.
    Undone,
}

/// A raised action together with its lifecycle state and who raised it.
/// `action` is the frozen spec and coordinates -- approval executes exactly
/// this value, never a re-derived one.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Proposal {
    pub action: Action,
    pub raised_by: Actor,
    pub raised_at: SystemTime,
    pub state: ProposalState,
}

impl Proposal {
    /// A freshly-raised proposal. Always starts in [`ProposalState::Raised`]
    /// -- there is no constructor that starts elsewhere, so a proposal
    /// cannot be fabricated as already-approved.
    pub fn raise(action: Action, raised_by: Actor, raised_at: SystemTime) -> Self {
        Self {
            action,
            raised_by,
            raised_at,
            state: ProposalState::Raised,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raised_proposals_start_in_the_raised_state() {
        let p = Proposal::raise(
            crate::action::Action::Health,
            Actor::Operator,
            SystemTime::UNIX_EPOCH,
        );
        assert_eq!(p.state, ProposalState::Raised);
        assert_eq!(p.raised_by, Actor::Operator);
    }
}
