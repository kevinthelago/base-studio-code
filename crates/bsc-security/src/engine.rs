//! The query engine (#3797) — glues the [`Cache`] and a [`VulnSource`] into the three operations the
//! CLI + MCP expose: `check` one package, `scan` many, `get` an advisory by id. Cache-first with a
//! TTL; on a network error it falls back to the STALE cache (offline resilience) rather than failing
//! outright — but only reports a package "clean" when it has a real answer for it, never by assuming.
//!
//! Generic over [`VulnSource`] so the whole engine (and the CLI/MCP over it) is testable with a fake
//! source and never touches the network.

use crate::cache::{Cache, DEFAULT_TTL_SECS};
use crate::osv::{Osv, VulnSource};
use crate::types::{Advisory, Package, PackageReport, ScanReport};

pub struct Engine<S: VulnSource> {
    cache: Cache,
    source: S,
    ttl: i64,
}

impl Engine<Osv> {
    /// The production engine: the on-disk cache + the live OSV client + the default TTL.
    pub fn from_env() -> Result<Engine<Osv>, String> {
        let path = Cache::default_path()
            .ok_or_else(|| "could not resolve a cve cache path; set BSC_CVE_DB".to_string())?;
        Engine::open(&path)
    }

    /// The production engine over an explicit cache path (the CLI's `--db`); the live OSV client + the
    /// default TTL.
    pub fn open(cache_path: &std::path::Path) -> Result<Engine<Osv>, String> {
        Ok(Engine { cache: Cache::open(cache_path)?, source: Osv::from_env()?, ttl: DEFAULT_TTL_SECS })
    }
}

impl<S: VulnSource> Engine<S> {
    /// Assemble an engine from parts (tests inject an in-memory cache + a fake source).
    pub fn new(cache: Cache, source: S, ttl: i64) -> Engine<S> {
        Engine { cache, source, ttl }
    }

    /// Advisories affecting one package. Fresh cache → return it; else query the source, cache the
    /// result, return it. On a network error, fall back to a STALE cache entry if one exists.
    pub fn check(&self, pkg: &Package) -> Result<PackageReport, String> {
        let advisories = self.resolve(pkg)?;
        Ok(PackageReport { package: pkg.clone(), advisories })
    }

    /// The advisory list for one package, applying the cache/network/offline policy.
    fn resolve(&self, pkg: &Package) -> Result<Vec<Advisory>, String> {
        if let Some(cached) = self.cache.get(pkg, self.ttl) {
            return Ok(cached);
        }
        match self.source.query(pkg) {
            Ok(advs) => {
                let _ = self.cache.put(pkg, &advs);
                Ok(advs)
            }
            // Offline / rate-limited: a stale cached answer beats failing.
            Err(e) => self.cache.get(pkg, 0).ok_or(e),
        }
    }

    /// Scan many packages, returning only the vulnerable ones plus the roll-up. Fresh-cached packages
    /// are served from cache; the rest are batch-queried in ONE OSV request and cached. On a batch
    /// error, every miss falls back to its stale cache entry — but if ANY miss has no cached answer at
    /// all, the error propagates (we never silently report an unknown package as clean).
    pub fn scan(&self, pkgs: &[Package]) -> Result<ScanReport, String> {
        let mut results: Vec<Vec<Advisory>> = vec![Vec::new(); pkgs.len()];
        let mut miss_idx: Vec<usize> = Vec::new();
        for (i, pkg) in pkgs.iter().enumerate() {
            match self.cache.get(pkg, self.ttl) {
                Some(advs) => results[i] = advs,
                None => miss_idx.push(i),
            }
        }

        if !miss_idx.is_empty() {
            let misses: Vec<Package> = miss_idx.iter().map(|&i| pkgs[i].clone()).collect();
            match self.source.query_batch(&misses) {
                Ok(batch) => {
                    for (slot, advs) in miss_idx.iter().zip(batch) {
                        let _ = self.cache.put(&pkgs[*slot], &advs);
                        results[*slot] = advs;
                    }
                }
                Err(e) => {
                    // Offline: fall back to stale cache for each miss; a total miss (no cache) is fatal.
                    for &i in &miss_idx {
                        match self.cache.get(&pkgs[i], 0) {
                            Some(advs) => results[i] = advs,
                            None => return Err(format!("{e} (and no cached answer for {})", pkgs[i].name)),
                        }
                    }
                }
            }
        }

        let findings: Vec<PackageReport> = pkgs
            .iter()
            .zip(results)
            .filter(|(_, advs)| !advs.is_empty())
            .map(|(pkg, advisories)| PackageReport { package: pkg.clone(), advisories })
            .collect();
        Ok(ScanReport::new(findings, pkgs.len()))
    }

    /// One advisory's full record by id (`None` if unknown). Not cached — advisory detail is an
    /// occasional lookup, and a fresh record is preferable.
    pub fn get(&self, id: &str) -> Result<Option<Advisory>, String> {
        self.source.get(id)
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A deterministic in-memory [`VulnSource`] for the engine/CLI/MCP tests — no network. Keyed by
    //! package name; can simulate an offline source (`fail`) + counts batch calls so a test can assert
    //! the cache actually spared the network.
    use super::*;
    use std::cell::Cell;
    use std::collections::HashMap;

    pub struct FakeSource {
        by_name: HashMap<String, Vec<Advisory>>,
        by_id: HashMap<String, Advisory>,
        pub fail: bool,
        pub query_calls: Cell<usize>,
        pub batch_calls: Cell<usize>,
    }

    impl FakeSource {
        pub fn new() -> FakeSource {
            FakeSource {
                by_name: HashMap::new(),
                by_id: HashMap::new(),
                fail: false,
                query_calls: Cell::new(0),
                batch_calls: Cell::new(0),
            }
        }
        /// Register advisories for a package name (used for both `query` and batch).
        pub fn with(mut self, name: &str, advs: Vec<Advisory>) -> FakeSource {
            for a in &advs {
                self.by_id.insert(a.id.clone(), a.clone());
            }
            self.by_name.insert(name.to_string(), advs);
            self
        }
        pub fn offline(mut self) -> FakeSource {
            self.fail = true;
            self
        }
    }

    impl VulnSource for FakeSource {
        fn query(&self, pkg: &Package) -> Result<Vec<Advisory>, String> {
            self.query_calls.set(self.query_calls.get() + 1);
            if self.fail {
                return Err("offline".into());
            }
            Ok(self.by_name.get(&pkg.name).cloned().unwrap_or_default())
        }
        fn query_batch(&self, pkgs: &[Package]) -> Result<Vec<Vec<Advisory>>, String> {
            self.batch_calls.set(self.batch_calls.get() + 1);
            if self.fail {
                return Err("offline".into());
            }
            Ok(pkgs.iter().map(|p| self.by_name.get(&p.name).cloned().unwrap_or_default()).collect())
        }
        fn get(&self, id: &str) -> Result<Option<Advisory>, String> {
            if self.fail {
                return Err("offline".into());
            }
            Ok(self.by_id.get(id).cloned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeSource;
    use super::*;
    use crate::types::{Ecosystem, Severity};

    fn adv(id: &str, sev: Severity) -> Advisory {
        Advisory { id: id.into(), summary: "s".into(), severity: sev, aliases: vec![], references: vec![] }
    }
    fn npm(name: &str) -> Package {
        Package::new(Ecosystem::Npm, name, Some("1.0.0".into()))
    }

    #[test]
    fn check_queries_then_serves_from_cache() {
        let src = FakeSource::new().with("lodash", vec![adv("GHSA-1", Severity::High)]);
        let engine = Engine::new(Cache::in_memory().unwrap(), src, DEFAULT_TTL_SECS);
        let r = engine.check(&npm("lodash")).unwrap();
        assert_eq!(r.advisories.len(), 1);
        assert_eq!(r.max_severity(), Severity::High);
        assert_eq!(engine.source.query_calls.get(), 1);
        // Second check is a cache hit — no new network query.
        let r2 = engine.check(&npm("lodash")).unwrap();
        assert_eq!(r2.advisories.len(), 1);
        assert_eq!(engine.source.query_calls.get(), 1, "the second check hit the cache");
    }

    #[test]
    fn check_falls_back_to_stale_cache_when_offline() {
        // Prime the cache with an online engine, then a fresh OFFLINE engine over the SAME db answers
        // from the STALE row (the fresh read misses under a positive TTL → source errors → stale
        // fallback) instead of failing.
        let cache_path = std::env::temp_dir().join(format!("cve-eng-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&cache_path);
        {
            let online = Engine::new(
                Cache::open(&cache_path).unwrap(),
                FakeSource::new().with("left-pad", vec![adv("GHSA-2", Severity::Medium)]),
                DEFAULT_TTL_SECS,
            );
            online.check(&npm("left-pad")).unwrap();
        }
        // Age the row past a 60s TTL so the offline engine's FRESH read misses and it must take the
        // Err → stale-cache fallback path (not the first cache-hit).
        let cache = Cache::open(&cache_path).unwrap();
        cache.age(&npm("left-pad"), 100);
        let offline = Engine::new(cache, FakeSource::new().offline(), 60);
        let r = offline.check(&npm("left-pad")).unwrap();
        assert_eq!(r.advisories[0].id, "GHSA-2", "served from the stale cache while offline");
        assert_eq!(offline.source.query_calls.get(), 1, "the offline source WAS tried before the fallback");
        // A package the cache never saw → the offline error propagates (never reported clean).
        assert!(offline.check(&npm("never-seen")).is_err());
        let _ = std::fs::remove_file(&cache_path);
    }

    #[test]
    fn scan_batches_misses_and_reports_only_vulnerable() {
        let src = FakeSource::new()
            .with("bad", vec![adv("GHSA-3", Severity::Critical)])
            .with("also-bad", vec![adv("GHSA-4", Severity::Low)]);
        // "good" and "fine" have no advisories registered → clean.
        let engine = Engine::new(Cache::in_memory().unwrap(), src, DEFAULT_TTL_SECS);
        let pkgs = vec![npm("good"), npm("bad"), npm("fine"), npm("also-bad")];
        let report = engine.scan(&pkgs).unwrap();
        assert_eq!(report.scanned, 4);
        assert_eq!(report.vulnerable, 2, "only the two vulnerable packages are findings");
        assert_eq!(report.max_severity, Severity::Critical);
        assert_eq!(engine.source.batch_calls.get(), 1, "one batch request for all misses");
        let names: Vec<&str> = report.packages.iter().map(|p| p.package.name.as_str()).collect();
        assert!(names.contains(&"bad") && names.contains(&"also-bad"));
        assert!(!names.contains(&"good"));
    }

    #[test]
    fn scan_offline_with_no_cache_errors_rather_than_reporting_clean() {
        let engine = Engine::new(Cache::in_memory().unwrap(), FakeSource::new().offline(), DEFAULT_TTL_SECS);
        let err = engine.scan(&[npm("unknown")]).unwrap_err();
        assert!(err.contains("no cached answer"), "never silently reports an unknown package as clean: {err}");
    }
}
