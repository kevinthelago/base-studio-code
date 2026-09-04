//! The one-way multicast wire contract for `bsc lan`'s emit-only sensor.
//!
//! The monitor Pi accepts nothing inbound and emits exactly one thing: a
//! multicast UDP telemetry stream. This crate is what goes on that wire, and
//! nothing else -- there is no socket here, no filesystem and no async
//! runtime, the same split [`bsc-tunnel`] draws between its protocol and its
//! transport. That is what lets every property be tested on a laptop with no
//! sensor hardware.
//!
//! ## The three decisions worth knowing before reading the code
//!
//! **Multicast, so the sensor holds no subscriber state.** Every device the
//! operator owns should be able to subscribe and share responsibility for
//! reacting to intrusions. One emission serves all of them, and the sensor
//! never learns who is listening -- which is the only workable arrangement for
//! a device that cannot receive anything.
//!
//! **Two keys, not one** ([`crypto`]). A group key gives confidentiality; an
//! Ed25519 signature gives authenticity. With a shared key alone, any
//! subscriber could forge sensor alerts -- and the design gets less
//! trustworthy with every device added, which is precisely backwards.
//!
//! **Snapshots instead of retransmission** ([`sequence`]). UDP loses
//! datagrams and there is no channel to ask for them again, so the sensor
//! periodically restates its whole state. A subscriber detects the gap
//! exactly, marks itself [`Degraded`](sequence::Completeness::Degraded), and
//! is made whole by the next snapshot on its own.
//!
//! [`bsc-tunnel`]: https://example.invalid
#![forbid(unsafe_code)]


pub use envelope::{Envelope, Kind, MAX_DATAGRAM_BYTES, MAX_PLAINTEXT_BYTES};
pub use error::{SequenceError, WireError};
pub use frame::{AttestedPosture, Event, ExposedSocket, Frame, SensorState};
pub use liveness::{Cadence, Liveliness, LivelinessKind, Watch};
pub use sequence::{Completeness, Reception, Tracker};
pub use subscription::{Finding, Rejections, Subscription};

// This crate's modules are IN THE GRAPH, not in this directory.
// src/crypto.rs, src/envelope.rs, src/error.rs, src/frame.rs, src/liveness.rs, src/sequence.rs, src/subscription.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-lan-stream--<module>.rs
//     bsc graph impl set --id bsc-lan-stream--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-lan-stream--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));