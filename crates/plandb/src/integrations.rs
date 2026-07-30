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
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
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
