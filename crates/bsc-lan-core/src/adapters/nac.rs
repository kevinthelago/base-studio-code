//! [`NacAdapter`]: FreeRADIUS users and the MAC-auth mapping. Implemented
//! by `bsc-lan-adapter-nac`.

use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::MacAddr;
use crate::primitives::VlanId;

/// One entry in the FreeRADIUS MAC-auth mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NacMappingEntry {
    pub mac: MacAddr,
    pub vlan: Option<VlanId>,
}

/// The FreeRADIUS users file and MAC-auth mapping. Effective for wireless
/// clients only -- the SG2008P has no 802.1X/MAB, so a wired target must be
/// refused here (a second line of defence; `bsc-lan-policy` is expected to
/// have already routed wired targets to [`crate::adapters::SwitchAdapter`]
/// instead of calling this trait at all).
pub trait NacAdapter: Send + Sync {
    /// Write a MAC → VLAN mapping and reload. The users-file write is
    /// atomic (temp file plus rename) at the adapter level; this trait
    /// only promises the read-back-verified end state.
    fn approve(
        &self,
        mac: MacAddr,
        vlan: VlanId,
    ) -> impl std::future::Future<Output = Result<Verified<Option<VlanId>>, ControlError>> + Send;

    /// Remove a MAC's mapping (the inverse of `approve`).
    fn deny(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<Option<VlanId>>, ControlError>> + Send;

    /// The current mapping, for dry-run previews and `drift()`.
    fn read_mapping(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<NacMappingEntry>>, ObservationError>> + Send;
}
