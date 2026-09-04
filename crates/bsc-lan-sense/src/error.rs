//! Why the sensor could not determine its own posture.
//!
//! Every variant exists so the answer can be "I could not tell", which is the
//! only honest alternative to a verdict. A posture check with no error type
//! has nowhere to put its uncertainty and will invent a clean result instead.

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ProcNetError {
    #[error("the table was empty -- not even a header line")]
    Empty,

    #[error("unrecognised table header ({0:?}) -- the kernel format changed and this parser is no longer reading it, so its silence means nothing")]
    UnrecognisedHeader(String),

    #[error("could not decode address field {0:?}")]
    BadAddress(String),

    #[error("could not read {path}: {reason}")]
    Unreadable { path: String, reason: String },

    #[error("read {rows_seen} row(s) but understood only {rows_parsed} -- refusing to draw a conclusion from a table this parser has stopped matching")]
    PartiallyUnderstood { rows_seen: usize, rows_parsed: usize },
}
