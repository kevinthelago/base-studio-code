//! The two distinct error families: control paths fail closed, observation
//! paths fail open. Using the wrong one for a given adapter method is a type
//! error, not a code-review nit -- see `contracts/adapter-traits.md` rule 2.

use std::time::Duration;

/// An error on a control (mutating) path. Every variant means "this action
/// did not verifiably succeed" -- there is no partial-success case, because
/// [`crate::evidence`]'s read-back-is-part-of-the-write rule means an
/// adapter either confirms the change or reports failure, never "probably".
#[derive(Debug, thiserror::Error)]
pub enum ControlError {
    #[error("target is on the never-touch list: {0}")]
    NeverTouch(String),

    #[error("read-back verification failed: expected {expected}, observed {observed}")]
    ReadBackMismatch { expected: String, observed: String },

    #[error("operation timed out after {0:?}")]
    Timeout(Duration),

    #[error("target unreachable: {0}")]
    Unreachable(String),

    #[error("refused: {0}")]
    Refused(String),

    #[error("result was ambiguous and cannot be reported as success: {0}")]
    Ambiguous(String),

    #[error("a concurrent change was detected: {0}")]
    ConcurrentModification(String),

    #[error("precondition failed: {0}")]
    PreconditionFailed(String),
}

/// An error on an observation (read) path. This family never claims total
/// failure for a partial result -- a degraded source should be reported via
/// [`crate::evidence::Observed::partial`], not this type. `ObservationError`
/// is for the read that could not produce *any* usable answer at all.
#[derive(Debug, thiserror::Error)]
pub enum ObservationError {
    #[error("source unavailable: {source_name}")]
    SourceUnavailable { source_name: String },

    #[error("outside the retention window: {0}")]
    OutsideWindow(String),

    #[error("malformed data from {source_name}: {reason}")]
    Malformed { source_name: String, reason: String },

    #[error("query rejected: {0}")]
    InvalidQuery(String),
}
