//! Local on-disk cache (#3797) — SQLite under `~/.base-studio-code/cve/cache.db` (override with
//! `$BSC_CVE_DB`). Caches OSV query results keyed by `ecosystem:name@version`, so a repeat scan is
//! fast, stays within OSV's rate limits, and can answer from the last result when offline. The cache
//! is a pure optimization with a TTL: a lookup returns `None` on a miss OR when the row is older than
//! the TTL, and the caller falls back to the network — so a stale/corrupt cache never blocks a scan.

use crate::types::{Advisory, Package};
use bsc_util::now_secs;
use rusqlite::Connection;
use std::path::{Path, PathBuf};

/// The default freshness window: 24h. Advisories change slowly; a day-old cached answer is fine, and
/// the install-time hook (a later slice) can force a fresh check when it matters.
pub const DEFAULT_TTL_SECS: i64 = 24 * 60 * 60;

pub struct Cache {
    conn: Connection,
}

impl Cache {
    /// The default cache path: `$BSC_CVE_DB`, else `~/.base-studio-code/cve/cache.db` — the shared
    /// [`bsc_sqlite_util::default_store_path`] resolver (#1863).
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_CVE_DB", &["cve", "cache.db"])
    }

    /// Open (creating parent dirs + schema) the cache at `path`. Use `":memory:"` for tests.
    pub fn open(path: &Path) -> Result<Cache, String> {
        let conn = bsc_sqlite_util::open_db_str(path, "cache")?;
        Cache::init(conn)
    }

    /// An in-memory cache (tests).
    pub fn in_memory() -> Result<Cache, String> {
        let conn = Connection::open_in_memory().map_err(|e| format!("open cache: {e}"))?;
        Cache::init(conn)
    }

    fn init(conn: Connection) -> Result<Cache, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS pkg_vulns (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);",
        )
        .map_err(|e| format!("cache schema: {e}"))?;
        Ok(Cache { conn })
    }

    /// Cache a package's full advisory list (empty is cached too — "known clean" is a useful answer).
    pub fn put(&self, pkg: &Package, advisories: &[Advisory]) -> Result<(), String> {
        let json = serde_json::to_string(advisories).map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO pkg_vulns (key, json, fetched_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
                rusqlite::params![pkg.cache_key(), json, now_secs()],
            )
            .map_err(|e| format!("cache put: {e}"))?;
        Ok(())
    }

    /// A cached advisory list for `pkg`, IF present and fresher than `ttl_secs`. `None` on a miss or a
    /// stale row (so the caller re-queries). A non-positive `ttl_secs` disables freshness (any row hits).
    pub fn get(&self, pkg: &Package, ttl_secs: i64) -> Option<Vec<Advisory>> {
        let row: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT json, fetched_at FROM pkg_vulns WHERE key = ?1",
                [pkg.cache_key()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .ok();
        let (json, fetched_at) = row?;
        if ttl_secs > 0 && now_secs() - fetched_at > ttl_secs {
            return None; // stale
        }
        serde_json::from_str(&json).ok()
    }

    /// Test-only: backdate a cached row so a positive-TTL read treats it as stale — lets the engine
    /// tests drive the offline stale-fallback branch deterministically (no clock injection needed).
    #[cfg(test)]
    pub(crate) fn age(&self, pkg: &Package, older_by_secs: i64) {
        let _ = self.conn.execute(
            "UPDATE pkg_vulns SET fetched_at = fetched_at - ?1 WHERE key = ?2",
            rusqlite::params![older_by_secs, pkg.cache_key()],
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ecosystem, Severity};

    fn adv(id: &str, sev: Severity) -> Advisory {
        Advisory { id: id.into(), summary: "s".into(), severity: sev, aliases: vec![], references: vec![] }
    }

    #[test]
    fn roundtrips_and_respects_ttl() {
        let cache = Cache::in_memory().unwrap();
        let pkg = Package::new(Ecosystem::Npm, "lodash", Some("4.17.0".into()));
        assert!(cache.get(&pkg, DEFAULT_TTL_SECS).is_none(), "miss before put");

        cache.put(&pkg, &[adv("GHSA-1", Severity::High)]).unwrap();
        let got = cache.get(&pkg, DEFAULT_TTL_SECS).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].id, "GHSA-1");

        // A zero TTL means "any age counts" (offline fallback); a negative TTL likewise.
        assert!(cache.get(&pkg, 0).is_some());
        // A tiny TTL that the row is older than (now - fetched_at > ttl) is a stale miss. `now_secs`
        // has 1s granularity and the put just happened, so force staleness with ttl = -1 via a rewrite
        // — simplest: put an ancient row directly.
        cache
            .conn
            .execute("UPDATE pkg_vulns SET fetched_at = ?1 WHERE key = ?2", rusqlite::params![now_secs() - 100, pkg.cache_key()])
            .unwrap();
        assert!(cache.get(&pkg, 10).is_none(), "row older than a 10s TTL is stale");
        assert!(cache.get(&pkg, 0).is_some(), "TTL 0 still returns the stale row (offline fallback)");
    }

    #[test]
    fn empty_result_is_cached_as_known_clean() {
        let cache = Cache::in_memory().unwrap();
        let pkg = Package::new(Ecosystem::Cargo, "serde", Some("1.0.0".into()));
        cache.put(&pkg, &[]).unwrap();
        // A hit that is an empty vec ≠ a miss.
        assert_eq!(cache.get(&pkg, DEFAULT_TTL_SECS), Some(vec![]));
    }
}
