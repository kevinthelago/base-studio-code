//! [`WirelessAdapter`]: the Omada V5 controller API. Implemented by
//! `bsc-lan-adapter-omada`.

use std::net::IpAddr;
use std::time::SystemTime;

use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::MacAddr;

/// One client the Omada controller currently manages.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WirelessClient {
    pub mac: MacAddr,
    pub ip: Option<IpAddr>,
    pub ssid: String,
    pub connected_at: SystemTime,
}

/// Wireless client control and the AP client list. The controller manages
/// wireless clients only -- see the module docs on why this adapter must
/// refuse anything that would target the switch or imply adoption; that
/// refusal is `bsc-lan-adapter-omada`'s job to enforce, since it requires
/// knowing the switch is out of scope, not something this trait's shape
/// can express structurally.
pub trait WirelessAdapter: Send + Sync {
    /// Block a client from associating. Refused for a wired client -- the
    /// caller (`bsc-lan-policy`) is expected to have already resolved the
    /// connection medium before dispatch, but the adapter refuses again as
    /// defence in depth.
    fn block_client(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Unblock a client (the inverse of `block_client`).
    fn unblock_client(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Disconnect a currently-associated client. Read-back verified against
    /// the client list, per the omada-controller-adapter contract.
    fn kick_client(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Every client the controller currently sees associated, across all
    /// APs -- feeds `topology()` and the asset model.
    fn read_clients(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<WirelessClient>>, ObservationError>> + Send;
}
