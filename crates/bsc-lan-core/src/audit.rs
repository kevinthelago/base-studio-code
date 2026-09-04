//! `AuditEvent`: what was done to which target, by whom, and what happened.
//! Never the content of anyone's traffic -- see `data-retention-and-purge`'s
//! audit exemption, which depends on that separation holding.
//!
//! This type defines the shape; writing it durably (`bsc-lan-store`),
//! mirroring it to Loki, and broadcasting it on the event bus are other
//! streams' jobs.

use std::time::SystemTime;

use crate::action::Action;
use crate::actor::Actor;
use crate::target::Target;

/// What happened when an action was attempted.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum AuditOutcome {
    /// Read-back confirmed the action took effect.
    Succeeded,
    /// Refused before any adapter was constructed (never-touch, tier,
    /// rate limit, or a structural refusal).
    Refused { reason: String },
    /// An adapter attempted the action but could not verifiably confirm
    /// it; per the fail-closed rule this is reported as failure, never as
    /// partial success.
    Failed { reason: String },
}

/// One row of the audit trail: an action, who caused it, what it targeted,
/// and what happened -- audited with the same fidelity whether it
/// succeeded, was refused, or failed, and whether a human, the investigator
/// or the automation caller was behind it.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AuditEvent {
    pub action_name: String,
    pub actor: Actor,
    pub target: Option<Target>,
    pub outcome: AuditOutcome,
    pub occurred_at: SystemTime,
    /// The dry-run-style rendering of the action's arguments
    /// ([`Action::render`]), kept as text since the audit row must stay
    /// readable independently of whether the `Action` enum shape it
    /// describes still exists in a future version of this crate.
    pub detail: String,
}

impl AuditEvent {
    pub fn from_action(
        action: &Action,
        actor: Actor,
        outcome: AuditOutcome,
        occurred_at: SystemTime,
    ) -> Self {
        Self {
            action_name: action.name().to_string(),
            actor,
            target: action.target(),
            detail: action.render(),
            outcome,
            occurred_at,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusal_is_audited_as_carefully_as_success() {
        let action = crate::action::Action::RebootHost {
            host: "gateway.lan".parse().unwrap(),
        };
        let event = AuditEvent::from_action(
            &action,
            Actor::Principal,
            AuditOutcome::Refused {
                reason: String::from("never-touch: gateway.lan"),
            },
            SystemTime::UNIX_EPOCH,
        );
        assert_eq!(event.action_name, "reboot_host");
        assert!(matches!(event.outcome, AuditOutcome::Refused { .. }));
        assert!(event.target.is_some());
    }
}
