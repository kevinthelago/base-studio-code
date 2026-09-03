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
/// One entry in a feature's `requires` — a record id, optionally carrying who added it and why.
///
/// UNTAGGED with the bare-string arm FIRST, so every `requires` list authored before this — and every
/// hand-written `["merge.rs", "binary-search.ts"]` — deserializes and re-serializes unchanged. Serde
/// tries the arms in order, so a string stays a string and only an object becomes an [`Entry`].
///
/// The object arm exists because the point of populating `requires` is being able to tell a
/// DIRECTOR's seed from a WORKER's mid-task discovery, and a list of bare ids cannot. Without the
/// provenance, running both approaches produces one merged list and no answer about which worked.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(untagged)]
pub enum RequiredRef {
    /// A bare id — the legacy and hand-authored shape.
    Id(String),
    /// An id with provenance.
    Entry {
        id: String,
        /// Who added it (`--by`). Absent rather than guessed: `resolve_origin`'s rule, and an
        /// invented author is worse than none when the whole point is attribution.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<String>,
        /// When, ISO-8601 UTC.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        /// Why this record is needed — the half a bare id loses.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
    },
}

impl RequiredRef {
    /// The record id, whichever shape the entry takes — what every reader actually wants.
    pub fn id(&self) -> &str {
        match self {
            RequiredRef::Id(id) => id,
            RequiredRef::Entry { id, .. } => id,
        }
    }

    /// Who added it, when known.
    pub fn by(&self) -> Option<&str> {
        match self {
            RequiredRef::Id(_) => None,
            RequiredRef::Entry { by, .. } => by.as_deref(),
        }
    }
}

/// A bare id converts, so `vec!["merge.rs".into()]` keeps meaning what it always did.
///
/// Not sugar: the bare-id shape is the one every existing caller and every hand-authored plan uses,
/// and making it awkward would push authors toward the object form for entries that carry no
/// provenance — which is how a list of `{"id": …}` with three nulls each ends up in the store.
impl From<&str> for RequiredRef {
    fn from(id: &str) -> Self {
        RequiredRef::Id(id.to_string())
    }
}

impl From<String> for RequiredRef {
    fn from(id: String) -> Self {
        RequiredRef::Id(id)
    }
}

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
    /// SUPERSEDED by a stream's own `feature` (`a-feature-owns-many-streams`). Do not author it.
    ///
    /// It said "the fleet stream that owns it (defaults to the slug — a feature IS a stream)", and that
    /// 1:1 is the thing that was wrong: studio-code has 89 streams against 44 features, so a feature
    /// owns MANY streams and the relation only fits on the stream. Measured before inverting it, this
    /// field was already dead — 0 of 44 features set it, and nothing read it — so nothing depended on
    /// the 1:1 except the launch, which inferred it from the ids coinciding.
    ///
    /// Kept as a column rather than dropped so an existing row round-trips unchanged. It is NOT read;
    /// authoring it would create the second copy that the inversion exists to remove, and the two would
    /// drift the first time a feature gained a second stream.
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
    pub requires: Vec<RequiredRef>,
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

// ── the feature RULES — one definition each, and this module is where they live ────────────────
//
// These were duplicated across two languages and the copies disagreed. MEASURED 2026-09-03 on
// studio-code: `bsc plan feature list` printed `·` (not fully defined) against nearly every row
// while its own footer said `47 of 49 features fully defined` — one command, two rules, contradicting
// each other on screen. There were three:
//
//   validate.rs::feature_defined        name + behavior + >=1 acceptance
//   cli/nouns.rs::render_feature_line   name + behavior + acceptance + non-empty `requires`
//   feature-list.ts::featureDefined     name + behavior + >=1 acceptance
//
// and `validate.rs` documented itself as MIRRORING the frontend, which had the authority backwards:
// plan.db is this crate's resource, so the rule is this crate's. Policy lives where the owned resource
// lives (`epic-frontend-logic-over-backend-resources-belongs-in-rust`).
//
// The two notions were BOTH real and the mistake was calling them the same thing. They are now named
// apart, so a caller has to say which question it is asking and no two answers can drift.

/// The capability is DESCRIBED: it has a name, a behavior, and at least one acceptance criterion.
///
/// This is what the Features gate has always asked, in both languages, and it stays the gate's
/// question — tightening it to [`feature_defined`] would fail a plan that was authored before
/// `requires` existed, which is a MAINTAINER's call and not a refactor's.
pub fn feature_specified(f: &PlanFeature) -> bool {
    !f.name.trim().is_empty()
        && f.behavior.as_deref().map(|b| !b.trim().is_empty()).unwrap_or(false)
        && !f.acceptance.is_empty()
}

/// [`feature_specified`] AND it says WHAT IT DRAWS ON — a non-empty `requires`.
///
/// `requires` is the plan → library edge, and the worker charter renders it as the Reference
/// implementations section, so an empty one means a worker is told to build from nothing and
/// re-derives what the library already holds. MEASURED when that rule was added: 124 features across
/// six projects, THREE with a requires list. The edge and the worker protocol were both correct; the
/// input was empty, and nothing said so.
pub fn feature_defined(f: &PlanFeature) -> bool {
    feature_specified(f) && !f.requires.is_empty()
}

/// The Features roster at a glance. Both counts ride together so a reader is never shown one number
/// that a second rule would contradict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturesSummary {
    /// How many features exist.
    pub count: usize,
    /// How many are DESCRIBED ([`feature_specified`]) — the gate's question.
    pub specified: usize,
    /// How many also declare `requires` ([`feature_defined`]).
    pub defined: usize,
    /// Every feature is specified, and there is at least one. The gate's precondition.
    pub all_specified: bool,
}

/// Summarise a roster under both rules in one pass.
pub fn features_summary(feats: &[PlanFeature]) -> FeaturesSummary {
    let specified = feats.iter().filter(|f| feature_specified(f)).count();
    let defined = feats.iter().filter(|f| feature_defined(f)).count();
    FeaturesSummary {
        count: feats.len(),
        specified,
        defined,
        all_specified: !feats.is_empty() && specified == feats.len(),
    }
}

/// The Features gate passes when every feature is specified AND the user has confirmed.
///
/// Ported from `feature-list.ts::featuresGateComplete` unchanged — the user's confirm is a separate
/// axis from the data being complete, and collapsing them would let a full roster advance the stage
/// with nobody having looked at it.
pub fn features_gate_complete(summary: &FeaturesSummary, user_confirmed: bool) -> bool {
    summary.all_specified && user_confirmed
}

/// The roster is complete but the user has not confirmed — the state that should PROMPT, distinct
/// from the state that should keep authoring.
pub fn features_awaiting_confirm(summary: &FeaturesSummary, user_confirmed: bool) -> bool {
    summary.all_specified && !user_confirmed
}

/// The first `depends_on` cycle in the roster, as the slugs on it (first slug repeated at the end),
/// or empty when the DAG is acyclic.
///
/// A cycle is a planning deadlock — nothing in it can ever be scheduled first — so it is worth
/// naming the actual loop rather than reporting a bare boolean. Ported from
/// `feature-list.ts::featureDependencyCycle`: an iterative three-colour DFS (white = unvisited,
/// grey = on the current path, black = fully explored); a grey hit is a back-edge and the path from
/// that slug onward IS the cycle. Edges to slugs the roster does not contain are skipped rather than
/// treated as missing nodes, exactly as the TS did — a dangling `depends_on` is a separate problem.
pub fn feature_dependency_cycle(feats: &[PlanFeature]) -> Vec<String> {
    use std::collections::HashMap;

    #[derive(Clone, Copy, PartialEq)]
    enum Color {
        Grey,
        Black,
    }
    let by_slug: HashMap<&str, &PlanFeature> = feats.iter().map(|f| (f.slug.as_str(), f)).collect();
    let mut color: HashMap<&str, Color> = HashMap::new();
    let mut path: Vec<&str> = Vec::new();

    // Explicit stack rather than recursion: a roster is user-authored and a deep chain must not be
    // able to blow the stack of whatever is calling us.
    enum Step<'a> {
        Enter(&'a str),
        Leave(&'a str),
    }

    for root in feats {
        if color.get(root.slug.as_str()) == Some(&Color::Black) {
            continue;
        }
        let mut stack = vec![Step::Enter(root.slug.as_str())];
        while let Some(step) = stack.pop() {
            match step {
                Step::Leave(slug) => {
                    path.pop();
                    color.insert(slug, Color::Black);
                }
                Step::Enter(slug) => match color.get(slug) {
                    Some(Color::Black) => {}
                    Some(Color::Grey) => {
                        // Back-edge: the cycle is the current path from `slug` on, closed by `slug`.
                        let at = path.iter().position(|s| *s == slug).unwrap_or(0);
                        let mut cycle: Vec<String> = path[at..].iter().map(|s| s.to_string()).collect();
                        cycle.push(slug.to_string());
                        return cycle;
                    }
                    None => {
                        color.insert(slug, Color::Grey);
                        path.push(slug);
                        stack.push(Step::Leave(slug));
                        if let Some(f) = by_slug.get(slug) {
                            // Reversed so the first dependency is explored first, matching the TS
                            // walk order — which decides WHICH cycle is reported when there are two.
                            for dep in f.depends_on.iter().rev() {
                                if by_slug.contains_key(dep.as_str()) {
                                    stack.push(Step::Enter(dep.as_str()));
                                }
                            }
                        }
                    }
                },
            }
        }
    }
    Vec::new()
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
                arr_to_json(&feature.depends_on),
                serde_json::to_string(&feature.requires).unwrap_or_else(|_| "[]".into()),
                pos,
            ],
        )?;
        Ok(slug)
    }

    /// Empty a feature's `requires` outright.
    ///
    /// `feature_upsert` deliberately KEEPS the stored array when the submitted one is `[]` — the merge
    /// rule every array field follows, so a titles-first detail pass cannot wipe a list it did not
    /// restate. That rule makes removing the LAST entry a silent no-op through the normal path, so the
    /// clear needs its own statement.
    pub fn feature_requires_clear(&self, slug: &str) -> rusqlite::Result<()> {
        self.conn
            .execute("UPDATE features SET requires = '[]', updated_at = strftime('%s','now') WHERE slug = ?1", rusqlite::params![slug])?;
        Ok(())
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
        // Not `json_to_arr`: an entry may be a bare id OR an object carrying provenance, and
        // `Vec<String>` cannot hold the second. Lenient like its neighbours — a malformed column
        // yields an empty list rather than failing the whole read.
        requires: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or_default(),
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
            requires: vec![RequiredRef::Id("merge.rs".into()), RequiredRef::Id("binary-search.ts".into())],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            s.feature_get("sketcher").unwrap().unwrap().requires.iter().map(RequiredRef::id).collect::<Vec<_>>(),
            vec!["merge.rs", "binary-search.ts"],
        );

        // A later detail edit that omits `requires` must NOT wipe it.
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), behavior: Some("draw".into()), ..Default::default() }).unwrap();
        assert_eq!(s.feature_get("sketcher").unwrap().unwrap().requires.len(), 2, "requires survives a later edit");

        // …and a non-empty write DOES replace it (the planner correcting itself).
        s.feature_upsert(&PlanFeature { slug: "sketcher".into(), requires: vec![RequiredRef::Id("merge.rs".into())], ..Default::default() }).unwrap();
        assert_eq!(
            s.feature_get("sketcher").unwrap().unwrap().requires.iter().map(RequiredRef::id).collect::<Vec<_>>(),
            vec!["merge.rs"],
        );
    }

    /// A BARE-ID list and an ENTRY carrying provenance live in the same column, and a legacy list
    /// round-trips byte-identically (`a-feature-declares-what-it-requires`).
    ///
    /// The untagged enum's arm ORDER is what makes that true — serde tries `Id(String)` first, so a
    /// string stays a string. If the arms were swapped, every legacy `["merge.rs"]` would fail to
    /// deserialize and a feature's whole requires list would read as empty: the lenient
    /// `unwrap_or_default` on the column would turn a shape error into silent data loss.
    #[test]
    fn a_requires_entry_may_be_a_bare_id_or_carry_provenance() {
        let s = Store::open_in_memory().unwrap();
        s.feature_upsert(&feat("Sketcher")).unwrap();
        s.feature_upsert(&PlanFeature {
            slug: "sketcher".into(),
            requires: vec![
                RequiredRef::Id("legacy.rs".into()),
                RequiredRef::Entry {
                    id: "seeded.rs".into(),
                    by: Some("director".into()),
                    at: Some("2026-09-03T00:00:00Z".into()),
                    note: Some("the reference sort".into()),
                },
            ],
            ..Default::default()
        })
        .unwrap();

        let got = s.feature_get("sketcher").unwrap().unwrap().requires;
        assert_eq!(got.iter().map(RequiredRef::id).collect::<Vec<_>>(), vec!["legacy.rs", "seeded.rs"]);
        // The bare one carries NO author — absent, never invented, which is the whole point of being
        // able to tell a seeded entry from a discovered one.
        assert_eq!(got[0].by(), None);
        assert_eq!(got[1].by(), Some("director"));

        // And a bare id re-serializes as a STRING, not as an object with three nulls — so a legacy
        // list survives a read-write cycle unchanged.
        let json = serde_json::to_string(&got).unwrap();
        assert!(json.starts_with(r#"["legacy.rs",{"#), "a bare id stays a bare id: {json}");
    }

    /// It rides the camelCase wire like every sibling field, so `features.json` and the frontend model
    /// see it without a translation layer.
    #[test]
    fn feature_requires_serializes_camel_case() {
        let json = serde_json::to_string(&PlanFeature {
            slug: "s".into(),
            requires: vec![RequiredRef::Id("merge.rs".into())],
            ..Default::default()
        })
        .unwrap();
        assert!(json.contains("\"requires\":[\"merge.rs\"]"), "wire shape: {json}");
        // And reads back.
        let back: PlanFeature = serde_json::from_str(&json).unwrap();
        assert_eq!(back.requires.iter().map(RequiredRef::id).collect::<Vec<_>>(), vec!["merge.rs"]);
        // An older payload with no `requires` still parses (serde default) — no migration on the wire.
        let old: PlanFeature = serde_json::from_str(r#"{"slug":"s","name":"S"}"#).unwrap();
        assert!(old.requires.is_empty());
    }
}

/// The feature RULES, ported from `feature-list.ts` with its assertions intact.
///
/// Every case here was a vitest `it()` in that module's test — carried over verbatim so the move is
/// provably behaviour-preserving rather than merely re-implemented
/// (`epic-frontend-logic-over-backend-resources-belongs-in-rust`, "every migration carries the tests
/// that pinned the TS behaviour").
#[cfg(test)]
mod feature_rules {
    use super::*;

    fn f(slug: &str, deps: &[&str]) -> PlanFeature {
        PlanFeature {
            slug: slug.into(),
            name: slug.into(),
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
            ..Default::default()
        }
    }
    /// The TS fixture: `{ slug: "a", name: "A", behavior: "does a thing", acceptance: ["x"] }`.
    fn full() -> PlanFeature {
        PlanFeature {
            slug: "a".into(),
            name: "A".into(),
            behavior: Some("does a thing".into()),
            acceptance: vec!["x".into()],
            ..Default::default()
        }
    }

    #[test]
    fn a_feature_is_specified_only_with_name_behavior_and_one_acceptance() {
        // Ported from `featureDefined` — this is the rule the Features gate has always asked, and it
        // keeps the TS name's meaning even though the Rust name is now narrower.
        assert!(feature_specified(&full()));
        assert!(!feature_specified(&PlanFeature { slug: "a".into(), name: "A".into(), ..Default::default() }));
        assert!(!feature_specified(&PlanFeature {
            slug: "a".into(),
            name: "A".into(),
            behavior: Some("b".into()),
            ..Default::default()
        }));
        // behavior present, acceptance EMPTY — the case a truthiness check would have passed.
        assert!(!feature_specified(&PlanFeature {
            slug: "a".into(),
            name: "A".into(),
            behavior: Some("b".into()),
            acceptance: vec![],
            ..Default::default()
        }));
        // Whitespace is the shape a hand-edited row has; it must not read as content.
        assert!(!feature_specified(&PlanFeature { behavior: Some("   ".into()), ..full() }));
    }

    #[test]
    fn defined_is_specified_plus_requires_and_the_two_are_not_the_same_question() {
        // THE contradiction this consolidation exists to remove: `full()` is specified but NOT
        // defined, and before the split one command answered both ways about exactly this row.
        let f = full();
        assert!(feature_specified(&f));
        assert!(!feature_defined(&f), "no `requires` — described, but not saying what it draws on");
        let with = PlanFeature { requires: vec!["merge.rs".into()], ..full() };
        assert!(feature_defined(&with));
    }

    #[test]
    fn summary_reports_count_and_all_specified() {
        // Ported from `featuresSummary`: [] is NOT all-confirmed (an empty roster must not pass a
        // gate by vacuous truth), one full feature is, and one bare feature breaks it.
        let empty = features_summary(&[]);
        assert_eq!((empty.count, empty.all_specified), (0, false));
        let one = features_summary(&[full()]);
        assert_eq!((one.count, one.all_specified), (1, true));
        let two = features_summary(&[full(), PlanFeature { slug: "b".into(), name: "B".into(), ..Default::default() }]);
        assert_eq!((two.count, two.all_specified), (2, false));
    }

    #[test]
    fn summary_counts_specified_and_defined_apart() {
        let s = features_summary(&[full(), PlanFeature { requires: vec!["x.rs".into()], ..full() }]);
        assert_eq!((s.count, s.specified, s.defined), (2, 2, 1));
    }

    #[test]
    fn a_populated_roster_does_not_complete_the_stage_until_the_user_confirms() {
        // Ported from `featuresGateComplete` — the auto-complete removal. Data being complete and a
        // human having looked are two axes, and collapsing them advanced the stage with nobody
        // having read the list.
        let populated = features_summary(&[full()]);
        assert!(!features_gate_complete(&populated, false));
        assert!(features_gate_complete(&populated, true));
    }

    #[test]
    fn the_confirm_is_offered_only_once_everything_is_populated() {
        // Ported from `featuresAwaitingConfirm`.
        let mid = features_summary(&[full(), PlanFeature { slug: "b".into(), name: "B".into(), ..Default::default() }]);
        assert!(!features_awaiting_confirm(&mid, false), "still populating → no offer");
        let done = features_summary(&[full()]);
        assert!(features_awaiting_confirm(&done, false), "all populated → offer the confirm");
        assert!(!features_awaiting_confirm(&done, true), "already confirmed → nothing pending");
    }

    #[test]
    fn an_acyclic_graph_reports_no_cycle() {
        // Ported: a foundation many depend on is not a cycle.
        let feats = vec![f("kernel", &[]), f("sketcher", &["kernel"]), f("assembly", &["kernel", "sketcher"])];
        assert_eq!(feature_dependency_cycle(&feats), Vec::<String>::new());
    }

    #[test]
    fn a_direct_cycle_is_found_and_closes_on_itself() {
        let cyc = feature_dependency_cycle(&[f("a", &["b"]), f("b", &["a"])]);
        assert_eq!(cyc.first(), cyc.last(), "the reported path closes on itself");
        let set: std::collections::HashSet<&str> = cyc.iter().map(|s| s.as_str()).collect();
        assert_eq!(set, ["a", "b"].into_iter().collect());
    }

    #[test]
    fn a_self_dependency_is_a_cycle() {
        assert_eq!(feature_dependency_cycle(&[f("a", &["a"])]), vec!["a".to_string(), "a".to_string()]);
    }

    #[test]
    fn an_edge_to_an_unknown_slug_is_not_a_cycle() {
        // A dangling `depends_on` is a separate problem — reporting it as a deadlock would send a
        // reader looking for a loop that does not exist.
        assert_eq!(feature_dependency_cycle(&[f("a", &["ghost"])]), Vec::<String>::new());
    }

    #[test]
    fn a_deep_chain_does_not_blow_the_stack() {
        // The TS walked this recursively; the port is an explicit stack, so the roster length a user
        // can author is not bounded by the caller's stack. 10k deep would overflow a naive recursion.
        let feats: Vec<PlanFeature> = (0..10_000)
            .map(|i| {
                let deps: Vec<String> = if i + 1 < 10_000 { vec![format!("f{}", i + 1)] } else { vec![] };
                PlanFeature { slug: format!("f{i}"), name: format!("f{i}"), depends_on: deps, ..Default::default() }
            })
            .collect();
        assert_eq!(feature_dependency_cycle(&feats), Vec::<String>::new());
    }
}
