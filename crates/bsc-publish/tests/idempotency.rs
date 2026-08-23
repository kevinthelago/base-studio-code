//! The publish rules that protect against DUPLICATE GITHUB ISSUES.
//!
//! These are the reason publish is delicate, and none is visible to a test that talks to the real
//! API: they are all about which calls happen, in which order, given what the repo already holds. A
//! fake transport makes them assertable. Each case corresponds to a comment in `publishSteps.ts`
//! recording a bug already paid for once.

use bsc_publish::{
    create_issues_for_repo, decide, labels_for, repo_for, ExistingIssues, GhApi, IssueAction, Report,
    Status,
};
use plandb::PlanIssue;
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

/// Records every call and answers from a script. `rest_fails` simulates the existing-issue scan
/// failing, which is the fail-closed trigger.
struct FakeGh {
    calls: RefCell<Vec<String>>,
    existing: serde_json::Value,
    rest_fails: bool,
    next_number: RefCell<i64>,
}

impl FakeGh {
    fn new(existing: serde_json::Value) -> Self {
        FakeGh {
            calls: RefCell::new(Vec::new()),
            existing,
            rest_fails: false,
            next_number: RefCell::new(100),
        }
    }
    fn failing() -> Self {
        FakeGh { rest_fails: true, ..FakeGh::new(serde_json::json!([])) }
    }
    fn calls(&self) -> Vec<String> {
        self.calls.borrow().clone()
    }
    fn posts_to(&self, needle: &str) -> usize {
        self.calls().iter().filter(|c| c.starts_with("POST ") && c.contains(needle)).count()
    }
}

impl GhApi for FakeGh {
    fn gql(&self, query: &str, _v: serde_json::Value) -> Result<serde_json::Value, String> {
        let tag = query.split_whitespace().find(|w| w.len() > 3).unwrap_or("gql");
        self.calls.borrow_mut().push(format!("GQL {tag}"));
        Ok(serde_json::json!({}))
    }
    fn rest(&self, path: &str) -> Result<serde_json::Value, String> {
        self.calls.borrow_mut().push(format!("GET {path}"));
        if self.rest_fails {
            return Err("500 boom".to_string());
        }
        Ok(self.existing.clone())
    }
    fn post(&self, path: &str, _body: &serde_json::Value) -> Result<serde_json::Value, String> {
        self.calls.borrow_mut().push(format!("POST {path}"));
        let mut n = self.next_number.borrow_mut();
        *n += 1;
        Ok(serde_json::json!({ "number": *n, "node_id": format!("I_{}", *n) }))
    }
}

fn issue(json: serde_json::Value) -> PlanIssue {
    serde_json::from_value(json).unwrap()
}

fn existing_from(pairs: &[(i64, &str)]) -> ExistingIssues {
    let mut numbers = HashSet::new();
    let mut by_title = HashMap::new();
    for (n, t) in pairs {
        numbers.insert(*n);
        by_title.entry(t.to_string()).or_insert((*n, Some(format!("I_{n}"))));
    }
    ExistingIssues { numbers, by_title }
}

#[test]
fn a_published_row_is_matched_by_identity_even_after_it_is_retitled() {
    // THE BUG THIS PREVENTS: matching by title meant renaming an issue on GitHub made publish
    // believe the row was new and open a duplicate. The row's title here deliberately does NOT
    // match what GitHub holds.
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "A brand new title", "ghNumber": 42 }));
    let existing = existing_from(&[(42, "The original title")]);
    assert_eq!(decide(&iss, &existing), IssueAction::AlreadyPublished(42));
}

#[test]
fn a_legacy_row_is_matched_by_title_once_and_then_carries_its_number() {
    // Rows published before the identity column have no ghNumber. The title match backfills it —
    // matched by title exactly once, by identity forever after.
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "Add login" }));
    let existing = existing_from(&[(7, "Add login")]);
    assert_eq!(decide(&iss, &existing), IssueAction::LinkExisting(7, Some("I_7".into())));

    let linked = issue(serde_json::json!({ "ref": "r1", "title": "Add login", "ghNumber": 7 }));
    assert_eq!(decide(&linked, &existing), IssueAction::AlreadyPublished(7));
}

#[test]
fn a_title_match_without_a_usable_number_records_no_identity() {
    // Writing a 0 number would FABRICATE an identity pointing at nothing — and the next publish
    // would trust it and skip the issue forever. "Exists" is still right (do not re-create it).
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "Add login" }));
    let mut by_title = HashMap::new();
    by_title.insert("Add login".to_string(), (0i64, None));
    let existing = ExistingIssues { numbers: HashSet::new(), by_title };
    assert_eq!(decide(&iss, &existing), IssueAction::ExistsUnlinked);
}

#[test]
fn a_row_whose_recorded_number_is_gone_from_github_is_recreated_not_skipped() {
    // A ghNumber that no longer exists must NOT be trusted blindly — identity only settles the row
    // when GitHub still holds that number. Falls through to title, then to Create.
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "Add login", "ghNumber": 999 }));
    let existing = existing_from(&[(7, "Something else")]);
    assert_eq!(decide(&iss, &existing), IssueAction::Create);
}

#[test]
fn a_failed_existing_issue_scan_skips_the_repo_instead_of_creating_into_it() {
    // FAIL CLOSED. If we cannot see what a repo holds, creating would duplicate every issue in it.
    // A transient 500 must cost a skipped repo, never a duplicated backlog.
    let api = FakeGh::failing();
    let a = issue(serde_json::json!({ "ref": "r1", "title": "One" }));
    let b = issue(serde_json::json!({ "ref": "r2", "title": "Two" }));
    let mut report = Report::default();
    let ids = create_issues_for_repo(&api, "o/r", &[&a, &b], None, "", &mut report);

    assert!(ids.is_empty(), "nothing may be linked when the scan failed");
    assert_eq!(api.posts_to("/issues"), 0, "NOT ONE issue may be created after a failed scan");
    assert_eq!(report.outcomes.len(), 2);
    assert!(report.outcomes.iter().all(|o| o.status == Status::Skipped));
}

#[test]
fn an_issues_identity_is_recorded_before_the_best_effort_calls_that_can_fail() {
    // ORDERING GUARANTEE: board-add and assignee are best-effort and can throw. If identity were
    // written after them, a failure there would leave a real GitHub issue that plan.db has no
    // record of — and the next publish would create it a second time.
    let api = FakeGh::new(serde_json::json!([]));
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "One", "stream": "s1" }));
    let mut report = Report::default();
    let ids = create_issues_for_repo(&api, "o/r", &[&iss], Some("PVT_1"), "octocat", &mut report);

    assert_eq!(ids.len(), 1, "the identity is captured");
    assert_eq!(ids[0].r#ref, "r1");
    assert!(ids[0].gh_number > 0);

    let calls = api.calls();
    let create_at = calls.iter().position(|c| c == "POST repos/o/r/issues").expect("issue created");
    let assign_at = calls.iter().position(|c| c.contains("/assignees")).expect("assignee attempted");
    assert!(create_at < assign_at, "the issue is created before it is assigned: {calls:?}");
}

#[test]
fn issues_are_created_already_carrying_their_stream_and_provenance_labels() {
    // Labelling AT CREATION, where the real number is in hand — the post-hoc "label by predicted
    // number" pass 404s whenever an issue failed to post or the numbering drifted.
    let iss = issue(serde_json::json!({
        "ref": "r1", "title": "One", "stream": "api", "labels": ["ui"]
    }));
    let labels = labels_for(&iss);
    assert!(labels.contains(&"ui".to_string()), "its own labels survive");
    assert!(labels.contains(&"stream:api".to_string()), "the owning stream is tagged at creation");
    assert!(labels.contains(&"bsc-generated".to_string()), "provenance is stamped");

    let no_stream = issue(serde_json::json!({ "ref": "r2", "title": "Two" }));
    assert!(!labels_for(&no_stream).iter().any(|l| l.starts_with("stream:")));
}

#[test]
fn an_issue_routes_to_its_declared_repo_else_the_first() {
    let repos = vec!["o/a".to_string(), "o/b".to_string()];
    let declared = issue(serde_json::json!({ "ref": "r1", "title": "T", "repo": "o/b" }));
    assert_eq!(repo_for(&declared, &repos), Some(&"o/b".to_string()));
    let bare = issue(serde_json::json!({ "ref": "r2", "title": "T" }));
    assert_eq!(repo_for(&bare, &repos), Some(&"o/a".to_string()));
}

#[test]
fn republishing_an_unchanged_plan_creates_nothing() {
    // The end-to-end idempotency property: publish twice, and the second run is all no-ops. This is
    // what makes publish safe to re-run, which a director doing it unattended depends on.
    let iss = issue(serde_json::json!({ "ref": "r1", "title": "One" }));
    let api = FakeGh::new(serde_json::json!([]));
    let mut first = Report::default();
    let ids = create_issues_for_repo(&api, "o/r", &[&iss], None, "", &mut first);
    assert_eq!(first.outcomes[0].status, Status::Created);

    let published = issue(serde_json::json!({
        "ref": "r1", "title": "One", "ghNumber": ids[0].gh_number
    }));
    let seen = serde_json::json!([{ "number": ids[0].gh_number, "title": "One", "node_id": "I_x" }]);
    let api2 = FakeGh::new(seen);
    let mut second = Report::default();
    create_issues_for_repo(&api2, "o/r", &[&published], None, "", &mut second);

    assert_eq!(second.outcomes[0].status, Status::Exists);
    assert_eq!(api2.posts_to("/issues"), 0, "a republish must create nothing");
}
