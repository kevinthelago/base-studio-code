//! Platform primitives (#1300): the OS- and environment-level helpers shared across every
//! domain — filesystem paths under `~/.base-studio-code`, git command execution, child-process
//! spawning, shell resolution + path/quoting conversion, and small filesystem utilities.
//!
//! These have no dependency on the app's domain logic; everything else depends on them. Extracted
//! from the flat `lib.rs` so the shared foundation is visible as one module.

pub mod paths;
pub mod git;
pub mod shell;
pub mod process;
pub mod fsx;
pub mod docstore;
