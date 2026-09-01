//! GitHub integration & auth (#1300): the REST/GraphQL proxy + gists, OAuth device flow,
//! and git-hook inspection.

/// The `User-Agent` header sent on every GitHub request (REST, GraphQL, gists, and the OAuth
/// device flow). Single source of truth, built from the crate version so it tracks releases
/// automatically (replaces the formerly hardcoded, stale `base-studio-code/0.2.0`). Used by
/// both `api.rs` and `oauth.rs`.
pub(crate) const USER_AGENT: &str = concat!("base-studio-code/", env!("CARGO_PKG_VERSION"));

// The persisted board state's MODEL (`epic-frontend-logic-over-backend-resources-belongs-in-rust`) —
// the rules about a structure bsc-project already stores but, by its own doc comment, treats as
// opaque. Nothing calls it yet: the caller flip is a separate item, so the derivation and the
// behaviour change stay independently revertible.
#[allow(dead_code)]
pub(crate) mod board_state;
pub mod api;
pub mod oauth;
pub mod git_hooks;

// Preserve the pre-restructure path `crate::github::<fn>` for the REST/GraphQL commands that
// lived in the old flat `github.rs` (now `api.rs`) — used by the invoke handler + callers.
pub(crate) use api::*;
pub mod repos;
pub mod readiness;

/// Which GitHub credential a request or a session may use (#158) — the repo-scoped token choice,
/// ported from `repoCredentials.ts`. A security boundary that was decided in the renderer.
pub mod repo_credentials;
