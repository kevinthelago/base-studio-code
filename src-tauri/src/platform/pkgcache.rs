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
//! Scoped to a project's REPO-scoped sessions — the fleet's worktrees AND the per-repo triage clone
//! (#1651), so triage shares the warm cache the fleet pulled instead of cold-installing on its own; a
//! manual or planner-HUB console keeps its normal global caches.

use std::path::Path;

/// The per-repo cache key (`<projectKey>/<repoStem>`) for a repo-scoped session, or `None` for a cwd
/// that isn't repo-scoped (the planner hub, a manual console). Two cwd shapes map to the SAME key so
/// they share one cache — one cargo target dir + one warm download cache per repo:
///   * a fleet **worktree** — `<base>/worktrees/<key>/<repoStem>--<slug>`
///   * the repo's main **clone** (where TRIAGE runs `claude --continue`, #1651) — `<base>/projects/<key>/<repo>`
///
/// The planner HUB itself (`<base>/projects/<key>`, no repo segment) is excluded — it keeps its
/// global caches. Pure + testable.
pub(crate) fn repo_cache_key(base: &Path, cwd: &str) -> Option<String> {
    let cwd = Path::new(cwd);
    // Fleet worktree: <base>/worktrees/<key>/<repoStem>--<slug> → <key>/<repoStem>.
    if let Ok(rest) = cwd.strip_prefix(base.join("worktrees")) {
        let mut comps = rest.components();
        let key = comps.next()?.as_os_str().to_string_lossy().into_owned();
        let name = comps.next()?.as_os_str().to_string_lossy().into_owned();
        // `<repoStem>--<slug>` → `<repoStem>`. (A repo whose short name contains `--` just gets less
        // sharing across its agents, never incorrect behavior.)
        let repo = name.split("--").next().unwrap_or(&name);
        return (!key.is_empty() && !repo.is_empty()).then(|| format!("{key}/{repo}"));
    }
    // Triage / repo-scoped clone: <base>/projects/<key>/<repo>[/…] → <key>/<repo>, mapping the main
    // clone onto the SAME key as the repo's worktrees so triage shares their cache. The HUB root
    // (`projects/<key>`, only one component) yields `None` — its global caches are left alone.
    if let Ok(rest) = cwd.strip_prefix(base.join("projects")) {
        let mut comps = rest.components();
        let key = comps.next()?.as_os_str().to_string_lossy().into_owned();
        let repo = comps.next()?.as_os_str().to_string_lossy().into_owned();
        return (!key.is_empty() && !repo.is_empty()).then(|| format!("{key}/{repo}"));
    }
    None
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
    fn the_triage_clone_shares_the_repos_worktree_key() {
        // Triage runs in the repo's MAIN CLONE (`projects/<key>/<repo>`); it must map to the SAME key
        // as that repo's worktrees so it shares their warm cache instead of cold-installing (#1651).
        let clone = base().join("projects").join("k").join("web");
        let wt = base().join("worktrees").join("k").join("web--stream-a");
        assert_eq!(repo_cache_key(&base(), &clone.to_string_lossy()), Some("k/web".into()));
        assert_eq!(repo_cache_key(&base(), &clone.to_string_lossy()),
                   repo_cache_key(&base(), &wt.to_string_lossy()),
                   "triage clone and the repo's worktrees must share one cache key");
        assert!(!package_cache_env(&base(), &clone.to_string_lossy()).is_empty());
    }

    #[test]
    fn the_planner_hub_and_unrelated_cwds_have_no_key_and_no_env() {
        // The planner HUB root (no repo segment) and any cwd outside the app tree keep global caches.
        let hub = base().join("projects").join("k");
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
