//! base-studio-code Tauri backend. The crate root is module declarations + the `run` entry point + the
//! internal `prelude` (#1918). Domain modules are referenced by their full path
//! (`crate::console::pty`, `crate::observability::logs`, `crate::mobile::tunnel`, …) so a reference
//! always names its domain; the common leaf helpers come from `crate::prelude` (`use crate::prelude::*;`).
//! (This replaced the #1300 crate-root re-export shim that aliased every subsystem under flat
//! `crate::<name>` paths.)

mod planner;
mod platform;
mod app;
mod console;
mod session;
mod github;
mod sources;
mod observability;
mod mobile;
mod project;
mod fleet;
mod extensions;
mod prelude;

// The leaf-helper prelude is re-exported at the crate root so the common helpers stay reachable as
// `crate::<helper>` (and via `use crate::prelude::*;`). This is the ONLY crate-root re-export — the
// misleading #1300 module aliases (`crate::pty` = console::pty, `crate::data` = sources::data, …) are
// gone; domain modules are now referenced by their full path.
pub(crate) use prelude::*;

pub use app::run::run;

#[cfg(test)]
pub(crate) mod testutil;
#[cfg(test)]
mod tests;
