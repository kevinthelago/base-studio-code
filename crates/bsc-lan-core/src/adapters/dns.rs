//! [`DnsAdapter`]: the Unbound blocklist. Implemented by
//! `bsc-lan-adapter-opnsense`.

use crate::error::{ControlError, ObservationError};
use crate::evidence::{Observed, Verified};
use crate::primitives::Hostname;
use crate::target::{Target, TimeWindow};

/// One resolved DNS query, as read from Unbound's query log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DnsQueryRecord {
    pub source: Target,
    pub query: Hostname,
}

/// The Unbound blocklist and query log.
pub trait DnsAdapter: Send + Sync {
    /// Block `domain`, idempotently.
    fn add_block(
        &self,
        domain: &Hostname,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// Unblock `domain`, idempotently.
    fn remove_block(
        &self,
        domain: &Hostname,
    ) -> impl std::future::Future<Output = Result<Verified<bool>, ControlError>> + Send;

    /// The current blocklist, for dry-run idempotency previews and
    /// `drift()`.
    fn read_blocklist(
        &self,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<Hostname>>, ObservationError>> + Send;

    /// Resolved queries in `window`, optionally filtered to one source --
    /// the source for the `dns_queries()` Tier 0 tool.
    fn read_queries(
        &self,
        source: Option<&Target>,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<DnsQueryRecord>>, ObservationError>> + Send;
}
