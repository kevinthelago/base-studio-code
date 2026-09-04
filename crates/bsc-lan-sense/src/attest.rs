//! Turning a local verdict into the claim that goes on the wire.
//!
//! Kept as its own small module because it is the exact point where a rich,
//! carefully-hedged local judgement gets flattened into something other
//! machines will act on. Flattening is where hedges get lost -- an `Unknown`
//! quietly becoming a clean green is the failure this whole design is built to
//! avoid -- so the mapping is total, explicit, and tested in all three
//! directions rather than written as a convenient `impl From` nobody reads.

use crate::posture::Posture;
use crate::procnet::{Protocol, Socket};
use bsc_lan_stream::frame::{AttestedPosture, ExposedSocket};

fn describe(s: &Socket) -> ExposedSocket {
    ExposedSocket {
        transport: match s.transport {
            Protocol::Tcp => "tcp".to_string(),
            Protocol::Udp => "udp".to_string(),
        },
        addr: s.local_addr.clone(),
        port: s.local_port,
    }
}

/// Flatten a local [`Posture`] into the wire [`AttestedPosture`].
///
/// Every arm is written out: no wildcard, so a new `Posture` variant fails to
/// compile here rather than silently taking some neighbouring meaning on the
/// wire.
pub fn attest(p: &Posture) -> AttestedPosture {
    match p {
        Posture::Sealed { loopback_listeners, rows_examined } => AttestedPosture::Sealed {
            loopback_listeners: loopback_listeners.len() as u32,
            rows_examined: *rows_examined as u32,
        },
        Posture::Exposed { reachable, rows_examined } => AttestedPosture::Exposed {
            reachable: reachable.iter().map(describe).collect(),
            rows_examined: *rows_examined as u32,
        },
        // The reason travels with it. A subscriber that only learns "unknown"
        // cannot tell a permissions problem from a kernel format change, and
        // those call for very different responses.
        Posture::Unknown { reason } => AttestedPosture::Unknown { reason: reason.to_string() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ProcNetError;
    use crate::procnet::{Reach, Role};

    fn sock(port: u16, reach: Reach) -> Socket {
        Socket {
            transport: Protocol::Tcp,
            role: Role::Inbound,
            reach,
            local_port: port,
            local_addr: "0.0.0.0".to_string(),
        }
    }

    #[test]
    fn a_sealed_verdict_carries_its_evidence_count_onto_the_wire() {
        let a = attest(&Posture::Sealed {
            loopback_listeners: vec![sock(631, Reach::Loopback)],
            rows_examined: 37,
        });
        assert_eq!(a, AttestedPosture::Sealed { loopback_listeners: 1, rows_examined: 37 });
    }

    #[test]
    fn an_exposed_verdict_names_every_reachable_socket() {
        let a = attest(&Posture::Exposed {
            reachable: vec![sock(22, Reach::Wildcard), sock(8080, Reach::Routable)],
            rows_examined: 40,
        });
        match a {
            AttestedPosture::Exposed { reachable, rows_examined } => {
                assert_eq!(rows_examined, 40);
                assert_eq!(reachable.len(), 2);
                assert_eq!(reachable[0].port, 22);
                assert_eq!(reachable[1].port, 8080);
            }
            AttestedPosture::Sealed { .. } => panic!("expected Exposed, got Sealed"),
            AttestedPosture::Unknown { reason } => panic!("expected Exposed, got Unknown({reason})"),
        }
    }

    #[test]
    fn an_unknown_verdict_keeps_its_reason_so_subscribers_can_act_on_it() {
        let a = attest(&Posture::Unknown {
            reason: ProcNetError::Unreadable {
                path: "/proc/net/tcp".into(),
                reason: "Permission denied".into(),
            },
        });
        match a {
            AttestedPosture::Unknown { reason } => {
                assert!(reason.contains("/proc/net/tcp"), "reason lost the path: {reason}");
                assert!(reason.contains("Permission denied"), "reason lost the cause: {reason}");
            }
            AttestedPosture::Sealed { .. } => panic!("expected Unknown, got Sealed"),
            AttestedPosture::Exposed { .. } => panic!("expected Unknown, got Exposed"),
        }
    }

    /// The property the whole design rests on, asserted at the flattening
    /// boundary as well as at the source: nothing that was not Sealed locally
    /// may become Sealed on the wire.
    #[test]
    fn no_uncertain_verdict_can_become_sealed_on_the_wire() {
        let uncertain = [
            Posture::Unknown { reason: ProcNetError::Empty },
            Posture::Unknown {
                reason: ProcNetError::PartiallyUnderstood { rows_seen: 9, rows_parsed: 0 },
            },
            Posture::Exposed { reachable: vec![sock(22, Reach::Wildcard)], rows_examined: 1 },
        ];
        for p in &uncertain {
            assert!(
                !attest(p).is_sealed(),
                "{p:?} was flattened into a sealed claim on the wire"
            );
        }
    }
}
