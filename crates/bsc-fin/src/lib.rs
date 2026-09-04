//! `bsc fin` — the personal finance store.
//!
//! A LOCAL surface, and the locality is a requirement rather than a default. Statements are parsed on
//! this machine, into a store on this machine, and no verb here sends anything anywhere. The analysis
//! that runs over it is meant to run on a LOCAL model for the same reason: a bank statement is not
//! something to hand to a third party in order to be told what is in it.
//!
//! A COMMAND SURFACE, not a server. `bsc` is in the mandatory permission tier every session role can
//! already run, so a worker or an architect reaches this with no grant — where an MCP server would
//! need registering, scoping and keeping alive to do the same job worse.
//!
//! Amounts are integer MINOR UNITS end to end ([`money`]). The parse never constructs a float, so a
//! figure in the store is the figure on the statement.
pub mod cli;
pub mod money;
pub mod statement;
