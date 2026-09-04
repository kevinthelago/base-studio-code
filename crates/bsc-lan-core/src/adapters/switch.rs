//! [`SwitchAdapter`]: the TL-SG2008P CLI over an interactive PTY.
//! Implemented by `bsc-lan-adapter-switch`.

use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::{Hostname, PortNumber, VlanId};

/// A switch port's VLAN configuration: PVID plus 802.1Q tagged membership.
/// `set_port_vlan` reads back both together, in one type, because reading
/// them separately is exactly the failure mode that cost three attempts on
/// this network -- membership alone read back correctly while PVID quietly
/// stayed wrong.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchPortVlanState {
    pub pvid: VlanId,
    pub tagged_members: Vec<VlanId>,
}

/// Full status of one switch port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SwitchPortStatus {
    pub vlan: SwitchPortVlanState,
    pub link_up: bool,
    pub poe_enabled: Option<bool>,
}

/// The TL-SG2008P's CLI, over an interactive PTY session.
pub trait SwitchAdapter: Send + Sync {
    /// Set PVID and 802.1Q membership as a single composite operation and
    /// read both back. The action fails (`Err`) if either does not read
    /// back as intended, per the switch-cli-adapter contract -- there is
    /// no success value representing "membership changed but PVID did
    /// not".
    fn set_port_vlan(
        &self,
        switch: &Hostname,
        port: PortNumber,
        vlan: VlanId,
    ) -> impl std::future::Future<Output = Result<Verified<SwitchPortVlanState>, ControlError>> + Send;

    /// Enable or disable the port (link admin state).
    fn set_port_state(
        &self,
        switch: &Hostname,
        port: PortNumber,
        enabled: bool,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Enable or disable PoE on the port.
    fn set_poe(
        &self,
        switch: &Hostname,
        port: PortNumber,
        enabled: bool,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Full status of one port, for `topology()`, `drift()` and dry-run
    /// idempotency previews.
    fn read_port_status(
        &self,
        switch: &Hostname,
        port: PortNumber,
    ) -> impl std::future::Future<Output = Result<Observed<SwitchPortStatus>, ObservationError>> + Send;

    /// Every port's status in one read, for `topology()`.
    fn read_all_ports(
        &self,
        switch: &Hostname,
    ) -> impl std::future::Future<
        Output = Result<Observed<Vec<(PortNumber, SwitchPortStatus)>>, ObservationError>,
    > + Send;
}
