//! [`HostAdapter`]: systemd units and reboots, per host. Implemented by
//! `bsc-lan-adapter-host`. The narrowest adapter and the one with the
//! highest blast radius per call, so it does the least: start/stop/
//! restart/status for a named unit, and reboot for a named host.

use std::time::Duration;

use crate::action::ServiceUnit;
use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::Hostname;

/// A systemd unit's activation state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnitState {
    Active,
    Inactive,
    Failed,
}

/// The confirmed result of a `reboot` call: the host was unreachable for
/// some interval and then answered again within the timeout. There is no
/// "prior state" to capture the way [`Verified`] expects, because a reboot
/// has no true inverse -- see [`crate::action::InverseKind::Irreversible`]
/// on `Action::RebootHost`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RebootConfirmation {
    pub answered_after: Duration,
}

/// systemd unit control and host reboot, over SSH.
pub trait HostAdapter: Send + Sync {
    fn unit_status(
        &self,
        host: &Hostname,
        unit: &ServiceUnit,
    ) -> impl std::future::Future<Output = Result<Observed<UnitState>, ObservationError>> + Send;

    /// Start `unit` and confirm it is active afterwards.
    fn start_unit(
        &self,
        host: &Hostname,
        unit: &ServiceUnit,
    ) -> impl std::future::Future<Output = Result<Verified<UnitState>, ControlError>> + Send;

    fn stop_unit(
        &self,
        host: &Hostname,
        unit: &ServiceUnit,
    ) -> impl std::future::Future<Output = Result<Verified<UnitState>, ControlError>> + Send;

    /// Restart `unit`. A unit that comes back inactive after the restart
    /// command succeeded is still reported as [`ControlError`], per the
    /// host-control-actions contract -- the exit code of the restart
    /// command is not the success criterion, the post-condition is.
    fn restart_unit(
        &self,
        host: &Hostname,
        unit: &ServiceUnit,
    ) -> impl std::future::Future<Output = Result<Verified<UnitState>, ControlError>> + Send;

    /// Reboot `host` and confirm it answers again within an
    /// adapter-defined timeout. An unreachable host refuses rather than
    /// retrying -- a reboot issued twice is a materially different
    /// operation from a reboot issued once.
    fn reboot(
        &self,
        host: &Hostname,
    ) -> impl std::future::Future<Output = Result<RebootConfirmation, ControlError>> + Send;
}
