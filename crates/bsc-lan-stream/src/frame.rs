//! What the encrypted payload actually says.
//!
//! Kept deliberately small. The sensor's telemetry vocabulary is not settled
//! and does not belong to the wire contract; what belongs here is the
//! delta/snapshot distinction the recovery story depends on.

use crate::error::WireError;
use std::collections::BTreeMap;

/// One socket the sensor can see is reachable from the network. Rendered as
/// text rather than typed addresses: this is a wire format read by many
/// subscribers, and a stable string outlives an address type.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ExposedSocket {
    pub transport: String,
    pub addr: String,
    pub port: u16,
}

/// What the sensor says about its own reachability.
///
/// The monitor Pi accepts nothing inbound and is updated by swapping its SD
/// card, so nobody can log in to check whether it is still sealed. This is how
/// that fact travels: attested by the sensor, in every snapshot, over the only
/// channel it has.
///
/// [`Unknown`](AttestedPosture::Unknown) is the `Default` DELIBERATELY. A
/// `SensorState` that nobody populated must never claim to be sealed -- an
/// unset field and a verified-clean box would otherwise be identical on the
/// wire, which is the same silent-pass failure the parser guards against.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AttestedPosture {
    /// Nothing on the sensor is reachable from the network.
    Sealed {
        /// Listeners bound only to loopback: visible, but not a way in.
        loopback_listeners: u32,
        /// How many socket rows justified the verdict. A `Sealed` from zero
        /// rows is a broken parser, not a clean box, and carrying the count is
        /// what lets a subscriber tell those two apart.
        rows_examined: u32,
    },
    /// At least one socket is reachable. The state the design exists to prevent.
    Exposed {
        reachable: Vec<ExposedSocket>,
        rows_examined: u32,
    },
    /// The sensor could not determine its posture. NOT a pass -- on a box that
    /// cannot be inspected any other way, "I cannot tell" is alertable.
    Unknown { reason: String },
}

impl Default for AttestedPosture {
    fn default() -> Self {
        AttestedPosture::Unknown {
            reason: "no attestation recorded".to_string(),
        }
    }
}

impl AttestedPosture {
    pub fn is_sealed(&self) -> bool {
        match self {
            AttestedPosture::Sealed { .. } => true,
            AttestedPosture::Exposed { .. } | AttestedPosture::Unknown { .. } => false,
        }
    }
}

/// One observation from the sensor.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Event {
    /// A Suricata alert.
    Alert { sid: u32, msg: String, src: String, dst: String, severity: u8 },
    /// A rolled-up flow record. Rolled up rather than per-packet because the
    /// sensor is thermally saturated and the link is multicast.
    Flow { src: String, dst: String, proto: String, bytes: u64 },
    /// The sensor describing itself -- temperature, drops, uptime. On an
    /// emit-only device this is the ONLY way its health is ever observable,
    /// since nothing can poll it.
    Health { uptime_s: u64, soc_temp_c: f32, capture_drops: u64 },
    /// A deauthentication or disassociation flood.
    ///
    /// Carries everything a reaction needs, because the sensor is emit-only
    /// and there is NO back channel on which a subscriber could ask a
    /// follow-up question. Which client, which claimed BSSID, the rate, and
    /// the window it was measured over.
    ///
    /// Every string here is bounded at construction: a MAC is 17 characters,
    /// and `reasons` is capped. That is not tidiness — the addresses come from
    /// frames the ATTACKER transmits, so an unbounded field would let a crafted
    /// frame produce an event too large to emit, silencing the sensor for
    /// exactly the attack it is reporting. The same shape as the EVE bounds.
    RfDeauthFlood {
        /// `true` for a flood, `false` for merely elevated — a subscriber may
        /// reasonably act on one and only log the other.
        flood: bool,
        frames: u32,
        broadcast_frames: u32,
        window_ms: u64,
        /// Frames per second scaled by 100, so the wire carries no float.
        rate_centi_per_s: u64,
        /// Spoofable, and named so in the field docs rather than implied.
        claimed_bssid: String,
        top_target: String,
        distinct_targets: u32,
        reasons: Vec<u16>,
    },
    /// What the radio heard on one channel, for a band view rendered
    /// elsewhere. Derived from frames, so it sees WiFi activity and not
    /// non-WiFi energy — a microwave or a jammer that radiates without
    /// emitting valid frames is invisible here, and that needs spectral FFT.
    RfChannelActivity {
        freq_mhz: u32,
        frames: u32,
        /// Signal strength in dBm, as radiotap reports it (negative).
        rssi_min_dbm: i16,
        rssi_max_dbm: i16,
        rssi_mean_dbm: i16,
    },
    /// The sensor's reachability changed. Emitted as its own event rather than
    /// waiting for the next snapshot, because a box that just became reachable
    /// is the one thing worth interrupting for.
    PostureChanged { from: AttestedPosture, to: AttestedPosture },
}

/// The sensor's complete state, restated periodically so a subscriber that
/// missed deltas becomes whole again without asking for anything.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct SensorState {
    /// Monotonic counters keyed by name, e.g. alerts by severity.
    pub counters: BTreeMap<String, u64>,
    /// Alerts the sensor still considers active.
    pub active_alerts: Vec<Event>,
    /// What the sensor can currently say about its own reachability. Present
    /// in every snapshot so the claim is continuously re-made rather than
    /// asserted once at boot and assumed forever after.
    pub posture: AttestedPosture,
    /// Monotonic microseconds since boot. NOT wall clock: an emit-only sensor
    /// can never run NTP, because NTP needs a reply. Subscribers anchor this
    /// to wall clock on receipt using their own good time.
    pub monotonic_us: u64,
}

/// The decrypted payload.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Frame {
    Delta(Event),
    Snapshot(SensorState),
}

impl Frame {
    pub fn encode(&self) -> Result<Vec<u8>, WireError> {
        serde_json::to_vec(self).map_err(|e| WireError::MalformedPayload(e.to_string()))
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, WireError> {
        serde_json::from_slice(bytes).map_err(|e| WireError::MalformedPayload(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delta_round_trips() {
        let f = Frame::Delta(Event::Alert {
            sid: 2010935,
            msg: "ET SCAN Potential SSH Scan".into(),
            src: "10.99.4.66".into(),
            dst: "10.99.2.1".into(),
            severity: 2,
        });
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
    }

    #[test]
    fn a_snapshot_round_trips() {
        let mut counters = BTreeMap::new();
        counters.insert("alerts.sev1".to_string(), 3u64);
        let f = Frame::Snapshot(SensorState {
            counters,
            active_alerts: vec![Event::Health { uptime_s: 91, soc_temp_c: 89.6, capture_drops: 0 }],
            posture: AttestedPosture::Sealed { loopback_listeners: 1, rows_examined: 37 },
            monotonic_us: 91_000_000,
        });
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
    }

    #[test]
    fn an_rf_deauth_flood_round_trips_on_the_wire() {
        let f = Frame::Delta(Event::RfDeauthFlood {
            flood: true,
            frames: 40,
            broadcast_frames: 40,
            window_ms: 10_000,
            rate_centi_per_s: 400,
            claimed_bssid: "aa:bb:cc:dd:ee:ff".into(),
            top_target: "ff:ff:ff:ff:ff:ff".into(),
            distinct_targets: 1,
            reasons: vec![7, 1],
        });
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
    }

    #[test]
    fn rf_channel_activity_round_trips_on_the_wire() {
        let f = Frame::Delta(Event::RfChannelActivity {
            freq_mhz: 2437,
            frames: 812,
            rssi_min_dbm: -91,
            rssi_max_dbm: -34,
            rssi_mean_dbm: -67,
        });
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
    }

    #[test]
    fn an_unpopulated_sensor_state_never_claims_to_be_sealed() {
        // The default must be the SAFE answer, not the convenient one: an
        // unset field and a verified-clean box would otherwise look identical.
        let s = SensorState::default();
        assert!(!s.posture.is_sealed());
        assert!(matches!(s.posture, AttestedPosture::Unknown { .. }));
    }

    #[test]
    fn a_posture_change_round_trips_on_the_wire() {
        let f = Frame::Delta(Event::PostureChanged {
            from: AttestedPosture::Sealed { loopback_listeners: 1, rows_examined: 42 },
            to: AttestedPosture::Exposed {
                reachable: vec![ExposedSocket {
                    transport: "tcp".into(),
                    addr: "0.0.0.0".into(),
                    port: 22,
                }],
                rows_examined: 43,
            },
        });
        assert_eq!(Frame::decode(&f.encode().unwrap()).unwrap(), f);
    }

    #[test]
    fn garbage_is_refused_rather_than_partially_parsed() {
        assert!(matches!(
            Frame::decode(b"{not json"),
            Err(WireError::MalformedPayload(_))
        ));
        assert!(matches!(Frame::decode(b""), Err(WireError::MalformedPayload(_))));
    }
}
