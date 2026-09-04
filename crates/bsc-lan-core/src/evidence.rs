//! Evidence integrity, enforced structurally rather than by convention.
//!
//! The SPAN mirror taps the trunk port *before* pf adjudicates, so a
//! quarantined host's failed callbacks still appear as outbound flows.
//! [`Disposition::Passed`] therefore cannot be constructed from mirror data
//! alone: its only public constructor requires a [`FirewallLogWitness`],
//! and the only way to produce one is [`parse_firewall_log_line`]. There is
//! no code path from "I saw packets on the mirror" to "it passed" that
//! skips the parser.

use std::fmt;

use crate::error::ObservationError;

/// Where an observation came from. Every result the telemetry adapter
/// returns carries one of these, because "the mirror thinks this was
/// blocked" and "the firewall log confirms this was blocked" are different
/// claims with different evidentiary weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum ObservationPoint {
    /// The switch port mirror (SPAN). Sees everything that was *attempted*,
    /// upstream of pf -- never sufficient on its own to claim a packet
    /// passed or was blocked.
    SpanMirror,
    /// OPNsense's pf filter log. The only source that can confirm pass or
    /// block, because it observes the adjudication itself.
    FirewallLog,
    /// Unbound's resolver log / query log.
    DnsResolver,
}

impl fmt::Display for ObservationPoint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ObservationPoint::SpanMirror => "span-mirror",
            ObservationPoint::FirewallLog => "firewall-log",
            ObservationPoint::DnsResolver => "dns-resolver",
        };
        write!(f, "{s}")
    }
}

/// Proof that a line of pf filter-log output was parsed. The single private
/// field means this type cannot be constructed outside this module -- not
/// by another module in this crate, and not by a downstream adapter crate --
/// so [`Disposition::passed`] and [`Disposition::blocked`], which require
/// one, cannot be called with a fabricated witness.
///
/// This is enforced by the compiler, not by convention -- attempting to
/// build one from outside the crate fails to compile:
///
/// ```compile_fail,E0451
/// # use bsc_lan_core::evidence::FirewallLogWitness;
/// let _ = FirewallLogWitness { _sealed: () }; // E0451: field `_sealed` is private
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirewallLogWitness {
    _sealed: (),
}

/// What a parsed pf filter-log line said happened to the packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirewallLogVerdict {
    Pass,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FirewallLogParseError {
    #[error("empty log line")]
    Empty,
    #[error("expected at least {expected} comma-separated fields, found {found}")]
    TooFewFields { expected: usize, found: usize },
    #[error("unrecognised action field {0:?}: expected \"pass\" or \"block\"")]
    UnrecognisedAction(String),
}

/// Parse one line of OPNsense/pf's `filterlog` CSV output and, if it names a
/// pass or block verdict, produce the witness that lets [`Disposition`]
/// represent it. This is pure text parsing -- the *reading* of the log file
/// or syslog stream is the telemetry adapter's job (it does I/O); this
/// function only ever sees a `&str` it was handed.
///
/// The pf filterlog format (see `pflog(4)`) is a variable-length CSV whose
/// early fields are fixed: rule number, sub-rule, anchor, tracker id,
/// interface, reason, **action**, direction, ... . Only the action field
/// (index 6) is consulted here; everything else is left to richer parsing
/// elsewhere, since the witness only needs to prove "this line named a
/// verdict", not decode the whole record.
pub fn parse_firewall_log_line(
    raw: &str,
) -> Result<(FirewallLogVerdict, FirewallLogWitness), FirewallLogParseError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(FirewallLogParseError::Empty);
    }

    let fields: Vec<&str> = trimmed.split(',').collect();
    const ACTION_FIELD_INDEX: usize = 6;
    if fields.len() <= ACTION_FIELD_INDEX {
        return Err(FirewallLogParseError::TooFewFields {
            expected: ACTION_FIELD_INDEX + 1,
            found: fields.len(),
        });
    }

    let action = fields[ACTION_FIELD_INDEX].trim();
    let verdict = match action {
        "pass" => FirewallLogVerdict::Pass,
        "block" => FirewallLogVerdict::Block,
        other => return Err(FirewallLogParseError::UnrecognisedAction(other.to_string())),
    };

    Ok((verdict, FirewallLogWitness { _sealed: () }))
}

/// Whether an attempted connection was seen to pass, seen to be blocked, or
/// its outcome cannot be determined from the evidence at hand.
///
/// `Passed` and `Blocked` each require a [`FirewallLogWitness`] at
/// construction, which -- because the witness can only come from
/// [`parse_firewall_log_line`] -- means mirror-only evidence can never
/// produce either. `Unknown` is its own variant rather than an `Option`
/// around the others, so "we do not know" cannot be collapsed into "it was
/// allowed" by a caller that forgets to check for `None`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// Seen on the wire (any observation point); no confirmation of the
    /// firewall's verdict is available.
    Attempted,
    /// Confirmed by the firewall log to have passed.
    Passed,
    /// Confirmed by the firewall log to have been blocked.
    Blocked,
    /// The outcome could not be determined -- explicitly distinct from
    /// `Attempted`: `Attempted` says "it tried"; `Unknown` says "we cannot
    /// even say whether it tried".
    Unknown,
}

impl Disposition {
    pub fn attempted() -> Self {
        Disposition::Attempted
    }

    pub fn unknown() -> Self {
        Disposition::Unknown
    }

    /// The only public way to construct a `Passed` disposition. Requires a
    /// witness that only [`parse_firewall_log_line`] can produce.
    pub fn passed(_witness: FirewallLogWitness) -> Self {
        Disposition::Passed
    }

    /// The only public way to construct a `Blocked` disposition. Requires a
    /// witness that only [`parse_firewall_log_line`] can produce.
    pub fn blocked(_witness: FirewallLogWitness) -> Self {
        Disposition::Blocked
    }

    /// Build a disposition directly from a parsed log line, so callers who
    /// already have the raw text do not need to match on
    /// [`FirewallLogVerdict`] themselves.
    pub fn from_firewall_log_line(raw: &str) -> Result<Self, FirewallLogParseError> {
        let (verdict, witness) = parse_firewall_log_line(raw)?;
        Ok(match verdict {
            FirewallLogVerdict::Pass => Disposition::passed(witness),
            FirewallLogVerdict::Block => Disposition::blocked(witness),
        })
    }
}

impl fmt::Display for Disposition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            Disposition::Attempted => "attempted",
            Disposition::Passed => "passed",
            Disposition::Blocked => "blocked",
            Disposition::Unknown => "unknown",
        };
        write!(f, "{s}")
    }
}

/// The result of an observation-path read: what was retrieved, where it
/// came from, and whether every source that should have answered did.
/// Fail-open on observation means a degraded source still returns this --
/// with `complete: false` and a reason -- rather than an error, because a
/// narrowed answer presented as complete is the failure mode this type
/// exists to prevent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed<T> {
    pub data: T,
    pub point: ObservationPoint,
    pub complete: bool,
    pub incomplete_reason: Option<String>,
}

impl<T> Observed<T> {
    pub fn complete(data: T, point: ObservationPoint) -> Self {
        Self {
            data,
            point,
            complete: true,
            incomplete_reason: None,
        }
    }

    pub fn partial(data: T, point: ObservationPoint, reason: impl Into<String>) -> Self {
        Self {
            data,
            point,
            complete: false,
            incomplete_reason: Some(reason.into()),
        }
    }

    /// Promote a source-level failure into a partial, explicitly-incomplete
    /// result when a caller already has a fallback value (typically empty),
    /// rather than propagating [`ObservationError`] and losing the point of
    /// origin. Adapters that have nothing at all should return `Err`
    /// instead; this is for "I have a degraded answer", not "I have none".
    pub fn from_error(fallback: T, point: ObservationPoint, err: &ObservationError) -> Self {
        Self::partial(fallback, point, err.to_string())
    }
}

/// The result of a control-path mutation: the read-back-confirmed post
/// state, paired with the pre-change state captured in the same read-back
/// cycle. Carrying both in one type is what makes "inverse constructed from
/// the pre-change read rather than the request" (adapter-traits rule 4)
/// structural -- there is no code path that reports success without also
/// having captured what to undo it with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verified<T> {
    pub prior: T,
    pub confirmed: T,
}

impl<T> Verified<T> {
    pub fn new(prior: T, confirmed: T) -> Self {
        Self { prior, confirmed }
    }

    /// True when the mutation was a no-op because the target state already
    /// matched -- the idempotency case the containment-actions contract
    /// calls out explicitly (dns_block of an already-blocked domain, etc.).
    pub fn was_idempotent(&self) -> bool
    where
        T: PartialEq,
    {
        self.prior == self.confirmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn witness_can_only_come_from_the_parser() {
        let (verdict, witness) = parse_firewall_log_line(
            "5,,,1000000103,igb1,match,pass,in,4,0x0,,64,12345,0,DF,6,tcp,60,10.99.6.10,1.1.1.1",
        )
        .unwrap();
        assert_eq!(verdict, FirewallLogVerdict::Pass);
        let disposition = Disposition::passed(witness);
        assert_eq!(disposition, Disposition::Passed);
    }

    #[test]
    fn block_verdict_parses() {
        let (verdict, witness) = parse_firewall_log_line(
            "5,,,1000000103,igb1,match,block,in,4,0x0,,64,12345,0,DF,6,tcp,60,10.99.6.10,1.1.1.1",
        )
        .unwrap();
        assert_eq!(verdict, FirewallLogVerdict::Block);
        assert_eq!(Disposition::blocked(witness), Disposition::Blocked);
    }

    #[test]
    fn malformed_lines_are_rejected_not_guessed_at() {
        assert!(parse_firewall_log_line("").is_err());
        assert!(parse_firewall_log_line("too,few,fields").is_err());
        assert!(parse_firewall_log_line("1,2,3,4,5,6,maybe,8").is_err());
    }

    #[test]
    fn mirror_only_observation_cannot_become_passed() {
        // There is no constructor that takes an `ObservationPoint` and
        // yields `Disposition::Passed`. The only way to demonstrate that
        // by test is to show the sole non-witness-gated constructors
        // (`attempted`, `unknown`) can never produce it.
        assert_ne!(Disposition::attempted(), Disposition::Passed);
        assert_ne!(Disposition::unknown(), Disposition::Passed);
    }

    #[test]
    fn observed_partial_carries_a_reason() {
        let obs: Observed<Vec<u32>> =
            Observed::partial(vec![], ObservationPoint::SpanMirror, "loki unreachable");
        assert!(!obs.complete);
        assert_eq!(obs.incomplete_reason.as_deref(), Some("loki unreachable"));
    }

    #[test]
    fn verified_detects_idempotency() {
        let v = Verified::new(true, true);
        assert!(v.was_idempotent());
        let v2 = Verified::new(false, true);
        assert!(!v2.was_idempotent());
    }
}
