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

pub mod crypto;
pub mod envelope;
pub mod error;
pub mod frame;
pub mod liveness;
pub mod sequence;

pub use envelope::{Envelope, Kind, MAX_DATAGRAM_BYTES, MAX_PLAINTEXT_BYTES};
pub use error::{SequenceError, WireError};
pub use frame::{AttestedPosture, Event, ExposedSocket, Frame, SensorState};
pub use liveness::{Cadence, Liveliness, Watch};
pub use sequence::{Completeness, Reception, Tracker};
