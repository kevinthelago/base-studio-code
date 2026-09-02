//! GitHub integration & auth (#1300): the REST/GraphQL proxy + gists, OAuth device flow,
//! and git-hook inspection.

/// The `User-Agent` header sent on every GitHub request (REST, GraphQL, gists, and the OAuth
/// device flow). Single source of truth, built from the crate version so it tracks releases
/// automatically (replaces the formerly hardcoded, stale `base-studio-code/0.2.0`). Used by
/// both `api.rs` and `oauth.rs`.
pub(crate) const USER_AGENT: &str = concat!("base-studio-code/", env!("CARGO_PKG_VERSION"));

// `board_state` and `repo_credentials` MOVED to `crates/bsc-github`
// (`the-github-domains-pure-logic-lives-in-bsc-github`). Both were Tauri-free with no importers, and
// living here meant no live session could reach them through `bsc`. Reach them as
// `bsc_github::board_state` / `bsc_github::repo_credentials`.
pub mod api;
pub mod oauth;
pub mod git_hooks;

// Preserve the pre-restructure path `crate::github::<fn>` for the REST/GraphQL commands that
// lived in the old flat `github.rs` (now `api.rs`) — used by the invoke handler + callers.
pub(crate) use api::*;
pub mod repos;
pub mod readiness;

