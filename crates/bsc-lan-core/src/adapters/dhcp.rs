//! [`DhcpAdapter`]: Kea reservations and leases. Implemented by
//! `bsc-lan-adapter-opnsense`.

use std::net::IpAddr;
use std::time::SystemTime;

use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::{Hostname, MacAddr};

/// A static Kea reservation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DhcpReservation {
    pub mac: MacAddr,
    pub ip: IpAddr,
    pub hostname: Option<Hostname>,
}

/// A live (non-reserved) Kea lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DhcpLease {
    pub mac: MacAddr,
    pub ip: IpAddr,
    pub hostname: Option<Hostname>,
    pub expires_at: SystemTime,
}

/// Kea DHCP reservations and leases.
pub trait DhcpAdapter: Send + Sync {
    /// Add a reservation. Refuses (via [`ControlError::ConcurrentModification`]
    /// or [`ControlError::Refused`]) rather than overwriting when `mac` is
    /// already reserved or `ip` is leased to a different host -- the
    /// dhcp-and-firewall-rule-actions contract requires the conflict to be
    /// surfaced, not silently resolved.
    fn add_reservation(
        &self,
        mac: MacAddr,
        ip: IpAddr,
        hostname: Option<&Hostname>,
    ) -> impl std::future::Future<Output = Result<Verified<Option<DhcpReservation>>, ControlError>> + Send;

    /// Remove a reservation (the inverse of `add_reservation`).
    fn remove_reservation(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<Option<DhcpReservation>>, ControlError>> + Send;

    /// Release a live lease. Refuses for a statically reserved host per the
    /// contract ("releasing a lease for a statically reserved host is
    /// refused as a no-op with an explanation").
    fn release_lease(
        &self,
        mac: MacAddr,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    fn read_reservations(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<DhcpReservation>>, ObservationError>> + Send;
    fn read_leases(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<DhcpLease>>, ObservationError>> + Send;
}
