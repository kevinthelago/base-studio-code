//! The eight adapter traits. See `contracts/adapter-traits.md` for the five
//! rules every implementation must satisfy (typed arguments only, fail
//! closed on control, read-back is part of the write, every mutation
//! yields an inverse, no adapter enforces policy) and the table of which
//! crate implements which trait.
//!
//! Every method is a native `async fn` in a trait (stable since Rust
//! 1.75) rather than using the `async-trait` crate, since `async-trait` is
//! not in the locked dependency manifest -- see the crate's `bsc-note`
//! history. A caller needing `dyn` dispatch will need to box at the call
//! site.
//!
//! Every trait requires `Send + Sync`, since an adapter is expected to be
//! shared across the async tasks handling concurrent requests.

pub mod dhcp;
pub mod dns;
pub mod firewall;
pub mod host;
pub mod nac;
pub mod switch;
pub mod telemetry;
pub mod wireless;

pub use dhcp::DhcpAdapter;
pub use dns::DnsAdapter;
pub use firewall::FirewallAdapter;
pub use host::HostAdapter;
pub use nac::NacAdapter;
pub use switch::SwitchAdapter;
pub use telemetry::TelemetryAdapter;
pub use wireless::WirelessAdapter;
