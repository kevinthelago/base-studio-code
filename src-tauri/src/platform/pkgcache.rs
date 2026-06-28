//! Shared package-manager caches/stores/outputs for the fleet's worktrees (#worktree-disk).
//!
//! The fleet creates one git worktree per stream, and each agent installs its own dependencies +
//! build outputs INSIDE its worktree — so N streams in a repo meant N full copies of `node_modules`
//! / `target/` (worktrees seen at 8 GB). This module makes the app NATIVELY relocate every common
//! package manager's shared store/cache/output to one location keyed per-repo, set as ENV at session
//! launch (`wire_bsc_env`), so the copies are shared across a repo's worktrees instead of duplicated.
//!
//! Coverage (every package manager the generated projects might use):
//!   * **Cargo** — `CARGO_TARGET_DIR` to a per-repo SHARED target dir (the biggest offender; cargo
//!     locks it, so concurrent builds serialize rather than corrupt). The crate registry cache is
//!     already global (`CARGO_HOME`), left untouched so installed cargo tools keep working.
//!   * **npm / pnpm / yarn** — a shared download cache (`npm_config_cache` / `YARN_CACHE_FOLDER`) and
//!     a shared **pnpm store** (`npm_config_store_dir`): pnpm hardlinks from the store → genuine
//!     on-disk dedup. (npm + yarn-classic still COPY `node_modules` — no native dedup exists — but the
//!     shared download cache makes re-installs fast/offline; pnpm is the path to true dedup.)
//!   * **Python** — `PIP_CACHE_DIR` + `UV_CACHE_DIR` (uv hardlinks from its cache → dedup).
//!   * **Go** — `GOMODCACHE` + `GOCACHE`.
//!
//! Scoped to fleet worktrees only (cwd under `<base>/worktrees/<key>/<repo>--<slug>`); a manual or
//! planner console keeps its normal global caches.

use std::path::Path;

/// The per-repo cache key (`<projectKey>/<repoStem>`) for a fleet worktree `cwd` under
/// `<base>/worktrees/<key>/<repoStem>--<slug>`, or `None` for any non-worktree cwd (the planner hub,
/// a manual console) so we never relocate an unrelated repo's outputs. All of a repo's worktrees map
/// to the same key, which is the whole point — they share one cargo target dir. Pure + testable.
pub(crate) fn repo_cache_key(base: &Path, cwd: &str) -> Option<String> {
    let rest = Path::new(cwd).strip_prefix(base.join("worktrees")).ok()?;
    let mut comps = rest.components();
    let key = comps.next()?.as_os_str().to_string_lossy().into_owned();
    let name = comps.next()?.as_os_str().to_string_lossy().into_owned();
    // `<repoStem>--<slug>` → `<repoStem>`. (A repo whose short name contains `--` just gets less
    // sharing across its agents, never incorrect behavior.)
    let repo = name.split("--").next().unwrap_or(&name);
    if key.is_empty() || repo.is_empty() { return None; }
    Some(format!("{key}/{repo}"))
}

/// Env pairs (NATIVE OS paths — these are read by native tools, not the bash shell) that point each
/// package manager at the shared, per-repo location. Empty for a non-fleet-worktree cwd. Pre-creates
/// the dirs (best-effort) so first-run installs don't race and everything stays inside the app dir
/// for any FS-confined session.
pub(crate) fn package_cache_env(base: &Path, cwd: &str) -> Vec<(&'static str, String)> {
    let Some(key) = repo_cache_key(base, cwd) else { return Vec::new() };
    let caches = base.join("caches");
    let at = |sub: &str| caches.join(sub).to_string_lossy().into_owned();
    let env: Vec<(&'static str, String)> = vec![
        // Cargo: one shared target dir per repo (shared across all of its worktrees).
        ("CARGO_TARGET_DIR", caches.join("cargo-target").join(&key).to_string_lossy().into_owned()),
        // Node: shared download cache (npm/pnpm) + pnpm content-addressable store (hardlinks) + yarn.
        ("npm_config_cache", at("npm")),
        ("npm_config_store_dir", at("pnpm-store")),
        ("YARN_CACHE_FOLDER", at("yarn")),
        // Python: shared pip + uv caches (uv hardlinks).
        ("PIP_CACHE_DIR", at("pip")),
        ("UV_CACHE_DIR", at("uv")),
        // Go: shared module + build caches.
        ("GOMODCACHE", caches.join("go").join("mod").to_string_lossy().into_owned()),
        ("GOCACHE", caches.join("go").join("build").to_string_lossy().into_owned()),
    ];
    for (_, v) in &env {
        let _ = std::fs::create_dir_all(v);
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn base() -> PathBuf { PathBuf::from("/home/u/.base-studio-code") }

    #[test]
    fn repo_key_parses_a_fleet_worktree_cwd() {
        let cwd = base().join("worktrees").join("proj-key").join("web--auth-ui");
        assert_eq!(repo_cache_key(&base(), &cwd.to_string_lossy()), Some("proj-key/web".into()));
    }

    #[test]
    fn all_worktrees_of_a_repo_share_one_key() {
        let a = base().join("worktrees").join("k").join("api--stream-a");
        let b = base().join("worktrees").join("k").join("api--stream-b");
        assert_eq!(repo_cache_key(&base(), &a.to_string_lossy()),
                   repo_cache_key(&base(), &b.to_string_lossy()),
                   "two streams in the same repo must share the cargo target dir");
    }

    #[test]
    fn non_worktree_cwd_has_no_key_and_no_env() {
        // The planner hub / a clone / a manual console — keep their normal global caches.
        let hub = base().join("projects").join("k").join("web");
        assert_eq!(repo_cache_key(&base(), &hub.to_string_lossy()), None);
        assert!(package_cache_env(&base(), &hub.to_string_lossy()).is_empty());
        assert!(package_cache_env(&base(), "/some/other/place").is_empty());
    }

    #[test]
    fn worktree_cwd_sets_every_package_manager() {
        let cwd = base().join("worktrees").join("k").join("web--ui");
        let env = package_cache_env(&base(), &cwd.to_string_lossy());
        let names: Vec<&str> = env.iter().map(|(k, _)| *k).collect();
        for expected in ["CARGO_TARGET_DIR", "npm_config_cache", "npm_config_store_dir",
                         "YARN_CACHE_FOLDER", "PIP_CACHE_DIR", "UV_CACHE_DIR", "GOMODCACHE", "GOCACHE"] {
            assert!(names.contains(&expected), "missing {expected} in {names:?}");
        }
        // The cargo target is keyed per-repo under the shared caches dir.
        let target = env.iter().find(|(k, _)| *k == "CARGO_TARGET_DIR").unwrap().1.clone();
        assert!(target.contains("cargo-target") && target.contains("k") && target.ends_with("web"));
    }
}
