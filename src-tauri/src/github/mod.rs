//! GitHub integration & auth (#1300): the REST/GraphQL proxy + gists, OAuth device flow,
//! and git-hook inspection.

pub mod api;
pub mod oauth;
pub mod git_hooks;

// Preserve the pre-restructure path `crate::github::<fn>` for the REST/GraphQL commands that
// lived in the old flat `github.rs` (now `api.rs`) — used by the invoke handler + callers.
pub(crate) use api::*;
pub mod repos;
pub mod readiness;
