//! `bsc-network` — the network-specific shim over the shared `bsc-json-store` (#2158).
//!
//! A **network** is a DOMAIN: a named set of projects that own one concern together — `kitchen`,
//! `finance`, `science` — and it owns **exactly one architect session**, the funnel's front door for
//! every project in it. Glance draws one network per tab; the architect node in that tab opens that
//! network's session.
//!
//! Before this store the app had NO grouping above a project. The only supra-project relations were the
//! nullable `architect` column on the project row and the global `bsc project link` contract table, so
//! "which projects belong together" had nowhere to live and every project shared one graph.
//!
//! # What is here, and what deliberately is not
//!
//! This store holds the network ENTITY — `{ id, name, architect?, position }` — and nothing else. The
//! ASSIGNMENT of a project to a network is a `network` column on the project row in `bsc-project`,
//! reached with `bsc project network set|clear`. That split is not arbitrary: it is exactly the seam
//! `architect` already uses (the persona lives in `bsc-persona`, the assignment is a column), and it
//! keeps a network from having to know the project list it would then have to keep in sync.
//!
//! # Naming
//!
//! A network id is MINTED and auto-disambiguated (`network-foo`, `network-foo-2`, …), the convention
//! every in-app library uses. It is deliberately NOT the `projectSlug`-plus-collision-modal discipline:
//! that exists only where an id names an on-disk hub recovered by derivation, and a network is a row.
//! Renaming is display-only — the id is frozen at creation, because the architect's pane id
//! (`network-<id>:architect`) and workspace dir are derived from it.

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs does not exist — it is a record in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-network--<module>.rs
//     bsc graph impl set --id bsc-network--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-network--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));

#[cfg(test)]
mod tests {
    use bsc_json_store::Store;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A per-test unique suffix so parallel tests never share a base dir. Keyed on the pid AND a
    /// counter: pid alone made the suite intermittently red under nextest, which runs each test in its
    /// own process but reuses pids across a long run.
    fn uniq() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// #2986 (epic #2982) regression, carried to this store on day one rather than after the fact: the
    /// network store persists to a SQLite **`networks.db`**, NOT to per-id `networks/<id>.json` files.
    /// #2983 migrated the shared `bsc-json-store` backend JSON-files → SQLite transparently, and every
    /// shim pins that it actually rides it — a shim that quietly wrote files would still pass every
    /// behavioural test while orphaning its data from the rest of the app.
    ///
    /// The crate exposes no base-dir-injectable API (only the `bsc network` CLI), so this drives the
    /// shared `Store` directly with the network store's own segment + noun, mirroring `cli::SPEC`.
    #[test]
    fn network_store_persists_to_sqlite_not_json_files() {
        let base = std::env::temp_dir().join(format!("bsc-network-sqlite-{}", uniq()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // The network store exactly as its CLI configures it (mirrors `cli::SPEC.dir_segment` / `.noun`).
        let store = Store::new(base.join("networks"), "network");

        let network = r#"{"id":"network-kitchen","name":"kitchen","position":0}"#;
        store.set("network-kitchen", network).unwrap();
        assert_eq!(
            store.get("network-kitchen").unwrap().as_deref(),
            Some(network),
            "the network reads back verbatim",
        );
        assert_eq!(store.list(), vec![network.to_string()], "and lists from the db");

        // The claim — SQLite, not files.
        let db = base.join("networks.db");
        assert!(db.is_file(), "networks.db exists after the write: {}", db.display());
        let legacy = base.join("networks").join("network-kitchen.json");
        assert!(!legacy.exists(), "no per-id json file was written: {}", legacy.display());
        assert!(
            !base.join("networks").exists(),
            "no file-based `networks/` store dir was created",
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
