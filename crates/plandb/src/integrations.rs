//! Discovery-declared integrations (#4024) — the existing applications and APIs a project integrates
//! with, captured as DATA during the Discovery `integrations` topic rather than left as prose.
//!
//! `discovery/integrations.md` is still written; it stays the human-readable record. These rows are the
//! machine-readable half, because two surfaces need to ACT on the answer and neither can read markdown:
//! the **Source pane** offers the sources a project actually has, and the **Integrator** studio (#4023)
//! takes its work list from them. Declared once, in the only place the answer is genuinely known — the
//! conversation with the user — and read by both.
//!
//! `direction` is the load-bearing field and cannot be recovered later: a **source** is a system data
//! comes FROM (a migration, driving the Source pane), a **runtime** integration is one the built app
//! talks to while running. The same vendor can be either, and which one it is changes what downstream
//! does with it.

use crate::Store;
use rusqlite::params;

/// A system this project integrates with, as declared during Discovery.
// camelCase on the wire, like EVERY other plandb struct (`PlanIssue`/`PlanFeature`/`Lesson`/…). #4024
// shipped this one without the attribute, so it emitted `base_url` while its siblings emitted camelCase
// — corrected here, before anything consumed the odd one out. The CLI parser already accepted BOTH
// spellings on input; this makes the OUTPUT agree with that and with the rest of the store.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanIntegration {
    /// Stable slug — the id the Source pane and the Integrator both key off (`salesforce`, `stripe`).
    pub id: String,
    /// Display name, when it differs from the id ("Salesforce", "Stripe").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// `source` (data migrates FROM it) | `runtime` (the app talks to it while running).
    #[serde(default)]
    pub direction: String,
    /// The vendor documentation URL the Integrator starts from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docs: Option<String>,
    /// The API base URL, when known — what `bsc data connector probe` needs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// The auth scheme in prose ("OAuth2 client credentials", "bearer token"). NEVER a secret.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// One line: what the app actually needs from this system.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
}

/// The two `direction` values. Anything else is rejected at the CLI — a typo here would silently
/// hide an integration from whichever surface filters on the other value.
pub const DIRECTIONS: [&str; 2] = ["source", "runtime"];

/// The default when a declaration omits `direction`: the app talks to it at run time. Chosen because
/// it is the commoner case AND the safer default — a runtime integration wrongly offered as a
/// migration source is a visible mistake, whereas a migration source silently missing from the Source
/// pane is not.
pub const DEFAULT_DIRECTION: &str = "runtime";

impl Store {
    /// Upsert one declared integration (idempotent by `id`; declaration order preserved). An empty
    /// `direction` stores [`DEFAULT_DIRECTION`].
    pub fn integration_set(&self, i: &PlanIntegration) -> rusqlite::Result<()> {
        let id = i.id.trim();
        if id.is_empty() {
            return Ok(());
        }
        let direction = if i.direction.trim().is_empty() { DEFAULT_DIRECTION } else { i.direction.trim() };
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM integrations", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO integrations (id, name, direction, docs, base_url, auth, purpose, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%s','now'))
             ON CONFLICT(id) DO UPDATE SET
                name       = excluded.name,
                direction  = excluded.direction,
                docs       = excluded.docs,
                base_url   = excluded.base_url,
                auth       = excluded.auth,
                purpose    = excluded.purpose,
                updated_at = excluded.updated_at",
            params![id, i.name.trim(), direction, i.docs, i.base_url, i.auth, i.purpose, pos],
        )?;
        Ok(())
    }

    /// Every declared integration in declaration order, optionally filtered to one `direction`.
    pub fn integration_list(&self, direction: Option<&str>) -> rusqlite::Result<Vec<PlanIntegration>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, direction, docs, base_url, auth, purpose FROM integrations
             WHERE (?1 IS NULL OR direction = ?1) ORDER BY position, id",
        )?;
        let rows = stmt.query_map(params![direction], |r| {
            Ok(PlanIntegration {
                id: r.get(0)?,
                name: r.get(1)?,
                direction: r.get(2)?,
                docs: r.get(3)?,
                base_url: r.get(4)?,
                auth: r.get(5)?,
                purpose: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// Drop a declared integration by `id` (no-op if absent).
    pub fn integration_remove(&self, id: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM integrations WHERE id = ?1", params![id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn integ(id: &str, direction: &str) -> PlanIntegration {
        PlanIntegration { id: id.into(), direction: direction.into(), ..Default::default() }
    }

    // ── the cross-project roll-up (#4055) ────────────────────────────────────────────────────────

    /// A scratch `plans/` holding real stores, so the scan is exercised against SQLite rather than a
    /// stand-in. The dir removes itself.
    struct Plans(std::path::PathBuf);
    impl Drop for Plans {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    impl Plans {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("bsc-scan-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Plans(d)
        }
        /// Create `<key>.db` and declare `ids` in it.
        fn project(&self, key: &str, ids: &[(&str, &str)]) {
            let s = Store::open(&self.0.join(format!("{key}.db"))).unwrap();
            for (id, dir) in ids {
                s.integration_set(&integ(id, dir)).unwrap();
            }
        }
    }

    /// THE CORE CLAIM: every project's declarations come back, and each one says whose it is.
    #[test]
    fn the_scan_rolls_up_every_project_and_tags_each_entry() {
        let p = Plans::new("rollup");
        p.project("alpha", &[("stripe", "runtime"), ("salesforce", "source")]);
        p.project("beta", &[("stripe", "runtime")]);

        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.scanned, 2);
        assert!(scan.unreadable.is_empty(), "{scan:?}");
        let pairs: Vec<(&str, &str)> = scan
            .integrations
            .iter()
            .map(|d| (d.project.as_str(), d.integration.id.as_str()))
            .collect();
        // Sorted by (project, id) — stable across runs, so an agent diffing its work list sees no
        // churn from directory order.
        assert_eq!(
            pairs,
            vec![("alpha", "salesforce"), ("alpha", "stripe"), ("beta", "stripe")]
        );
    }

    /// The SAME integration id declared by two projects must stay two entries. Deduping by id would
    /// silently drop one project's need — and `stripe` wanted by two projects is the normal case.
    #[test]
    fn one_id_declared_by_two_projects_stays_two_entries() {
        let p = Plans::new("shared");
        p.project("alpha", &[("stripe", "runtime")]);
        p.project("beta", &[("stripe", "runtime")]);
        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.integrations.len(), 2, "{scan:?}");
        let projects: Vec<&str> = scan.integrations.iter().map(|d| d.project.as_str()).collect();
        assert_eq!(projects, vec!["alpha", "beta"]);
    }

    /// Declaring nothing is the NORMAL state — most projects do. A store with no rows contributes a
    /// scanned count and no entries, and is not an error.
    #[test]
    fn a_project_that_declares_nothing_is_counted_and_silent() {
        let p = Plans::new("empty");
        p.project("quiet", &[]);
        p.project("loud", &[("stripe", "runtime")]);
        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.scanned, 2, "a silent project is still scanned: {scan:?}");
        assert_eq!(scan.integrations.len(), 1);
        assert!(scan.unreadable.is_empty());
    }

    /// An absent `plans/` is an install with no projects — an empty scan, never a failure.
    #[test]
    fn an_absent_plans_dir_is_an_empty_scan_not_an_error() {
        let scan = scan_declared_integrations(std::path::Path::new("/nope/not/here"), None);
        assert_eq!(scan, IntegrationScan::default());
    }

    /// A store that cannot be OPENED is REPORTED, not skipped.
    ///
    /// This is the distinction that keeps the list honest: an empty work list and an empty work list
    /// *because a store failed to open* look identical to the agent unless the scan says so. Silent
    /// skipping is the exact omission `Store::open_for_scan`'s own doc calls out.
    #[test]
    fn a_store_that_cannot_be_opened_is_reported_rather_than_skipped() {
        let p = Plans::new("broken");
        p.project("good", &[("stripe", "runtime")]);
        // A `.db` that is not a database at all.
        std::fs::write(p.0.join("corrupt.db"), b"this is not sqlite").unwrap();

        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.scanned, 2, "both were examined: {scan:?}");
        assert_eq!(scan.integrations.len(), 1, "only the good one contributed rows");
        assert_eq!(scan.unreadable, vec!["corrupt".to_string()], "the bad one must be NAMED: {scan:?}");
    }

    /// A store PREDATING the integrations table reads as "declared nothing", not as unreadable.
    ///
    /// This is the case `is_missing_table` exists for, and it is the difference between a normal
    /// state and an alarm. Built as a real SQLite database with no such table rather than mocked, so
    /// the actual rusqlite error is what gets classified.
    #[test]
    fn a_store_predating_the_integrations_table_reads_as_empty_not_unreadable() {
        let p = Plans::new("oldschema");
        let old = p.0.join("legacy.db");
        let conn = rusqlite::Connection::open(&old).unwrap();
        conn.execute_batch("CREATE TABLE something_else (x TEXT);").unwrap();
        drop(conn);

        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.scanned, 1);
        assert!(scan.integrations.is_empty(), "{scan:?}");
        assert!(
            scan.unreadable.is_empty(),
            "an old schema is a project that declared nothing, not a broken store: {scan:?}"
        );
    }

    /// THE SCAN MUST NOT MINT A STORE. A read that created 40 empty plan stores as a side effect
    /// would corrupt the estate, and `Store::open` would do exactly that.
    #[test]
    fn scanning_never_creates_a_plan_store() {
        let p = Plans::new("nomint");
        p.project("alpha", &[("stripe", "runtime")]);
        let dbs = || -> Vec<String> {
            let mut v: Vec<String> = std::fs::read_dir(&p.0)
                .unwrap()
                .flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|n| n.ends_with(".db"))
                .collect();
            v.sort();
            v
        };
        let before = dbs();
        scan_declared_integrations(&p.0, None);
        assert_eq!(before, dbs(), "the scan minted a plan store");

        // MEASURED, and stated so it is not mistaken for a leak: the scan DOES create SQLite's
        // `-wal`/`-shm` sidecars, because these stores are in WAL mode and even a read-only
        // connection needs the shared-memory file. That is SQLite's business, not a new project —
        // the invariant is that no new `.db` appears, which is what "never mints a store" means.
        let names: Vec<String> = std::fs::read_dir(&p.0)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(names.iter().any(|n| n.ends_with("-wal") || n.ends_with("-shm")), "{names:?}");
    }

    /// `direction` filters, because the two halves have different consumers: the Source pane wants
    /// `source`, a runtime integration is the built app's business.
    #[test]
    fn the_scan_filters_by_direction() {
        let p = Plans::new("direction");
        p.project("alpha", &[("stripe", "runtime"), ("salesforce", "source")]);
        let sources = scan_declared_integrations(&p.0, Some("source"));
        let ids: Vec<&str> = sources.integrations.iter().map(|d| d.integration.id.as_str()).collect();
        assert_eq!(ids, vec!["salesforce"]);
        assert_eq!(scan_declared_integrations(&p.0, Some("runtime")).integrations.len(), 1);
    }

    /// A non-`.db` file in `plans/` is not a project. SQLite's own `-wal`/`-shm` sidecars live here,
    /// and counting them would invent projects named `alpha.db-wal`.
    #[test]
    fn only_db_files_are_treated_as_plan_stores() {
        let p = Plans::new("sidecars");
        p.project("alpha", &[("stripe", "runtime")]);
        std::fs::write(p.0.join("alpha.db-wal"), b"").unwrap();
        std::fs::write(p.0.join("notes.txt"), b"").unwrap();
        let scan = scan_declared_integrations(&p.0, None);
        assert_eq!(scan.scanned, 1, "only alpha.db is a store: {scan:?}");
    }

    /// The tagged entry serializes FLAT — `project` beside the integration's own fields — so an agent
    /// reads one object per row rather than having to reach through a wrapper.
    #[test]
    fn a_tagged_entry_serializes_flat_and_carries_no_secret_field() {
        let d = DeclaredIntegration {
            project: "alpha".into(),
            integration: PlanIntegration {
                id: "stripe".into(),
                direction: "runtime".into(),
                auth: Some("bearer token".into()),
                ..Default::default()
            },
        };
        let v = serde_json::to_value(&d).unwrap();
        assert_eq!(v["project"], "alpha");
        assert_eq!(v["id"], "stripe", "the integration's fields are FLAT, not nested: {v}");
        // `auth` is the SCHEME in prose. There is no field on this type that can hold a credential,
        // which is how "secrets never cross this path" is guaranteed rather than policed.
        assert_eq!(v["auth"], "bearer token");
        for forbidden in ["token", "secret", "password", "apiKey", "accessToken"] {
            assert!(v.get(forbidden).is_none(), "no credential-bearing field may exist: {v}");
        }
    }

    #[test]
    fn set_list_remove_preserves_declaration_order_and_is_idempotent() {
        let s = Store::open_in_memory().unwrap();
        assert!(s.integration_list(None).unwrap().is_empty());
        s.integration_set(&integ("salesforce", "source")).unwrap();
        s.integration_set(&integ("stripe", "runtime")).unwrap();
        s.integration_set(&integ("salesforce", "source")).unwrap(); // re-declare — not a duplicate
        let all = s.integration_list(None).unwrap();
        assert_eq!(all.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["salesforce", "stripe"]);
        s.integration_remove("salesforce").unwrap();
        assert_eq!(s.integration_list(None).unwrap().len(), 1);
        // A reset clears them with the rest of the plan.
        s.clear().unwrap();
        assert!(s.integration_list(None).unwrap().is_empty());
    }

    /// The whole point of `direction`: the Source pane asks for `source`, the Integrator for the rest.
    /// A filter that leaked the other kind would offer a payment API as a migration source.
    #[test]
    fn filters_by_direction() {
        let s = Store::open_in_memory().unwrap();
        s.integration_set(&integ("salesforce", "source")).unwrap();
        s.integration_set(&integ("netsuite", "source")).unwrap();
        s.integration_set(&integ("stripe", "runtime")).unwrap();
        let sources = s.integration_list(Some("source")).unwrap();
        assert_eq!(sources.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["salesforce", "netsuite"]);
        let runtime = s.integration_list(Some("runtime")).unwrap();
        assert_eq!(runtime.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), ["stripe"]);
    }

    #[test]
    fn re_declaring_updates_every_field_in_place() {
        let s = Store::open_in_memory().unwrap();
        s.integration_set(&integ("stripe", "runtime")).unwrap();
        s.integration_set(&PlanIntegration {
            id: "stripe".into(),
            name: "Stripe".into(),
            direction: "runtime".into(),
            docs: Some("https://docs.stripe.com/api".into()),
            base_url: Some("https://api.stripe.com".into()),
            auth: Some("bearer token".into()),
            purpose: Some("charge cards and read payouts".into()),
        })
        .unwrap();
        let all = s.integration_list(None).unwrap();
        assert_eq!(all.len(), 1, "a re-declare updates, never appends");
        assert_eq!(all[0].name, "Stripe");
        assert_eq!(all[0].docs.as_deref(), Some("https://docs.stripe.com/api"));
        assert_eq!(all[0].purpose.as_deref(), Some("charge cards and read payouts"));
    }

    /// An omitted direction must not become an empty string — a row nothing matches is worse than a
    /// row in the wrong bucket, because neither surface would ever show it.
    #[test]
    fn an_omitted_direction_defaults_rather_than_storing_empty() {
        let s = Store::open_in_memory().unwrap();
        s.integration_set(&PlanIntegration { id: "unspecified".into(), ..Default::default() }).unwrap();
        assert_eq!(s.integration_list(None).unwrap()[0].direction, DEFAULT_DIRECTION);
        assert_eq!(s.integration_list(Some(DEFAULT_DIRECTION)).unwrap().len(), 1);
    }

    #[test]
    fn a_blank_id_is_ignored_rather_than_stored() {
        let s = Store::open_in_memory().unwrap();
        s.integration_set(&integ("   ", "runtime")).unwrap();
        assert!(s.integration_list(None).unwrap().is_empty());
    }
}

#[cfg(test)]
mod wire_tests {
    use super::*;

    /// #4054: the JSON the Source pane reads must be camelCase, like every sibling struct. #4024
    /// shipped without `rename_all`, emitting `base_url`; a consumer written against that would have
    /// silently missed the field the moment it was corrected.
    #[test]
    fn serializes_camel_case_and_round_trips_both_spellings() {
        let i = PlanIntegration {
            id: "salesforce".into(),
            direction: "source".into(),
            base_url: Some("https://acme.my.salesforce.com".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&i).unwrap();
        assert!(json.contains("\"baseUrl\""), "wire is camelCase: {json}");
        assert!(!json.contains("\"base_url\""), "the snake spelling must not survive: {json}");
        // And it reads its own output back unchanged.
        assert_eq!(serde_json::from_str::<PlanIntegration>(&json).unwrap(), i);
    }

    /// Absent optionals stay ABSENT rather than serializing as null — a consumer checking
    /// `if (row.docs)` must not be handed an explicit null where the field was simply never given.
    #[test]
    fn omits_absent_optionals_entirely() {
        let json = serde_json::to_string(&PlanIntegration { id: "x".into(), ..Default::default() }).unwrap();
        for absent in ["docs", "baseUrl", "auth", "purpose", "name"] {
            assert!(!json.contains(absent), "{absent} must be omitted when unset: {json}");
        }
    }
}

// ── the cross-project roll-up ───────────────────────────────────────────────────────────────────

/// One declared integration, tagged with the project that declared it.
///
/// The tagging is the whole point of the roll-up. The Integrator is a global singleton with no
/// project context (#4023), so a work list that cannot say WHICH project wanted an integration is a
/// list it cannot act on — it would not know whose base URL to probe or whose director to report to.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredIntegration {
    /// The project key — the plan store's filename stem, which is the mapping the app already uses.
    pub project: String,
    #[serde(flatten)]
    pub integration: PlanIntegration,
}

/// The result of a scan: what was declared, and what could not be read.
///
/// `unreadable` is NOT an afterthought. A scan that silently skipped a store it could not open would
/// report an incomplete list as if it were complete — the same class of omission `Store::open_for_scan`
/// exists to remove, and the reason its doc calls silent skipping out by name. An empty `integrations`
/// is a normal state; an empty one *because three stores failed to open* is not, and the caller must be
/// able to tell those apart.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrationScan {
    /// Every declared integration, tagged by project. Sorted by (project, id) so the output is stable
    /// across runs — an agent diffing its work list must not see spurious churn from directory order.
    pub integrations: Vec<DeclaredIntegration>,
    /// How many plan stores were examined, including those that declared nothing.
    pub scanned: usize,
    /// Project keys whose store could not be opened, so a short list is never mistaken for a complete
    /// one. Sorted, for the same stability reason.
    pub unreadable: Vec<String>,
}

/// Whether a query failed only because the table is absent — an older plan store that predates the
/// integrations table (#4024), which is a project that declared nothing rather than a broken store.
///
/// Matched on the message because rusqlite reports it as a generic `SqliteFailure` with
/// `SQLITE_ERROR`, the same code a syntax error produces; the message is the only thing that
/// distinguishes them. Deliberately NARROW — every other error, corruption included, falls through to
/// being reported.
fn is_missing_table(e: &rusqlite::Error) -> bool {
    e.to_string().contains("no such table")
}

/// Every Discovery-declared integration across every plan store in `plans_dir`, tagged by project.
///
/// This is the Integrator's work list (#4055) and the source of Glance's project→integration edge —
/// one read serving both, so the two cannot disagree about which projects want what.
///
/// Three properties it must have, each of which is a decision:
///
/// * **It never mints a store.** Opening goes through [`Store::open_for_scan`], which fails rather
///   than creating — a scan that created 40 empty plan stores as a side effect of *reading* would be
///   a spectacular way to corrupt the estate.
/// * **A store with nothing declared is a normal, silent zero.** Most projects declare nothing, and an
///   older store predating the integrations table reads as "declared nothing" rather than as a failure.
///   That tolerance mirrors `fleet_session_list_or_empty`.
/// * **A store that cannot be OPENED is reported, not skipped.** See [`IntegrationScan::unreadable`].
///
/// `direction` filters to `source` or `runtime` when given; `None` returns both. No secret can cross
/// this path: [`PlanIntegration`] carries the auth *scheme* in prose and has no field for a
/// credential, and nothing here touches the keychain or the connector store.
pub fn scan_declared_integrations(
    plans_dir: &std::path::Path,
    direction: Option<&str>,
) -> IntegrationScan {
    let mut out = IntegrationScan::default();
    let Ok(entries) = std::fs::read_dir(plans_dir) else {
        // An absent `plans/` is an install with no projects yet — zero, not a failure.
        return out;
    };
    let mut dbs: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "db"))
        .collect();
    dbs.sort();

    for db in dbs {
        // The project key is the store's filename stem — the same mapping `bsc fleet` reads and the
        // app's own `plans/<key>.db` layout guarantees.
        let Some(project) = db.file_stem().map(|s| s.to_string_lossy().into_owned()) else { continue };
        if project.is_empty() {
            continue;
        }
        out.scanned += 1;
        let Ok(store) = Store::open_for_scan(&db) else {
            out.unreadable.push(project);
            continue;
        };
        // THE FAILURE ARRIVES HERE, NOT AT open(). SQLite is lazy: it does not read the file header
        // until a statement runs, so a `.db` holding arbitrary bytes OPENS cleanly and only fails on
        // the first query. An `unwrap_or_default()` here would therefore report a corrupt store as a
        // project that declared nothing — the precise silent omission `unreadable` exists to prevent,
        // with the check written one layer too high. Measured: a file containing "this is not sqlite"
        // opened Ok and read as empty.
        //
        // So the two cases are told apart by the error. A MISSING TABLE is a store whose schema
        // predates the integrations table (#4024) — a project that declared nothing, and normal, the
        // same tolerance `fleet_session_list_or_empty` applies. Anything else is a store that could
        // not be read, and is named.
        match store.integration_list(direction) {
            Ok(rows) => {
                for i in rows {
                    out.integrations
                        .push(DeclaredIntegration { project: project.clone(), integration: i });
                }
            }
            Err(e) if is_missing_table(&e) => {}
            Err(_) => out.unreadable.push(project),
        }
    }
    out.integrations.sort_by(|a, b| {
        (&a.project, &a.integration.id).cmp(&(&b.project, &b.integration.id))
    });
    out.unreadable.sort();
    out
}
