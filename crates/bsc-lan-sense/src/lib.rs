//! Sensor-side observation for `bsc lan`: what the emit-only monitor Pi can
//! see about itself, and can therefore tell anyone.
//!
//! The Pi accepts nothing inbound and is updated by swapping its SD card, so
//! every claim about its security posture has to come from the Pi itself, over
//! the one channel it has. That constraint shapes this whole crate: the
//! parsing is a PURE function over text ([`procnet`]) so it can be tested
//! exhaustively from fixtures, and the verdict ([`posture`]) refuses to
//! conclude anything it cannot justify from rows it actually understood.


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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/attest.rs, src/config.rs, src/emit.rs, src/emitloop.rs, src/error.rs, src/estate.rs, src/eve.rs, src/posture.rs, src/receive.rs, src/rf.rs, src/run.rs, src/spectrum.rs, src/procnet.rs, src/transport.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-lan-sense--<module>.rs
//     bsc graph impl set --id bsc-lan-sense--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-lan-sense--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-lan-sense--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));