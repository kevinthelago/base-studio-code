//! The Deploy stage's two structured halves, each one JSON blob per project (single row):
//! - deploy config (#1020) — the DeployConfig shape, durable in plan.db instead of a `<deploy_config>` tag.
//! - dependency manifest (#1191) — the locked library manifest (`{ dependencies, registries }`), was a
//!   raw `dependencies.json`; now durable here so the plan.db ⇄ GitHub recovery path round-trips it.

use crate::Store;

impl Store {
    /// Replace the project's deploy config (a single JSON blob — the full DeployConfig shape).
    pub fn deploy_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("deploy", data)
    }

    /// The stored deploy config, or None if unset.
    pub fn deploy_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("deploy")
    }

    /// Replace the project's dependency manifest (a single JSON blob — the full DependencyManifest shape).
    pub fn deps_set(&self, data: &serde_json::Value) -> rusqlite::Result<()> {
        self.blob_set("deps", data)
    }

    /// The stored dependency manifest, or None if unset.
    pub fn deps_get(&self) -> rusqlite::Result<Option<serde_json::Value>> {
        self.blob_get("deps")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deploy_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.deploy_get().unwrap().is_none());
        let cfg = serde_json::json!({ "services": [{ "id": "api", "platform": "fly" }], "release": { "strategy": "rolling" } });
        s.deploy_set(&cfg).unwrap();
        let got = s.deploy_get().unwrap().unwrap();
        assert_eq!(got["services"][0]["platform"], serde_json::json!("fly"));
        // a fresh set replaces the whole blob (single row)
        s.deploy_set(&serde_json::json!({ "services": [] })).unwrap();
        assert_eq!(s.deploy_get().unwrap().unwrap()["services"].as_array().unwrap().len(), 0);
        s.clear().unwrap();
        assert!(s.deploy_get().unwrap().is_none());
    }

    #[test]
    fn deps_set_get_round_trips_and_clears() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.deps_get().unwrap().is_none());
        let manifest = serde_json::json!({
            "dependencies": [
                { "repo": "owner/app", "ecosystem": "npm", "name": "zod", "version": "^3.23", "why": "schema validation" },
                { "repo": "owner/app", "ecosystem": "npm", "name": "@acme/ui", "version": "^2", "source": "internal", "why": "design system" }
            ],
            "registries": { "internal": { "url": "https://npm.internal/", "scope": "@acme", "auth": "INTERNAL_NPM_TOKEN" } }
        });
        s.deps_set(&manifest).unwrap();
        let got = s.deps_get().unwrap().unwrap();
        assert_eq!(got["dependencies"].as_array().unwrap().len(), 2);
        assert_eq!(got["dependencies"][0]["name"], serde_json::json!("zod"));
        assert_eq!(got["registries"]["internal"]["scope"], serde_json::json!("@acme"));
        // a fresh set replaces the whole blob (single row)
        s.deps_set(&serde_json::json!({ "dependencies": [], "registries": {} })).unwrap();
        assert_eq!(s.deps_get().unwrap().unwrap()["dependencies"].as_array().unwrap().len(), 0);
        s.clear().unwrap();
        assert!(s.deps_get().unwrap().is_none());
    }
}
