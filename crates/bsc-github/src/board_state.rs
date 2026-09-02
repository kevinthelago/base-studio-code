//! The persisted GitHub board state's MODEL — the rules about a structure Rust already stores.
//!
//! ## Why this is Rust
//!
//! `crates/bsc-project` owns `~/.base-studio-code/github-state.json`: the path, the loader, the
//! writer, and the envelope check. Its own doc comment states the problem this module fixes — *"The
//! frontend owns the record schema … this side treats the payload as OPAQUE-BUT-VALID JSON with that
//! envelope, replaced wholesale on each successful fetch."* So Rust persists and guards a structure
//! it cannot read, and every rule about that structure lived in the renderer. That is the role-gate
//! inversion `epic-frontend-logic-over-backend-resources-belongs-in-rust` removes, written down by
//! the code that suffers from it.
//!
//! Ported from `githubState.ts` and proved against `src/shared/lib/github/githubState.fixtures.json`,
//! generated from it.
//!
//! ## The rule that matters
//!
//! [`filter_records_to_local`] is the DON'T-RESURRECT rule: a persisted record whose local hub was
//! deleted must not bring the project back. Only a live fetch may vouch for a GitHub-only board. It
//! is the one function here whose failure is silent and user-visible — a deleted project reappearing
//! from cache — which is why each of its three match paths is pinned separately in the fixture. A
//! port that kept only the title match would still pass a corpus whose keys are all name-derived.
//!
//! ## Slug rules are REUSED, never restated
//!
//! Both key derivations already exist and neither is re-implemented here:
//! [`bsc_project::project_slug`] (already bound to its TypeScript twin by `projectSlug.fixtures.json`,
//! read by both sides) and [`bsc_project::sanitize_project_key`], the grandfathering rule for hubs
//! created before #2409.
//!
//! ## IT USED TO LIVE IN `src-tauri`, AND THAT WAS THE WHOLE PROBLEM
//!
//! The header this replaces said so outright: *"This module lives in `src-tauri` rather than in
//! `bsc-project` precisely because that is where both are reachable — the cost being that it is not
//! reachable from a live session via `bsc`."* That cost was the reason to move, not a footnote.
//! `sanitize_project_key` now lives beside `project_slug` in `bsc-project`, so both derivations are
//! reachable from crate-land and this module came with them. Measured elsewhere in this epic: a crate
//! edit reaches live behaviour in ~1235 ms, while an `src-tauri` edit is a new binary and a restarted
//! window with a fleet running in it.
//!
//! ## WHICH WAY THIS FAILS
//!
//! [`filter_records_to_local`] fails CLOSED — a record it cannot match to a local hub is DROPPED, not
//! kept. That is the safe direction here and it is the module's entire point: the harm being prevented
//! is a deleted project reappearing from cache, so when in doubt the answer is to show less. The
//! opposite choice would make the don't-resurrect rule advisory.

use bsc_project::sanitize_project_key;
use serde::{Deserialize, Serialize};

/// One `projectsV2` item as the wire carries it. `content` is `None` for a DRAFT item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GhItemShape {
    #[serde(default)]
    pub content: Option<GhItemContent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhItemContent {
    #[serde(default, rename = "__typename", skip_serializing_if = "Option::is_none")]
    pub typename: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhItems {
    pub total_count: i64,
    pub nodes: Vec<GhItemShape>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepo {
    pub name_with_owner: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhRepos {
    pub nodes: Vec<GhRepo>,
}

/// The `projectsV2` node shape this module reads and synthesizes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GhProjectShape {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub short_description: Option<String>,
    pub url: String,
    pub closed: bool,
    pub updated_at: String,
    pub items: GhItems,
    pub repositories: GhRepos,
}

/// The minimal per-board record that persists — identity, lifecycle, progress and repos.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MinimalGhProject {
    pub id: String,
    pub number: i64,
    pub title: String,
    pub short_description: Option<String>,
    pub url: String,
    pub closed: bool,
    pub updated_at: String,
    /// The TRUE item count. The fetched item page is capped at 100, so this is not `nodes.len()`.
    pub items_total_count: i64,
    /// Open issues/PRs among the FETCHED items.
    pub open_count: i64,
    /// Closed or merged issues/PRs among the FETCHED items.
    pub closed_count: i64,
    pub repos: Vec<String>,
}

/// A local project the filter matches records against — an on-disk hub or a store draft.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalProject {
    pub key: String,
    pub title: String,
}

/// Boil a fetched `projectsV2` set down to the minimal persisted records.
///
/// The tally has three outcomes, not two, and the third is the one a port drops: `OPEN` counts open,
/// `CLOSED` and `MERGED` both count closed, and anything else — a DRAFT item (`content: null`) or a
/// state this code does not know — counts as **neither**. So `open + closed` can be less than the
/// number of fetched nodes, and `items_total_count` is independent of both.
pub fn to_minimal_gh_projects(projects: &[GhProjectShape]) -> Vec<MinimalGhProject> {
    projects
        .iter()
        .map(|p| {
            let mut open_count = 0;
            let mut closed_count = 0;
            for n in &p.items.nodes {
                match n.content.as_ref().and_then(|c| c.state.as_deref()) {
                    Some("OPEN") => open_count += 1,
                    Some("CLOSED") | Some("MERGED") => closed_count += 1,
                    _ => {}
                }
            }
            MinimalGhProject {
                id: p.id.clone(),
                number: p.number,
                title: p.title.clone(),
                short_description: p.short_description.clone(),
                url: p.url.clone(),
                closed: p.closed,
                updated_at: p.updated_at.clone(),
                items_total_count: p.items.total_count,
                open_count,
                closed_count,
                repos: p.repositories.nodes.iter().map(|r| r.name_with_owner.clone()).collect(),
            }
        })
        .collect()
}

/// Expand a persisted record back into the fetched shape, synthesizing item stubs so the progress
/// meters recompute the EXACT fraction the record was derived from.
///
/// The stubs are ordered open-then-closed, and the count is `open + closed` — which is deliberately
/// not `items_total_count`: the record only ever knew about the fetched page.
pub fn minimal_to_gh_project(r: &MinimalGhProject) -> GhProjectShape {
    let stub = |state: &str| GhItemShape {
        content: Some(GhItemContent { typename: None, state: Some(state.to_string()) }),
    };
    let mut nodes: Vec<GhItemShape> = Vec::new();
    for _ in 0..r.open_count.max(0) {
        nodes.push(stub("OPEN"));
    }
    for _ in 0..r.closed_count.max(0) {
        nodes.push(stub("CLOSED"));
    }
    GhProjectShape {
        id: r.id.clone(),
        number: r.number,
        title: r.title.clone(),
        short_description: r.short_description.clone(),
        url: r.url.clone(),
        closed: r.closed,
        updated_at: r.updated_at.clone(),
        items: GhItems { total_count: r.items_total_count, nodes },
        repositories: GhRepos {
            nodes: r.repos.iter().map(|n| GhRepo { name_with_owner: n.clone() }).collect(),
        },
    }
}

/// Keep only the records that still correspond to a LOCAL project — the don't-resurrect rule.
///
/// A record covers a local entry when the entry's key equals the record's name-derived
/// `project_slug(title)` (today's keys), or the legacy `sanitize_project_key(title)` (grandfathered
/// title-keyed hubs), or when the titles match case-insensitively. Surviving records keep THEIR
/// order, not the locals'.
///
/// The two empty short-circuits are an OPTIMISATION, not a rule, and that was verified rather than
/// assumed: deleting `locals.is_empty()` passed every test, because with no locals the key and title
/// sets are empty, every predicate is false, and the filter returns empty anyway. The same holds for
/// `records.is_empty()`. They are kept because the source has them and they are free; nothing here
/// pins them, because nothing can.
pub fn filter_records_to_local(
    records: &[MinimalGhProject],
    locals: &[LocalProject],
) -> Vec<MinimalGhProject> {
    if records.is_empty() || locals.is_empty() {
        return Vec::new();
    }
    let keys: std::collections::HashSet<&str> = locals.iter().map(|l| l.key.as_str()).collect();
    let titles: std::collections::HashSet<String> =
        locals.iter().map(|l| l.title.to_lowercase()).collect();
    records
        .iter()
        .filter(|r| {
            keys.contains(bsc_project::project_slug(&r.title).as_str())
                || keys.contains(sanitize_project_key(&r.title).as_str())
                || titles.contains(&r.title.to_lowercase())
        })
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the same rule the tunnel, role-gate and injection-scan
    /// contracts use. Exactly one match is required — zero or a collision is a hard failure.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("githubState.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one githubState.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// THE POINT: Rust must boil a fetch down to the same record the renderer does, field for field.
    /// The record is what SURVIVES a restart, so a field that differs here is a board the user sees
    /// wrongly for as long as they stay offline.
    #[test]
    fn rust_boils_a_fetch_down_to_the_same_records() {
        let fx = fixture();
        let cases = fx["fetches"].as_array().expect("fixture fetches");
        assert!(cases.len() >= 5, "the corpus must be the real one: {}", cases.len());
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let projects: Vec<GhProjectShape> = serde_json::from_value(c["projects"].clone())
                .unwrap_or_else(|e| panic!("fixture projects for {name:?}: {e}"));
            let got = serde_json::to_value(to_minimal_gh_projects(&projects)).unwrap();
            assert_eq!(got, c["records"], "records differ for {name:?}");
        }
    }

    /// The inflate direction: the synthesized stubs are what let the progress meters recompute the
    /// same fraction, so their COUNT and ORDER are the contract, not an implementation detail.
    #[test]
    fn rust_inflates_a_record_into_the_same_shape() {
        let fx = fixture();
        for c in fx["inflate"].as_array().expect("fixture inflate") {
            let name = c["name"].as_str().unwrap();
            let record: MinimalGhProject = serde_json::from_value(c["record"].clone())
                .unwrap_or_else(|e| panic!("fixture record for {name:?}: {e}"));
            let got = serde_json::to_value(minimal_to_gh_project(&record)).unwrap();
            assert_eq!(got, c["project"], "inflated shape differs for {name:?}");
        }
    }

    /// The don't-resurrect rule, on every match path. A deleted project reappearing from cache is a
    /// silent, user-visible failure, so this is the assertion that matters most in the module.
    #[test]
    fn rust_applies_the_dont_resurrect_rule_the_same_way() {
        let fx = fixture();
        let cases = fx["filters"].as_array().expect("fixture filters");
        assert!(cases.len() >= 7, "the corpus must cover every path: {}", cases.len());
        let mut paths = 0;
        for c in cases {
            let name = c["name"].as_str().unwrap();
            let records: Vec<MinimalGhProject> = serde_json::from_value(c["records"].clone()).unwrap();
            let locals: Vec<LocalProject> = c["locals"]
                .as_array()
                .unwrap()
                .iter()
                .map(|l| LocalProject {
                    key: l["key"].as_str().unwrap().to_string(),
                    title: l["title"].as_str().unwrap().to_string(),
                })
                .collect();
            let got = serde_json::to_value(filter_records_to_local(&records, &locals)).unwrap();
            assert_eq!(got, c["kept"], "kept records differ for {name:?}");
            if name.starts_with("MATCH PATH") {
                paths += 1;
            }
        }
        assert_eq!(paths, 3, "all three match paths must be exercised in isolation");
    }

    // ---------------------------------------------------------------------------------------------
    // Properties the fixture states only implicitly.
    // ---------------------------------------------------------------------------------------------

    /// The tally has THREE outcomes. A port that wrote `else { closed += 1 }` would pass every case
    /// whose items are all OPEN/CLOSED/MERGED, and quietly inflate the closed count for every draft.
    #[test]
    fn a_draft_or_unknown_item_state_counts_as_neither() {
        let item = |state: Option<&str>| GhItemShape {
            content: state.map(|s| GhItemContent { typename: None, state: Some(s.to_string()) }),
        };
        let p = GhProjectShape {
            id: "x".into(), number: 1, title: "t".into(), short_description: None, url: "u".into(),
            closed: false, updated_at: "2026-01-01T00:00:00Z".into(),
            items: GhItems {
                total_count: 99,
                nodes: vec![item(Some("OPEN")), item(Some("CLOSED")), item(Some("MERGED")), item(None), item(Some("QUEUED"))],
            },
            repositories: GhRepos { nodes: vec![] },
        };
        let r = &to_minimal_gh_projects(&[p])[0];
        assert_eq!((r.open_count, r.closed_count), (1, 2));
        assert_eq!(r.open_count + r.closed_count, 3, "two of the five items count as neither");
        assert_eq!(r.items_total_count, 99, "the headline count is independent of the fetched page");
    }

    /// Round-tripping preserves the progress fraction — which is the whole reason the stubs exist.
    /// `items_total_count` survives; the node COUNT deliberately does not, because a record only ever
    /// knew about the fetched page.
    #[test]
    fn inflating_a_record_and_re_boiling_it_is_a_fixed_point() {
        let r = MinimalGhProject {
            id: "PVT".into(), number: 3, title: "Studio Code".into(),
            short_description: Some("d".into()), url: "u".into(), closed: false,
            updated_at: "2026-01-01T00:00:00Z".into(),
            items_total_count: 42, open_count: 2, closed_count: 3, repos: vec!["x/y".into()],
        };
        let again = &to_minimal_gh_projects(&[minimal_to_gh_project(&r)])[0];
        assert_eq!(again, &r, "the record must survive a round trip unchanged");
    }

    /// The slug rules are REUSED, not restated: this asserts the filter genuinely goes through
    /// `project_slug` and `sanitize_project_key` rather than through a private copy that happens to
    /// agree on simple names.
    #[test]
    fn the_filter_uses_the_existing_slug_rules_not_a_private_copy() {
        let rec = |title: &str| MinimalGhProject {
            id: title.into(), number: 1, title: title.into(), short_description: None,
            url: "u".into(), closed: false, updated_at: "t".into(),
            items_total_count: 0, open_count: 0, closed_count: 0, repos: vec![],
        };
        // A name whose two slug rules DISAGREE: `project_slug` lowercases and collapses runs to `-`,
        // `sanitize_project_key` keeps case and maps each char to `_`.
        let title = "My Project!";
        assert_ne!(bsc_project::project_slug(title), sanitize_project_key(title));
        let by_slug = filter_records_to_local(
            &[rec(title)],
            &[LocalProject { key: bsc_project::project_slug(title), title: "unrelated".into() }],
        );
        assert_eq!(by_slug.len(), 1, "the name-slug path matches");
        let by_legacy = filter_records_to_local(
            &[rec(title)],
            &[LocalProject { key: sanitize_project_key(title), title: "unrelated".into() }],
        );
        assert_eq!(by_legacy.len(), 1, "and so does the grandfathered path");
    }
}
