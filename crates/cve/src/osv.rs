//! The OSV.dev client (#3797) — the one network seam. [OSV.dev](https://osv.dev) is free + key-less
//! and speaks one schema across every ecosystem the fleet installs. Three endpoints:
//!   • `POST /v1/query`      — advisories for ONE `{package, version}` (full vuln objects).
//!   • `POST /v1/querybatch` — many packages in ONE request → per-query vuln IDs (then hydrate).
//!   • `GET  /v1/vulns/{id}` — one advisory's full record.
//!
//! The request-building + response-parsing are pure functions (fixture-tested); only [`Osv::send_*`]
//! touch the network. The [`VulnSource`] trait is the seam the [`crate::engine::Engine`] depends on,
//! so the engine + CLI are testable with a fake source and never hit the wire.

use crate::types::{Advisory, Package};
use serde_json::{json, Value};
use std::time::Duration;

/// The vulnerability data source the engine depends on — real is [`Osv`]; tests inject a fake.
pub trait VulnSource {
    /// Every advisory affecting one package/version.
    fn query(&self, pkg: &Package) -> Result<Vec<Advisory>, String>;
    /// Advisories for many packages at once, aligned to the input order (the scan path). The default
    /// is a naive per-package loop; [`Osv`] overrides it with a real batch request + id hydration.
    fn query_batch(&self, pkgs: &[Package]) -> Result<Vec<Vec<Advisory>>, String> {
        pkgs.iter().map(|p| self.query(p)).collect()
    }
    /// One advisory by id (`None` if OSV has no such id).
    fn get(&self, id: &str) -> Result<Option<Advisory>, String>;
}

const DEFAULT_BASE: &str = "https://api.osv.dev";
const USER_AGENT: &str =
    concat!("bsc-cve/", env!("CARGO_PKG_VERSION"), " (+https://github.com/kevinthelago/base-studio-code)");

/// A configured blocking OSV client.
pub struct Osv {
    client: reqwest::blocking::Client,
    base: String,
}

// ── pure request/response shaping (fixture-tested) ───────────────────────────

/// The `/v1/query` request body for one package.
pub fn query_body(pkg: &Package) -> Value {
    let mut body = json!({ "package": { "name": pkg.name, "ecosystem": pkg.ecosystem.osv() } });
    if let Some(v) = &pkg.version {
        body["version"] = json!(v);
    }
    body
}

/// The `/v1/querybatch` request body for many packages.
pub fn batch_body(pkgs: &[Package]) -> Value {
    json!({ "queries": pkgs.iter().map(query_body).collect::<Vec<_>>() })
}

/// Parse a `/v1/query` (or `/v1/vulns/{id}` list) response's `vulns` array into advisories.
pub fn parse_vulns(resp: &Value) -> Vec<Advisory> {
    resp.get("vulns")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().map(Advisory::from_osv).collect())
        .unwrap_or_default()
}

/// Parse a `/v1/querybatch` response into per-query vuln-id lists, aligned to the request order.
/// (Batch responses carry only `{id, modified}` stubs, so ids are hydrated separately via `get`.)
pub fn parse_batch_ids(resp: &Value) -> Vec<Vec<String>> {
    resp.get("results")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .map(|res| {
                    res.get("vulns")
                        .and_then(|v| v.as_array())
                        .map(|vs| vs.iter().filter_map(|x| x.get("id").and_then(|i| i.as_str()).map(str::to_string)).collect())
                        .unwrap_or_default()
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Osv {
    /// Build a client with sensible timeouts. The base URL is overridable via `$BSC_OSV_BASE` (for a
    /// local mock / an air-gapped mirror proxy); default is the public OSV API.
    pub fn from_env() -> Result<Osv, String> {
        let client = reqwest::blocking::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("osv client build failed: {e}"))?;
        let base = std::env::var("BSC_OSV_BASE")
            .ok()
            .map(|s| s.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_BASE.to_string());
        Ok(Osv { client, base })
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, String> {
        let url = format!("{}{path}", self.base);
        let resp = self.client.post(&url).json(body).send().map_err(|e| format!("POST {url} failed: {e}"))?;
        let status = resp.status();
        let text = resp.text().map_err(|e| format!("POST {url} read body failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("POST {url} → HTTP {status}"));
        }
        serde_json::from_str(&text).map_err(|e| format!("POST {url} bad JSON: {e}"))
    }
}

impl VulnSource for Osv {
    fn query(&self, pkg: &Package) -> Result<Vec<Advisory>, String> {
        let resp = self.post("/v1/query", &query_body(pkg))?;
        Ok(parse_vulns(&resp))
    }

    fn query_batch(&self, pkgs: &[Package]) -> Result<Vec<Vec<Advisory>>, String> {
        if pkgs.is_empty() {
            return Ok(Vec::new());
        }
        let resp = self.post("/v1/querybatch", &batch_body(pkgs))?;
        let id_lists = parse_batch_ids(&resp);
        // Hydrate each UNIQUE id once (a CVE can hit many packages in one lockfile), then map back.
        let mut hydrated: std::collections::HashMap<String, Advisory> = std::collections::HashMap::new();
        let mut out = Vec::with_capacity(pkgs.len());
        for ids in id_lists.iter() {
            let mut advs = Vec::new();
            for id in ids {
                if !hydrated.contains_key(id) {
                    if let Some(a) = self.get(id)? {
                        hydrated.insert(id.clone(), a);
                    }
                }
                if let Some(a) = hydrated.get(id) {
                    advs.push(a.clone());
                }
            }
            out.push(advs);
        }
        // A batch response missing/short of the request length: pad so alignment holds.
        while out.len() < pkgs.len() {
            out.push(Vec::new());
        }
        Ok(out)
    }

    fn get(&self, id: &str) -> Result<Option<Advisory>, String> {
        let url = format!("{}/v1/vulns/{id}", self.base);
        let resp = self.client.get(&url).send().map_err(|e| format!("GET {url} failed: {e}"))?;
        if resp.status().as_u16() == 404 {
            return Ok(None);
        }
        let status = resp.status();
        let text = resp.text().map_err(|e| format!("GET {url} read body failed: {e}"))?;
        if !status.is_success() {
            return Err(format!("GET {url} → HTTP {status}"));
        }
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("GET {url} bad JSON: {e}"))?;
        Ok(Some(Advisory::from_osv(&v)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Ecosystem, Severity};

    #[test]
    fn query_body_includes_version_when_present() {
        let b = query_body(&Package::new(Ecosystem::Npm, "lodash", Some("4.17.0".into())));
        assert_eq!(b["package"]["name"], "lodash");
        assert_eq!(b["package"]["ecosystem"], "npm");
        assert_eq!(b["version"], "4.17.0");
        // Versionless → no version key.
        let b = query_body(&Package::new(Ecosystem::Cargo, "time", None));
        assert_eq!(b["package"]["ecosystem"], "crates.io");
        assert!(b.get("version").is_none());
    }

    #[test]
    fn batch_body_wraps_each_package_as_a_query() {
        let pkgs = vec![
            Package::new(Ecosystem::Npm, "a", Some("1".into())),
            Package::new(Ecosystem::Pypi, "b", Some("2".into())),
        ];
        let b = batch_body(&pkgs);
        let qs = b["queries"].as_array().unwrap();
        assert_eq!(qs.len(), 2);
        assert_eq!(qs[1]["package"]["ecosystem"], "PyPI");
    }

    #[test]
    fn parse_vulns_maps_the_array() {
        let resp = serde_json::json!({ "vulns": [
            { "id": "GHSA-1", "summary": "one", "severity": [{ "score": "9.1" }] },
            { "id": "GHSA-2", "details": "two\nmore" }
        ]});
        let advs = parse_vulns(&resp);
        assert_eq!(advs.len(), 2);
        assert_eq!(advs[0].id, "GHSA-1");
        assert_eq!(advs[0].severity, Severity::Critical);
        assert_eq!(advs[1].summary, "two");
        // No vulns key → empty.
        assert!(parse_vulns(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn parse_batch_ids_aligns_and_extracts_ids() {
        let resp = serde_json::json!({ "results": [
            { "vulns": [{ "id": "GHSA-1", "modified": "t" }, { "id": "GHSA-2" }] },
            {},
            { "vulns": [] }
        ]});
        let ids = parse_batch_ids(&resp);
        assert_eq!(ids, vec![vec!["GHSA-1".to_string(), "GHSA-2".to_string()], vec![], vec![]]);
    }
}
