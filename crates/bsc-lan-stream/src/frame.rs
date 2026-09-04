//! What the encrypted payload actually says.
//!
//! Kept deliberately small. The sensor's telemetry vocabulary is not settled
//! and does not belong to the wire contract; what belongs here is the
//! delta/snapshot distinction the recovery story depends on.

use crate::error::WireError;
use std::collections::BTreeMap;

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
}

/// The sensor's complete state, restated periodically so a subscriber that
/// missed deltas becomes whole again without asking for anything.
#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct SensorState {
    /// Monotonic counters keyed by name, e.g. alerts by severity.
    pub counters: BTreeMap<String, u64>,
    /// Alerts the sensor still considers active.
    pub active_alerts: Vec<Event>,
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
            monotonic_us: 91_000_000,
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
