//! Interactive PTY execution surface (#1300): terminal sessions running agents, their
//! process ledger, durable session discovery, and the `bsc-*` shell helper rc.

pub mod pty;
pub mod ledger;
pub mod discovery;
pub mod shell_rc;
pub mod bsc;
pub(crate) mod bsc_warm;
