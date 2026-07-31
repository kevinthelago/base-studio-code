//! Features (#plan-db) — a capability AND a fleet stream. The `PlanFeature` record + the
//! titles-first CRUD/render, plus the `slugify` helper (mirrors the frontend `slugify`).

use crate::{phase_from_db, phase_to_db, Store};
use bsc_sqlite_util::{arr_to_json, json_to_arr};
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// A planned feature — a capability AND a fleet stream (#plan-db). Not just user-facing: a feature
/// can be foundational (an engine core, a data model) that others build on. The roster forms a
/// dependency DAG via `dependsOn`, so the layering lives on the features themselves. The Features
/// stage works titles-first: register the whole roster (name only), then fill each in one at a time.
/// Mirrors the frontend `PlanFeature`; `serde` emits the camelCase JSON `parseFeaturesFile` reads. A
/// feature is "defined" once it has a name, behavior, and ≥1 acceptance.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanFeature {
    /// Stable slug / stream id (kebab-case). Derived from `name` when omitted. Optional on input so
    /// a detail-fill payload can carry just the slug (the merge keeps the stored name).
    #[serde(default)]
    pub slug: String,
    /// Capability name ("Invite teammates", "Geometry kernel"). Optional on input for the same reason.
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behavior: Option<String>,
    /// The roadmap phase this feature is sequenced into (a 1-based number or its name) — assigned in
    /// the Plan stage; becomes the GitHub milestone at publish. Kept as a raw JSON value so the
    /// number/string distinction survives (like PlanIssue.phase).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<serde_json::Value>,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approach: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    /// Feature slugs this feature builds on — the coarse roadmap DAG. Must stay acyclic (a cycle is
    /// a planning deadlock); fine-grained ordering lives in issue `dependsOn`.
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    /// The fleet stream that owns it (defaults to the slug — a feature IS a stream).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream: Option<String>,
    /// Algorithm impl ids from the GLOBAL `bsc graph` store that this capability needs (#4080) — the
    /// plan → algorithms-graph edge, so a worker building this feature is pointed at the reference
    /// implementation instead of re-coding it (the `reimplemented-component` problem, #3892, one layer
    /// up and caught BEFORE the code is written).
    ///
    /// The feature points at the library; the library never learns about projects. Making the global
    /// graph project-aware would be #3973's mistake in another costume — an estate-level store absorbing
    /// detail that belongs inside one application. `requires` is also the name Glance already uses for a
    /// project/page → algorithm-library edge (#3119), so the vocabulary matches at both altitudes.
    ///
    /// DECLARED intent, not derived fact: the planner names what the capability needs at Features time.
    /// A curator-derived "what the landed code actually used" is the follow-on, and the gap between the
    /// two is the interesting signal. NOT validated against the graph — the two stores are separate and
    /// the graph may be unreachable when a plan is written, so a wrong id is a dangling reference, not a
    /// corrupt plan.
    #[serde(default)]
    pub requires: Vec<String>,
}

/// kebab-case slug from a name (mirrors the frontend `slugify`).
pub(crate) fn slugify(name: &str) -> String {
    let mut s = String::new();
    let mut prev_dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c);
            prev_dash = false;
        } else if !prev_dash && !s.is_empty() {
            s.push('-');
            prev_dash = true;
        }
    }
    while s.ends_with('-') {
        s.pop();
    }
    s.chars().take(60).collect()
}

impl Store {
    // ── features (#plan-db) ──────────────────────────────────────────────────────
    // Titles-first: `feature add {name}` registers a roster entry; later `add`s carrying details
    // (keyed by slug) MERGE in place — an empty/absent field never clobbers an existing value — so
    // the planner can lay out the whole list, then populate each one at a time without losing work.

    /// Insert or merge a feature by `slug` (derived from `name` when blank). On conflict each
    /// supplied non-empty field overwrites; empty/absent fields keep the stored value, so detailing
    /// a previously-registered title doesn't wipe the name (and vice-versa). Returns the slug used.
    pub fn feature_upsert(&self, feature: &PlanFeature) -> rusqlite::Result<String> {
        let slug = if feature.slug.trim().is_empty() { slugify(&feature.name) } else { feature.slug.trim().to_string() };
        let pos: i64 = self
            .conn
            .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM features", [], |r| r.get(0))?;
        self.conn.execute(
            "INSERT INTO features (slug, name, behavior, phase, approach, data, stream, acceptance, tools, depends_on, requires, position, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, strftime('%s','now'))
             ON CONFLICT(slug) DO UPDATE SET
                name       = CASE WHEN excluded.name != ''                          THEN excluded.name       ELSE features.name       END,
                behavior   = CASE WHEN COALESCE(excluded.behavior, '') != ''         THEN excluded.behavior   ELSE features.behavior   END,
                phase      = CASE WHEN COALESCE(excluded.phase, '') != ''            THEN excluded.phase      ELSE features.phase      END,
                approach   = CASE WHEN COALESCE(excluded.approach, '') != ''         THEN excluded.approach   ELSE features.approach   END,
                data       = CASE WHEN COALESCE(excluded.data, '') != ''             THEN excluded.data       ELSE features.data       END,
                stream     = CASE WHEN COALESCE(excluded.stream, '') != ''           THEN excluded.stream     ELSE features.stream     END,
                acceptance = CASE WHEN excluded.acceptance != '[]'                   THEN excluded.acceptance ELSE features.acceptance END,
                tools      = CASE WHEN excluded.tools != '[]'                        THEN excluded.tools      ELSE features.tools      END,
                depends_on = CASE WHEN excluded.depends_on != '[]'                   THEN excluded.depends_on ELSE features.depends_on END,
                requires   = CASE WHEN excluded.requires != '[]'                     THEN excluded.requires   ELSE features.requires   END,
                updated_at = excluded.updated_at",
            params![
                slug, feature.name, feature.behavior, phase_to_db(&feature.phase), feature.approach, feature.data,
                feature.stream, arr_to_json(&feature.acceptance), arr_to_json(&feature.tools),
                arr_to_json(&feature.depends_on), arr_to_json(&feature.requires), pos,
            ],
        )?;
        Ok(slug)
    }

    /// Fetch one feature by `slug`, or `None`.
    pub fn feature_get(&self, slug: &str) -> rusqlite::Result<Option<PlanFeature>> {
        let mut stmt = self.conn.prepare(&format!("{FEATURE_COLS} WHERE slug = ?1"))?;
        let mut rows = stmt.query_map(params![slug], row_to_feature)?;
        match rows.next() {
            Some(r) => Ok(Some(r?)),
            None => Ok(None),
        }
    }

    /// List every feature in stable roster order.
    pub fn feature_list(&self) -> rusqlite::Result<Vec<PlanFeature>> {
        let mut stmt = self.conn.prepare(&format!("{FEATURE_COLS} ORDER BY position, slug"))?;
        let out: rusqlite::Result<Vec<PlanFeature>> = stmt.query_map([], row_to_feature)?.collect();
        out
    }

    /// Delete a feature by `slug` (no-op if absent).
    pub fn feature_remove(&self, slug: &str) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM features WHERE slug = ?1", params![slug])?;
        Ok(())
    }

    /// Render every feature to the `features.json` shape the frontend reads.
    pub fn render_features_json(&self) -> rusqlite::Result<String> {
        Ok(serde_json::to_string_pretty(&self.feature_list()?).unwrap_or_else(|_| "[]".into()))
    }
}

const FEATURE_COLS: &str =
    "SELECT slug, name, behavior, phase, approach, data, stream, acceptance, tools, depends_on, requires FROM features";

fn row_to_feature(r: &rusqlite::Row) -> rusqlite::Result<PlanFeature> {
    Ok(PlanFeature {
        slug: r.get(0)?,
        name: r.get(1)?,
        behavior: r.get(2)?,
        phase: phase_from_db(r.get::<_, Option<String>>(3)?),
        approach: r.get(4)?,
        data: r.get(5)?,
        stream: r.get(6)?,
        acceptance: json_to_arr(&r.get::<_, String>(7)?),
        tools: json_to_arr(&r.get::<_, String>(8)?),
        depends_on: json_to_arr(&r.get::<_, String>(9)?),
        requires: json_to_arr(&r.get::<_, String>(10)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feat(name: &str) -> PlanFeature {
        PlanFeature { name: name.into(), ..Default::default() }
    }

    #[test]
    fn feature_add_derives_a_slug_and_keeps_roster_order() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.feature_upsert(&feat("Invite teammates")).unwrap(), "invite-teammates");
        s.feature_upsert(&feat("Export to CSV")).unwrap();
        let list = s.feature_list().unwrap();
        assert_eq!(list.iter().map(|f| f.slug.as_str()).collect::<Vec<_>>(), vec!["invite-teammates", "export-to-csv"]);
    }

    #[test]
    fn titles_first_then_detail_merges_without_clobbering() {
        let s = Store::open_in_memory().unwrap();
        // Phase 1: lay out the whole roster (names only).
        s.feature_upsert(&feat("Invite teammates")).unwrap();
        s.feature_upsert(&feat("Export")).unwrap();
        // Phase 2: detail one by slug — name is NOT resent and must survive.
        s.feature_upsert(&PlanFeature {
            slug: "invite-teammates".into(),
            behavior: Some("send an email invite".into()),
            acceptance: vec!["invite email sent".into()],
            ..Default::default()
        }).unwrap();
        let f = s.feature_get("invite-teammates").unwrap().unwrap();
        assert_eq!(f.name, "Invite teammates", "detailing must not wipe the title");
        assert_eq!(f.behavior.as_deref(), Some("send an email invite"));
        assert_eq!(f.acceptance, vec!["invite email sent"]);
        // The untouched feature is still just a title (not yet defined).
        let exp = s.feature_get("export").unwrap().unwrap();
        assert!(exp.behavior.is_none() && exp.acceptance.is_empty());
    }

    #[test]
    fn render_features_matches_the_features_json_shape() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&PlanFeature {
            name: "Invite teammates".into(),
            behavior: Some("b".into()),
            acceptance: vec!["a".into()],
            tools: vec!["resend".into()],
            ..Default::default()
        }).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s.render_features_json().unwrap()).unwrap();
        let row = &v.as_array().unwrap()[0];
        assert_eq!(row["slug"], "invite-teammates");
        assert_eq!(row["acceptance"], serde_json::json!(["a"]));
        assert_eq!(row["tools"], serde_json::json!(["resend"]));
        assert!(row.get("approach").is_none()); // omitted when absent
    }

    #[test]
    fn feature_remove_drops_it() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("X")).unwrap();
        s.feature_remove("x").unwrap();
        assert!(s.feature_list().unwrap().is_empty());
    }

    #[test]
    fn feature_depends_on_round_trips_and_merges() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Geometry kernel")).unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        // Detail the sketcher: declare it builds on the kernel (the roadmap DAG edge).
        s.feature_upsert(&PlanFeature {
            slug: "sketcher".into(),
            behavior: Some("draw constrained 2D sketches".into()),
            depends_on: vec!["geometry-kernel".into()],
            ..Default::default()
        }).unwrap();
        let f = s.feature_get("sketcher").unwrap().unwrap();
        assert_eq!(f.depends_on, vec!["geometry-kernel"]);
        assert_eq!(f.name, "Sketcher", "the title survives the detail merge");
        // A later detail edit that omits depends_on must NOT wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), approach: Some("constraint solver".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().depends_on, vec!["geometry-kernel"]);
    }

    #[test]
    fn feature_phase_round_trips_and_merges() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        // Plan stage assigns the phase (a number); a later edit omitting it must not wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), phase: Some(serde_json::json!(2)), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().phase, Some(serde_json::json!(2)));
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), behavior: Some("draw".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().phase, Some(serde_json::json!(2)), "phase survives a later edit");
    }

    /// #4080 — the plan → algorithms-graph edge. Same merge rule as every other array field: a
    /// non-empty write overwrites, an omitted one keeps what is stored, so the titles-first flow can
    /// declare `requires` in one pass and fill `behavior` in the next without losing either.
    #[test]
    fn feature_requires_round_trips_and_survives_a_later_detail_edit() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        assert!(s.feature_get("sketcher").unwrap().unwrap().requires.is_empty(), "absent by default");

        s.feature_upsert(&PlanFeature {
            slug: "sketcher".into(),
            requires: vec!["merge.rs".into(), "binary-search.ts".into()],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            s.feature_get("sketcher").unwrap().unwrap().requires,
            vec!["merge.rs".to_string(), "binary-search.ts".to_string()],
        );

        // A later detail edit that omits `requires` must NOT wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), behavior: Some("draw".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().requires.len(), 2, "requires survives a later edit");

        // …and a non-empty write DOES replace it (the planner correcting itself).
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), requires: vec!["merge.rs".into()], ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().requires, vec!["merge.rs".to_string()]);
    }

    /// It rides the camelCase wire like every sibling field, so `features.json` and the frontend model
    /// see it without a translation layer.
    #[test]
    fn feature_requires_serializes_camel_case() {
        let json = serde_json::to_string(&PlanFeature {
            slug: "s".into(),
            requires: vec!["merge.rs".into()],
            ..Default::default()
        })
        .unwrap();
        assert!(json.contains("\"requires\":[\"merge.rs\"]"), "wire shape: {json}");
        // And reads back.
        let back: PlanFeature = serde_json::from_str(&json).unwrap();
        assert_eq!(back.requires, vec!["merge.rs".to_string()]);
        // An older payload with no `requires` still parses (serde default) — no migration on the wire.
        let old: PlanFeature = serde_json::from_str(r#"{"slug":"s","name":"S"}"#).unwrap();
        assert!(old.requires.is_empty());
    }
}
