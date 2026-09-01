//! The publish path must ADOPT an existing same-title board rather than mint a second one.
//!
//! This is the CALL-SITE test for `the-publish-path-adopts-an-existing-board`. The decision itself is
//! unit-tested in `board_choice`; what these assert is that `ensure_project_board` actually consults it
//! — a decision nobody calls is the shape this epic keeps finding.
//!
//! They are about WHICH CALLS HAPPEN, not about GitHub: the fake records every query and answers from a
//! script, so "no board was created" is observable rather than inferred.

use bsc_publish::{ensure_project_board, GhApi, Report};
use std::cell::RefCell;
use std::collections::HashMap;

/// Records every call; answers the owner query from a script and fails nothing else.
struct FakeGh {
    calls: RefCell<Vec<String>>,
    owner: serde_json::Value,
}

impl FakeGh {
    fn with_boards(boards: serde_json::Value) -> Self {
        FakeGh {
            calls: RefCell::new(Vec::new()),
            owner: serde_json::json!({ "repositoryOwner": { "id": "O_1", "projectsV2": { "nodes": boards } } }),
        }
    }
    fn created_count(&self) -> usize {
        self.calls.borrow().iter().filter(|c| c.contains("createProjectV2")).count()
    }
    fn owner_queries(&self) -> usize {
        self.calls.borrow().iter().filter(|c| c.contains("repositoryOwner")).count()
    }
}

impl GhApi for FakeGh {
    fn gql(&self, query: &str, _v: serde_json::Value) -> Result<serde_json::Value, String> {
        self.calls.borrow_mut().push(query.to_string());
        if query.contains("repositoryOwner") {
            // THE FAKE HONOURS THE QUERY. GitHub returns only the fields asked for, so a query that
            // does not select `projectsV2` gets an owner WITHOUT boards — and adoption becomes
            // impossible, which is exactly the pre-fix behaviour.
            //
            // Measured: without this, reverting the query to `repositoryOwner(login){ id }` did not
            // fail a single test, because the fake handed over the boards regardless. A fake that
            // answers more generously than the real API tests the mechanism and not the fix.
            if !query.contains("projectsV2") {
                let mut bare = self.owner.clone();
                if let Some(o) = bare.get_mut("repositoryOwner").and_then(|o| o.as_object_mut()) {
                    o.remove("projectsV2");
                }
                return Ok(bare);
            }
            return Ok(self.owner.clone());
        }
        if query.contains("createProjectV2") {
            return Ok(serde_json::json!({ "createProjectV2": { "projectV2": { "id": "P_NEW", "number": 99, "url": "u" } } }));
        }
        Ok(serde_json::json!({}))
    }
    fn rest(&self, _path: &str) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!([]))
    }
    fn post(&self, _path: &str, _b: &serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(serde_json::json!({}))
    }
}

fn board(id: &str, number: i64, title: &str) -> serde_json::Value {
    serde_json::json!({ "id": id, "number": number, "url": format!("https://x/{id}"), "title": title })
}

fn run(api: &FakeGh, existing: Option<&str>, title: &str) -> (Option<String>, Report) {
    let mut report = Report::default();
    let repos = vec!["acme/web".to_string()];
    let id = ensure_project_board(api, existing, &repos, "acme", title, &HashMap::new(), &mut report);
    (id, report)
}

/// THE REGRESSION THIS CLOSES. Before the flip this issued `createProjectV2` and returned a NEW id,
/// duplicating a board the app-side publish would have adopted.
#[test]
fn a_same_title_board_is_adopted_and_nothing_is_created() {
    let api = FakeGh::with_boards(serde_json::json!([board("P_OLD", 7, "Studio Code")]));
    let (id, _) = run(&api, None, "Studio Code");
    assert_eq!(id.as_deref(), Some("P_OLD"), "the existing board is adopted");
    assert_eq!(api.created_count(), 0, "NO board may be created when one already carries the title");
}

/// The shared matcher's rules reach the call site, not just its unit test.
#[test]
fn adoption_is_case_insensitive_and_ignores_surrounding_whitespace() {
    let api = FakeGh::with_boards(serde_json::json!([board("P_OLD", 7, "  studio CODE  ")]));
    let (id, _) = run(&api, None, "Studio Code");
    assert_eq!(id.as_deref(), Some("P_OLD"));
    assert_eq!(api.created_count(), 0);
}

/// …and when nothing matches, it still creates. The fix must not have turned publish into a no-op.
#[test]
fn a_board_is_still_created_when_no_title_matches() {
    let api = FakeGh::with_boards(serde_json::json!([board("P_OTHER", 3, "Something Else")]));
    let (id, _) = run(&api, None, "Studio Code");
    assert_eq!(id.as_deref(), Some("P_NEW"));
    assert_eq!(api.created_count(), 1);
}

/// An owner with no boards at all is the ordinary first publish.
#[test]
fn an_owner_with_no_boards_creates_one() {
    let api = FakeGh::with_boards(serde_json::json!([]));
    let (id, _) = run(&api, None, "Studio Code");
    assert_eq!(id.as_deref(), Some("P_NEW"));
    assert_eq!(api.created_count(), 1);
}

/// THE OPTIMISATION THAT MUST SURVIVE. An already-linked board costs no round trip at all — the
/// `existing` short-circuit stays outside the query, so adding adoption did not make every publish
/// pay for the owner's boards.
#[test]
fn an_already_linked_board_queries_nothing() {
    let api = FakeGh::with_boards(serde_json::json!([board("P_OLD", 7, "Studio Code")]));
    let (id, _) = run(&api, Some("P_LINKED"), "Studio Code");
    assert_eq!(id.as_deref(), Some("P_LINKED"));
    assert_eq!(api.owner_queries(), 0, "a linked board must not fetch the owner's boards");
    assert_eq!(api.created_count(), 0);
}

/// A board node missing optional fields is still a board. Dropping it would resurrect the duplicate,
/// which is the failure mode a stricter parse would quietly reintroduce.
#[test]
fn a_board_missing_url_or_number_is_still_adopted() {
    let api = FakeGh::with_boards(serde_json::json!([{ "id": "P_OLD", "title": "Studio Code" }]));
    let (id, _) = run(&api, None, "Studio Code");
    assert_eq!(id.as_deref(), Some("P_OLD"));
    assert_eq!(api.created_count(), 0);
}
