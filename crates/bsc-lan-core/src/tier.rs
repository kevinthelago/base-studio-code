//! The action risk/approval tier.

use std::fmt;

/// How much authorisation an [`crate::action::Action`] requires before it may
/// execute, and how it is gated once it does.
///
/// * `Zero` -- read-only observation. Guest is a strict subset of this tier
///   (see the policy engine contract); everything else is refused for guest.
/// * `One` -- reversible, boundable actions. No principal-only gate, but
///   still policy-checked, rate-limited and circuit-broken. A subset of
///   these install revocable state on a target and therefore require a
///   [`crate::ttl::Ttl`] via [`crate::action::TimeBoundedAction`] --
///   see [`crate::action::Action::requires_ttl`].
/// * `Two` -- principal-only. Requires the target typed or re-selected at
///   approval time; never auto-approved.
///
/// There is no `Three`: the catalog has no destructive, no-inverse action
/// (delete is explicitly not built -- disable is the only removal path),
/// so a tier for it would be dead code with nothing to classify. Add it
/// only alongside the first action that actually needs it.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub enum Tier {
    Zero,
    One,
    Two,
}

impl fmt::Display for Tier {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Tier::Zero => "tier0",
            Tier::One => "tier1",
            Tier::Two => "tier2",
        };
        write!(f, "{s}")
    }
}
