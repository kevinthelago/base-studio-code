//! Why a datagram was refused.
//!
//! Every variant names a distinct refusal so a subscriber can tell a hostile
//! datagram from a merely stale one -- and so an operator reading a counter
//! knows whether they have a network problem or an attacker.

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum WireError {
    #[error("datagram is {got} bytes, over the {max}-byte limit -- it would have to fragment, and one lost fragment discards the whole datagram on a stream with no retransmission")]
    TooLarge { got: usize, max: usize },

    #[error("datagram is {got} bytes but a well-formed one needs at least {need}")]
    Truncated { got: usize, need: usize },

    #[error("not a bsc-lan datagram (bad magic)")]
    BadMagic,

    #[error("wire version {0} is not implemented by this subscriber; refusing to guess at the layout")]
    UnsupportedVersion(u8),

    #[error("unknown datagram kind byte {0}")]
    UnknownKind(u8),

    #[error("plaintext is {got} bytes, over the {max}-byte budget for one datagram")]
    PayloadTooLarge { got: usize, max: usize },

    #[error("signature does not verify against the sensor's public key -- the datagram was forged or corrupted in flight")]
    BadSignature,

    #[error("payload did not decrypt under the group key")]
    Undecryptable,

    #[error("payload is not valid stream JSON: {0}")]
    MalformedPayload(String),
}

/// Why a datagram was not accepted into a subscriber's view of the stream.
///
/// Distinct from [`WireError`]: these datagrams are cryptographically genuine.
/// They are refused for *sequencing* reasons, which is an ordering problem
/// rather than a security one -- except [`Replay`](SequenceError::Replay),
/// which is both.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SequenceError {
    #[error("sequence {seq} was already seen (last accepted {last}) -- a replay or a duplicated datagram")]
    Replay { seq: u64, last: u64 },
}
