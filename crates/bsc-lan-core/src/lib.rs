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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/action.rs, src/actor.rs, src/adapters/mod.rs, src/adapters/dhcp.rs, src/adapters/dns.rs, src/adapters/firewall.rs, src/adapters/host.rs, src/adapters/nac.rs, src/adapters/switch.rs, src/adapters/telemetry.rs, src/adapters/wireless.rs, src/asset.rs, src/audit.rs, src/error.rs, src/evidence.rs, src/primitives.rs, src/proposal.rs, src/target.rs, src/tier.rs, src/ttl.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-lan-core--<module>.rs
//     bsc graph impl set --id bsc-lan-core--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-lan-core--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));