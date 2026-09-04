//! The sensor's verdict on its own reachability.
//!
//! ## Why this is attested rather than inspected
//!
//! The monitor Pi accepts nothing inbound and is updated by physically
//! swapping its SD card. Nobody can log in to run `ss -ltnp`, and nothing can
//! poll it. So if the box grows a listening socket -- a package update, a
//! debug daemon left running, a compromise -- there is no channel through
//! which anyone would ever learn that, unless the sensor says so itself.
//!
//! It therefore reports its own posture into the multicast stream, in every
//! snapshot. Subscribers watch for a posture that DEGRADES, and for
//! attestation that STOPS: a sensor gone quiet looks exactly like a sensor
//! taken off the network, and only somebody watching for the silence can tell.
//!
//! ## The one rule that matters most
//!
//! **A check that cannot read reports [`Posture::Unknown`], never
//! [`Posture::Sealed`].** A parser that has silently stopped matching finds no
//! listeners, which is indistinguishable on any dashboard from a properly
//! hardened box. Every path here carries the row counts that justify its
//! conclusion, and refuses to conclude when they do not add up.

use crate::error::ProcNetError;
use crate::procnet::{Socket, Table};

/// What the sensor can say about its own reachability.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Posture {
    /// Nothing on this box can be reached from the network.
    Sealed {
        /// Loopback listeners, recorded because they are worth seeing even
        /// though they are not a way in.
        loopback_listeners: Vec<Socket>,
        /// How many rows justified this verdict. A `Sealed` derived from zero
        /// rows is not a clean box, it is a broken parser -- and carrying the
        /// number is what lets a subscriber tell those apart.
        rows_examined: usize,
    },
    /// At least one socket is reachable from the network. This is the state
    /// the whole emit-only design exists to prevent.
    Exposed {
        reachable: Vec<Socket>,
        rows_examined: usize,
    },
    /// The sensor could not determine its posture. NOT a pass.
    Unknown { reason: ProcNetError },
}

impl Posture {
    /// True only for a verdict that actually justified itself.
    pub fn is_sealed(&self) -> bool {
        match self {
            Posture::Sealed { .. } => true,
            Posture::Exposed { .. } | Posture::Unknown { .. } => false,
        }
    }

    /// Whether this posture warrants waking somebody. `Unknown` does, which is
    /// the point: not knowing is an alertable condition on a box that cannot
    /// be inspected any other way.
    pub fn needs_attention(&self) -> bool {
        match self {
            Posture::Sealed { .. } => false,
            Posture::Exposed { .. } | Posture::Unknown { .. } => true,
        }
    }
}

/// Draw a verdict from every table the sensor managed to read.
///
/// Any table that failed makes the whole verdict [`Posture::Unknown`]: a
/// conclusion drawn from three of four tables is a conclusion about three of
/// four tables, and the missing one is exactly where a listener would hide.
pub fn assess(tables: &[Result<Table, ProcNetError>]) -> Posture {
    if tables.is_empty() {
        return Posture::Unknown { reason: ProcNetError::Empty };
    }

    let mut rows_examined = 0usize;
    let mut reachable = Vec::new();
    let mut loopback_listeners = Vec::new();

    for table in tables {
        let table = match table {
            Err(e) => return Posture::Unknown { reason: e.clone() },
            Ok(t) => t,
        };

        // A row seen but not understood is the silent-failure case. Refuse
        // rather than quietly assessing the subset that happened to parse.
        if table.rows_parsed != table.rows_seen {
            return Posture::Unknown {
                reason: ProcNetError::PartiallyUnderstood {
                    rows_seen: table.rows_seen,
                    rows_parsed: table.rows_parsed,
                },
            };
        }

        rows_examined += table.rows_parsed;
        for s in &table.sockets {
            if s.is_network_reachable_inbound() {
                reachable.push(s.clone());
            } else if matches!(s.role, crate::procnet::Role::Inbound) {
                loopback_listeners.push(s.clone());
            }
        }
    }

    if reachable.is_empty() {
        Posture::Sealed { loopback_listeners, rows_examined }
    } else {
        Posture::Exposed { reachable, rows_examined }
    }
}
