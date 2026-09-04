//! `bsc-lan-core`: the shared vocabulary and the eight adapter traits for the
//! network control plane. Pure types and traits -- **no I/O whatsoever**.
//!
//! Three properties are load-bearing here and are enforced by the type
//! system rather than by review:
//!
//! 1. **Exhaustiveness.** Adding an [`action::Action`] variant fails to
//!    compile until [`action::Action::tier`], [`action::Action::target`],
//!    [`action::Action::name`]/[`action::Action::render`] and
//!    [`action::Action::inverse_kind`] all grow an arm -- every one of
//!    those matches has no wildcard arm, and `wildcard_enum_match_arm` is
//!    denied crate-wide below so a later contributor cannot quietly add
//!    one. See `action.rs`'s test module for the whole-catalog regression
//!    check.
//! 2. **Typed targets.** Adapter arguments are [`std::net::IpAddr`],
//!    [`primitives::MacAddr`], [`primitives::VlanId`],
//!    [`primitives::PortNumber`] and a validated [`primitives::Hostname`]
//!    -- never a bare `String` -- via [`target::Target`]. An
//!    attacker-controlled reverse-DNS name or TLS SNI value pulled from
//!    telemetry cannot reach a command line because there is no
//!    `Target::Raw(String)` arm to carry it.
//! 3. **Evidence integrity.** [`evidence::Disposition::Passed`] cannot be
//!    constructed from mirror data alone -- its constructor requires an
//!    [`evidence::FirewallLogWitness`], which only
//!    [`evidence::parse_firewall_log_line`] can produce. Every Tier 1
//!    action that installs revocable state on a target requires a
//!    [`ttl::Ttl`] at construction via [`action::TimeBoundedAction`]; there
//!    is no constructor that omits an expiry.
//!
//! This crate depends on no async runtime, HTTP client or SSH library --
//! `tests/dependency_absence.rs` pins that.

#![deny(clippy::wildcard_enum_match_arm)]

pub mod action;
pub mod actor;
pub mod adapters;
pub mod asset;
pub mod audit;
pub mod error;
pub mod evidence;
pub mod primitives;
pub mod proposal;
pub mod target;
pub mod tier;
pub mod ttl;

pub use action::Action;
pub use actor::Actor;
pub use adapters::{
    DhcpAdapter, DnsAdapter, FirewallAdapter, HostAdapter, NacAdapter, SwitchAdapter,
    TelemetryAdapter, WirelessAdapter,
};
pub use asset::AssetIdentity;
pub use audit::AuditEvent;
pub use error::{ControlError, ObservationError};
pub use evidence::{Disposition, ObservationPoint};
pub use proposal::Proposal;
pub use target::Target;
pub use tier::Tier;
pub use ttl::Ttl;
