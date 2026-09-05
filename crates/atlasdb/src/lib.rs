//! Product feature-inventory store (`~/.base-studio-code/atlas.db`) — the RELATIONAL one.
//!
//! Holds competitive feature inventories: which products exist in a domain, what capabilities each
//! ships, and which features sit under each capability. It is the reference corpus an architect or a
//! marketer consults when deciding what a generated application should contain.
//!
//! # Why a store of its own, and why relational
//!
//! `bsc data` is the wrong home twice over: it is PER-PROJECT (it needs a `--db`), and it is
//! read-only for rows — its rows are materialised by CONNECTORS scanning a live source system, which
//! a curated corpus is not. A document store (`bsc-json-store`, behind persona/blueprint/teams) is
//! the wrong shape for a different reason: this corpus's value is the JOIN. Measured on the source,
//! 122 capability labels appear in more than one product, covering 44% of the rows — `integrations`
//! spans 22 products across 5 domains. "Which products ship automation?" should be a join, not a scan
//! of every document.
//!
//! # The capability table is the load-bearing decision
//!
//! [`Capability`] is its own table rather than a string on each row, so the corpus ships with a raw,
//! honest vocabulary today and can be CURATED later — merging `Forecasting` into
//! `Pipeline & Forecasting` becomes an update to one row instead of a reshape of 1,007. The source
//! bullets are written per-vendor and their labels do not agree; pretending otherwise at import time
//! would bake one vendor's phrasing into the schema.
//!
//! Tauri-free on purpose (like `skilldb`): the app and the `bsc` binary both depend on it, so the CLI
//! stays small. WAL + a busy timeout, because the live app and a session's shell touch it at once.


use include_dir::{include_dir, Dir};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The packaged corpus — one JSON per PRODUCT under `corpus/<domain>/<product>.json`, plus
/// `synthesis.json`. Generated from `docs/enterprise-atlas.md` by
/// `scripts/parse-enterprise-atlas.mjs --emit`, whose test asserts it loses no line.
///
/// Per product rather than per domain because a product's inventory is the unit that CHANGES: a
/// vendor ships something and exactly one file moves.
///
/// ## Why it lives in the CRATE and not in `src-tauri/data/`
///
/// `appModules.ts` does `import.meta.glob("@data/**/*.json", { eager: true })` — EVERY json under
/// `src-tauri/data` is eagerly bundled into the frontend and registered as a platform module. Putting
/// 73 backend-only corpus files there added ~1 MB to the app bundle for data the frontend never reads,
/// and broke the platform-modules manifest by growing the registry by exactly 73.
///
/// `src-tauri/data/` is the FRONTEND's data namespace. `skilldb` seeds from it correctly because the
/// frontend really does read skills (`src/shared/data/skills.ts` globs the same files);
/// `crates/compliance/corpus/` keeps its corpus in the crate because it is backend-only. So is this.
static CORPUS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/corpus");

/// One product's packaged inventory, as the seed files carry it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProductSeed {
    pub id: String,
    pub name: String,
    pub domain: String,
    #[serde(rename = "domainName")]
    pub domain_name: String,
    pub capabilities: Vec<CapabilitySeed>,
}

/// One capability line: a label, the verbatim detail, and the split features.
///
/// `detail` is kept beside `features` deliberately — the split is paren-aware but it is still a
/// convenience over the source, never a replacement for it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CapabilitySeed {
    pub slug: String,
    pub label: String,
    pub detail: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub nested: bool,
}

/// A domain — the top level of the corpus (CRM, ERP, ITSM…).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Domain {
    pub id: String,
    pub name: String,
    pub products: i64,
}

/// A product within a domain.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Product {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub capabilities: i64,
}

/// A capability, with how widely it is shared.
///
/// `products` is the whole point of the relational shape: a capability carried by 22 products across
/// 5 domains is a market-wide expectation, and one carried by a single product is a differentiator.
/// The corpus cannot tell you which is which; the join can.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Capability {
    pub slug: String,
    pub label: String,
    pub products: i64,
    pub domains: i64,
}

/// Open (creating if absent) and migrate. Seeds the packaged corpus on first open.
pub fn open(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    // The live app and a session's shell both touch this db; WAL lets them read while one writes,
    // and the timeout turns a lock collision into a wait rather than an error. Same settings skilldb
    // set for the same reason.
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    migrate(&conn)?;
    if count(&conn, "product")? == 0 {
        seed(&conn)?;
    }
    Ok(conn)
}

fn migrate(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS domain (
            id      TEXT PRIMARY KEY,
            name    TEXT NOT NULL,
            ordinal INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS product (
            id        TEXT PRIMARY KEY,
            domain_id TEXT NOT NULL REFERENCES domain(id) ON DELETE CASCADE,
            name      TEXT NOT NULL,
            ordinal   INTEGER NOT NULL DEFAULT 0
         );
         -- The canonical vocabulary. Raw slugs today; curation merges rows here without touching
         -- product_capability, which is the reason it is a table and not a column.
         CREATE TABLE IF NOT EXISTS capability (
            slug  TEXT PRIMARY KEY,
            label TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS product_capability (
            product_id      TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
            capability_slug TEXT NOT NULL REFERENCES capability(slug) ON DELETE CASCADE,
            detail          TEXT NOT NULL DEFAULT '',
            nested          INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (product_id, capability_slug)
         );
         CREATE TABLE IF NOT EXISTS feature (
            slug TEXT PRIMARY KEY,
            text TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS product_capability_feature (
            product_id      TEXT NOT NULL,
            capability_slug TEXT NOT NULL,
            feature_slug    TEXT NOT NULL REFERENCES feature(slug) ON DELETE CASCADE,
            ordinal         INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (product_id, capability_slug, feature_slug),
            FOREIGN KEY (product_id, capability_slug)
                REFERENCES product_capability(product_id, capability_slug) ON DELETE CASCADE
         );
         -- The cross-category synthesis: the universal patterns and the closing claim. Not a product
         -- inventory, so it is not forced into one — collapsing them would let analysis read as a
         -- vendor's feature.
         CREATE TABLE IF NOT EXISTS synthesis (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            kind    TEXT NOT NULL,
            section TEXT,
            domain  TEXT,
            label   TEXT NOT NULL,
            detail  TEXT NOT NULL DEFAULT ''
         );
         CREATE INDEX IF NOT EXISTS ix_pc_cap ON product_capability(capability_slug);
         CREATE INDEX IF NOT EXISTS ix_prod_domain ON product(domain_id);",
    )
    .map_err(|e| e.to_string())
}

fn count(conn: &Connection, table: &str) -> Result<i64, String> {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

/// `A Product (v2)` -> `a-product-v2`. Must agree with the emitter's `slug` in
/// `scripts/parse-enterprise-atlas.mjs`, or a re-seed would mint duplicate rows.
pub fn slug(s: &str) -> String {
    let lowered = s.to_lowercase().replace('&', " and ");
    let mut out = String::new();
    let mut dash = false;
    for ch in lowered.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out.chars().take(80).collect()
}


/// Depth-first walk of an embedded directory — `include_dir::Dir::files()` is one level only, and the
/// corpus nests one directory per domain.
fn collect<'a>(dir: &'a Dir<'a>, out: &mut Vec<&'a include_dir::File<'a>>) {
    out.extend(dir.files());
    for sub in dir.dirs() {
        collect(sub, out);
    }
}

/// Load the packaged corpus into an empty store. Idempotent per row (`INSERT OR REPLACE`), so a
/// `reseed` refreshes without duplicating.
pub fn seed(conn: &Connection) -> Result<usize, String> {
    let mut products = 0usize;
    let mut domain_ordinal = 0i64;
    let mut seen_domains: Vec<String> = Vec::new();

    // The corpus is NESTED (one directory per domain), so this walks rather than using `.files()`
    // like skilldb's flat skills dir. Collected first so the borrow ends before the inserts begin.
    let mut files: Vec<&include_dir::File> = Vec::new();
    collect(&CORPUS, &mut files);

    for file in files {
        let name = file.path().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        let body = file.contents_utf8().ok_or_else(|| format!("{name}: not utf-8"))?;

        if name.ends_with("synthesis.json") {
            seed_synthesis(conn, body)?;
            continue;
        }
        let p: ProductSeed = serde_json::from_str(body).map_err(|e| format!("{name}: {e}"))?;
        if !seen_domains.contains(&p.domain) {
            conn.execute(
                "INSERT INTO domain (id, name, ordinal) VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name",
                params![p.domain, p.domain_name, domain_ordinal],
            )
            .map_err(|e| e.to_string())?;
            seen_domains.push(p.domain.clone());
            domain_ordinal += 1;
        }
        conn.execute(
            "INSERT INTO product (id, domain_id, name, ordinal) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET domain_id = excluded.domain_id, name = excluded.name",
            params![p.id, p.domain, p.name, products as i64],
        )
        .map_err(|e| e.to_string())?;

        for (ci, c) in p.capabilities.iter().enumerate() {
            let _ = ci;
            // UPSERT, never `INSERT OR REPLACE`. That form is a DELETE + INSERT, and with
            // `ON DELETE CASCADE` on the child tables it silently destroys every existing link to
            // this row. Capability slugs are SHARED — 122 of them span multiple products — so each
            // later product re-declaring `integrations` was wiping every earlier product's link to
            // it. The corpus seeded 688 capability rows instead of 1,007: exactly one per distinct
            // slug, the last writer winning. Nothing errored; only the count knew.
            conn.execute(
                "INSERT INTO capability (slug, label) VALUES (?1, ?2)
                 ON CONFLICT(slug) DO UPDATE SET label = excluded.label",
                params![c.slug, c.label],
            )
            .map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT INTO product_capability (product_id, capability_slug, detail, nested)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(product_id, capability_slug)
                 DO UPDATE SET detail = excluded.detail, nested = excluded.nested",
                params![p.id, c.slug, c.detail, i64::from(c.nested)],
            )
            .map_err(|e| e.to_string())?;
            for (fi, f) in c.features.iter().enumerate() {
                let fs = slug(f);
                if fs.is_empty() {
                    continue;
                }
                conn.execute(
                    "INSERT INTO feature (slug, text) VALUES (?1, ?2)
                     ON CONFLICT(slug) DO UPDATE SET text = excluded.text",
                    params![fs, f],
                )
                .map_err(|e| e.to_string())?;
                conn.execute(
                    "INSERT INTO product_capability_feature
                       (product_id, capability_slug, feature_slug, ordinal) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(product_id, capability_slug, feature_slug)
                     DO UPDATE SET ordinal = excluded.ordinal",
                    params![p.id, c.slug, fs, fi as i64],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        products += 1;
    }
    Ok(products)
}

fn seed_synthesis(conn: &Connection, body: &str) -> Result<(), String> {
    #[derive(Deserialize)]
    struct Row {
        kind: String,
        section: Option<String>,
        domain: Option<String>,
        label: String,
        detail: String,
    }
    #[derive(Deserialize)]
    struct Doc {
        rows: Vec<Row>,
    }
    let doc: Doc = serde_json::from_str(body).map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM synthesis", []).map_err(|e| e.to_string())?;
    for r in doc.rows {
        conn.execute(
            "INSERT INTO synthesis (kind, section, domain, label, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![r.kind, r.section, r.domain, r.label, r.detail],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Reads ────────────────────────────────────────────────────────────────────
//
// Every read is SCOPED. There is no `dump`: the corpus is ~6,000 rows and the point of moving it out
// of a 48k-token markdown file was that a session asking about CRM should not pay for eCommerce.

/// Every domain, with its product count.
pub fn domains(conn: &Connection) -> Result<Vec<Domain>, String> {
    let mut st = conn
        .prepare(
            "SELECT d.id, d.name, (SELECT COUNT(*) FROM product p WHERE p.domain_id = d.id)
             FROM domain d ORDER BY d.ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| Ok(Domain { id: r.get(0)?, name: r.get(1)?, products: r.get(2)? }))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Products, optionally scoped to one domain.
pub fn products(conn: &Connection, domain: Option<&str>) -> Result<Vec<Product>, String> {
    let sql = "SELECT p.id, p.name, p.domain_id,
                      (SELECT COUNT(*) FROM product_capability pc WHERE pc.product_id = p.id)
               FROM product p WHERE (?1 IS NULL OR p.domain_id = ?1) ORDER BY p.ordinal";
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![domain], |r| {
            Ok(Product { id: r.get(0)?, name: r.get(1)?, domain: r.get(2)?, capabilities: r.get(3)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Capabilities, scoped by domain and/or product, and optionally only the SHARED ones.
///
/// `shared_only` is the comparative axis and the reason this store is relational: it answers "what
/// does this market expect?" — a capability carried by many products — as a query rather than as a
/// reading exercise.
pub fn capabilities(
    conn: &Connection,
    domain: Option<&str>,
    product: Option<&str>,
    shared_only: bool,
) -> Result<Vec<Capability>, String> {
    let sql = "SELECT c.slug, c.label,
                      COUNT(DISTINCT pc.product_id),
                      COUNT(DISTINCT p.domain_id)
               FROM capability c
               JOIN product_capability pc ON pc.capability_slug = c.slug
               JOIN product p            ON p.id = pc.product_id
               WHERE (?1 IS NULL OR p.domain_id = ?1)
                 AND (?2 IS NULL OR p.id = ?2)
               GROUP BY c.slug, c.label
               HAVING (?3 = 0 OR COUNT(DISTINCT pc.product_id) > 1)
               ORDER BY COUNT(DISTINCT pc.product_id) DESC, c.slug";
    let mut st = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![domain, product, i64::from(shared_only)], |r| {
            Ok(Capability { slug: r.get(0)?, label: r.get(1)?, products: r.get(2)?, domains: r.get(3)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// One product in full: its capabilities with detail and features.
pub fn product(conn: &Connection, id: &str) -> Result<Option<ProductSeed>, String> {
    let head = conn
        .query_row(
            "SELECT p.id, p.name, p.domain_id, d.name FROM product p
             JOIN domain d ON d.id = p.domain_id WHERE p.id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)),
        )
        .ok();
    let Some((pid, name, domain, domain_name)) = head else { return Ok(None) };

    let mut st = conn
        .prepare(
            "SELECT pc.capability_slug, c.label, pc.detail, pc.nested
             FROM product_capability pc JOIN capability c ON c.slug = pc.capability_slug
             WHERE pc.product_id = ?1 ORDER BY c.slug",
        )
        .map_err(|e| e.to_string())?;
    let caps: Vec<(String, String, String, bool)> = st
        .query_map(params![pid], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get::<_, i64>(3)? != 0))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;

    let mut capabilities = Vec::new();
    for (cslug, label, detail, nested) in caps {
        let mut fs = conn
            .prepare(
                "SELECT f.text FROM product_capability_feature pcf
                 JOIN feature f ON f.slug = pcf.feature_slug
                 WHERE pcf.product_id = ?1 AND pcf.capability_slug = ?2 ORDER BY pcf.ordinal",
            )
            .map_err(|e| e.to_string())?;
        let features: Vec<String> = fs
            .query_map(params![pid, cslug], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        capabilities.push(CapabilitySeed { slug: cslug, label, detail, features, nested });
    }
    Ok(Some(ProductSeed { id: pid, name, domain, domain_name, capabilities }))
}

/// Which products carry a capability — the inverse of [`capabilities`], for "who else does this?".
pub fn carriers(conn: &Connection, capability: &str) -> Result<Vec<Product>, String> {
    let mut st = conn
        .prepare(
            "SELECT p.id, p.name, p.domain_id,
                    (SELECT COUNT(*) FROM product_capability x WHERE x.product_id = p.id)
             FROM product p JOIN product_capability pc ON pc.product_id = p.id
             WHERE pc.capability_slug = ?1 ORDER BY p.ordinal",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map(params![capability], |r| {
            Ok(Product { id: r.get(0)?, name: r.get(1)?, domain: r.get(2)?, capabilities: r.get(3)? })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
}

/// Corpus totals — what `meta` prints, and what a migration is checked against.
pub fn meta(conn: &Connection) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "domains":      count(conn, "domain")?,
        "products":     count(conn, "product")?,
        "capabilities": count(conn, "capability")?,
        "capabilityRows": count(conn, "product_capability")?,
        "features":     count(conn, "feature")?,
        "featureLinks": count(conn, "product_capability_feature")?,
        "synthesis":    count(conn, "synthesis")?,
    }))
}

/// The default store path: one GLOBAL db beside the other user stores.
pub fn default_path() -> Result<std::path::PathBuf, String> {
    bsc_util::bsc_base_dir()
        .map(|b| b.join("atlas.db"))
        .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/cli.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get atlasdb--<module>.rs
//     bsc graph impl set --id atlasdb--<module>.rs --code-file <f>
//     bsc graph promote --id atlasdb--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `atlasdb--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));