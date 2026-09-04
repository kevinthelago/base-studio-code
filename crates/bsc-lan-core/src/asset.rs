//! `AssetIdentity`: MAC is not a stable identity. Several household phones
//! randomise their MAC, so identity has to be a correlated, confidence-
//! scored bundle rather than a single key, and any device known to
//! randomise has to say so everywhere it appears rather than claim a
//! continuity the evidence does not support.

use std::fmt;
use std::net::IpAddr;

use crate::primitives::{Hostname, MacAddr};

/// How much this system currently trusts that the correlated identifiers
/// below refer to one real device. Represented as a bounded float rather
/// than a coarse enum so a scoring function (owned by
/// `asset-and-device-identity-tools`) can tighten or loosen its threshold
/// through configuration without a breaking type change here.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize)]
pub struct Confidence(f32);

#[derive(Debug, Clone, Copy, PartialEq, thiserror::Error)]
#[error("confidence must be in 0.0..=1.0, got {0}")]
pub struct ConfidenceError(f32);

impl Confidence {
    pub fn new(value: f32) -> Result<Self, ConfidenceError> {
        if (0.0..=1.0).contains(&value) && !value.is_nan() {
            Ok(Self(value))
        } else {
            Err(ConfidenceError(value))
        }
    }

    /// No correlation performed yet; distinct from a low score, which would
    /// imply correlation was attempted and came up weak.
    pub fn unknown() -> Self {
        Self(0.0)
    }

    pub fn get(&self) -> f32 {
        self.0
    }
}

/// Whether this device's identifiers are expected to stay put over time.
/// Carried on every [`AssetIdentity`] and surfaced wherever the device is
/// mentioned, so neither the UI nor a model response asserts a presence
/// continuity the evidence does not support.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum IdentityStability {
    /// Consistently observed with the same MAC.
    Stable,
    /// Observed rotating through locally-administered MACs (the classic
    /// phone-privacy-MAC pattern).
    Randomizing,
    /// Not enough history to say either way.
    Unknown,
}

impl fmt::Display for IdentityStability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            IdentityStability::Stable => "stable",
            IdentityStability::Randomizing => "randomizing",
            IdentityStability::Unknown => "unknown",
        };
        write!(f, "{s}")
    }
}

/// A DHCP fingerprint (e.g. the option-55 parameter request list), kept as
/// descriptive text for correlation and display. This is informational
/// metadata, never an adapter argument, so it does not need the same
/// typed-value treatment as [`crate::target::Target`] fields.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct DhcpFingerprint(pub String);

/// A correlated device identity: the MACs, hostnames and IPs this system
/// believes belong to one physical device, with an explicit confidence and
/// stability marker rather than an assumed one-to-one MAC mapping.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct AssetIdentity {
    /// The MAC currently believed to be primary, if any correlation has
    /// been made at all.
    pub primary_mac: Option<MacAddr>,
    /// Every MAC correlated to this identity, oldest first. Has more than
    /// one entry exactly when `identity_stability` is `Randomizing`.
    pub mac_history: Vec<MacAddr>,
    pub dhcp_fingerprint: Option<DhcpFingerprint>,
    pub hostname_history: Vec<Hostname>,
    pub ip_history: Vec<IpAddr>,
    pub confidence: Confidence,
    pub identity_stability: IdentityStability,
}

impl AssetIdentity {
    /// A device seen for the first time with no correlation performed: raw
    /// identifiers only, `Confidence::unknown()`, stability `Unknown`. This
    /// is the "returned as unknown with its raw identifiers" shape the
    /// asset-tools contract requires rather than a forced nearest-neighbour
    /// match.
    pub fn unresolved(mac: MacAddr) -> Self {
        Self {
            primary_mac: Some(mac),
            mac_history: vec![mac],
            dhcp_fingerprint: None,
            hostname_history: Vec::new(),
            ip_history: Vec::new(),
            confidence: Confidence::unknown(),
            identity_stability: IdentityStability::Unknown,
        }
    }

    /// Whether this identity is known to randomise, and therefore must not
    /// be asserted to have a continuous presence history.
    pub fn is_randomizing(&self) -> bool {
        matches!(self.identity_stability, IdentityStability::Randomizing)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confidence_bounds_are_enforced() {
        assert!(Confidence::new(-0.1).is_err());
        assert!(Confidence::new(1.1).is_err());
        assert!(Confidence::new(f32::NAN).is_err());
        assert!(Confidence::new(0.0).is_ok());
        assert!(Confidence::new(1.0).is_ok());
    }

    #[test]
    fn unresolved_asset_is_unknown_not_forced() {
        let mac: MacAddr = "aa:bb:cc:dd:ee:ff".parse().unwrap();
        let asset = AssetIdentity::unresolved(mac);
        assert_eq!(asset.confidence, Confidence::unknown());
        assert_eq!(asset.identity_stability, IdentityStability::Unknown);
        assert!(!asset.is_randomizing());
    }
}
