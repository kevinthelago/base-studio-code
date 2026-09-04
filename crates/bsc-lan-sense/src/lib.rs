//! Sensor-side observation for `bsc lan`: what the emit-only monitor Pi can
//! see about itself, and can therefore tell anyone.
//!
//! The Pi accepts nothing inbound and is updated by swapping its SD card, so
//! every claim about its security posture has to come from the Pi itself, over
//! the one channel it has. That constraint shapes this whole crate: the
//! parsing is a PURE function over text ([`procnet`]) so it can be tested
//! exhaustively from fixtures, and the verdict ([`posture`]) refuses to
//! conclude anything it cannot justify from rows it actually understood.
#![forbid(unsafe_code)]

pub mod attest;
pub mod emit;
pub mod error;
pub mod estate;
pub mod eve;
pub mod posture;
pub mod receive;
pub mod rf;
pub mod run;
pub mod spectrum;
pub mod procnet;
pub mod transport;

pub use attest::attest;
pub use emit::{nonce_for, Emitter, SnapshotPolicy};
pub use transport::{Transport, UdpMulticast};
pub use error::ProcNetError;
pub use estate::{assess as assess_estate, Estate, SeenHost};
pub use eve::{parse_line, EveCounters, EveError, Parsed};
pub use receive::{MulticastReceiver, Tick};
pub use run::{RateLimit, RunCounters, SensorRun};
pub use posture::{assess, Posture};
pub use procnet::{parse_table, Protocol, Reach, Role, Socket, Table};

/// The four tables a Linux host exposes. Read together, because a listener in
/// any one of them is a way in.
pub const PROC_NET_TABLES: [(&str, Protocol); 4] = [
    ("/proc/net/tcp", Protocol::Tcp),
    ("/proc/net/tcp6", Protocol::Tcp),
    ("/proc/net/udp", Protocol::Udp),
    ("/proc/net/udp6", Protocol::Udp),
];

/// Read and assess the live host. The only function here that touches the
/// filesystem; everything it depends on is pure and separately tested.
pub fn assess_host() -> Posture {
    let tables: Vec<_> = PROC_NET_TABLES
        .iter()
        .map(|(path, transport)| {
            std::fs::read_to_string(path)
                .map_err(|e| ProcNetError::Unreadable {
                    path: (*path).to_string(),
                    reason: e.to_string(),
                })
                .and_then(|text| parse_table(&text, *transport))
        })
        .collect();
    assess(&tables)
}
