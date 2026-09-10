//! A read-only SQLite reader with a dependency closure of exactly `std`.
//!
//! # What it is for
//!
//! Two crates in this workspace must read a record store and are forbidden `rusqlite` — for different
//! reasons, both load-bearing:
//!
//! | crate | the contract it must keep |
//! |---|---|
//! | `graph-materialize` | "serde_json and nothing else" — a build-dependency of 75 crates, so anything it links is compiled before any of them can start |
//! | `bsc-util` | "std only, no dependencies, so any CLI can pull it in for free" — even its JSON reader is a dev-dependency |
//!
//! Before this crate existed the reader lived inside `graph-materialize` and was reachable only by
//! `include!`ing its file. That was fine while `graph-materialize` was the one caller and stopped
//! being fine the moment `bsc-util` needed it, because a leaf crate cannot `include!` its way into
//! another crate's build script.
//!
//! # Two entry points, one source
//!
//! `pages.rs` beside this file is the implementation, and it is reached BOTH ways:
//!
//! * this crate `include!`s it, which is how an ordinary dependent (`bsc-util`) gets it;
//! * `graph-materialize`'s `build.rs` and `src/lib.rs` `include!` the same file, which is how the
//!   BOOTSTRAP gets it — a build script that must read the store in order to materialize the crates
//!   cannot wait for a crate to be built first.
//!
//! That is the same "one implementation, two entry points" shape `graph-materialize` already uses for
//! `plan.rs` and `emit.rs`, and it is why the file carries no `use` statements and fully qualifies
//! every path: it lands in a module it does not control.
//!
//! # Scope
//!
//! It reads. It does not write, and it never will — a writer would need the journal, the freelist and
//! the transaction machinery, which is the point at which linking the real engine is the honest
//! choice. It refuses a WAL-mode database rather than returning the stale rows it would otherwise be
//! unable to see.

include!("pages.rs");

#[cfg(test)]
mod tests;
