//! Publish a plan's GitHub structure with no frontend involved
//! (`headless-publish-so-the-ui-is-not-the-only-publisher`).
//!
//! Publish used to run ONLY from React: `usePlanPublish` orchestrated it and the transport was
//! `invoke("github_post")` and friends. That made the app the only thing that could publish a plan,
//! so an architect or director could not publish one it had just authored — and it blocked removing
//! the planner UI, since deleting the screen would have deleted the capability with it.
//!
//! The sequence here is ported from `@/features/planner/session/publishSteps`, whose steps were
//! already dependency-injected and React-free. The IDEMPOTENCY RULES are the part that matters and
//! they are preserved exactly:
//!
//! - **Identity first.** A row that knows its GitHub number is settled — no title comparison — so
//!   renaming an issue no longer makes publish believe it is new and open a duplicate.
//! - **Title match is a one-time migration.** It exists only for rows published before the identity
//!   column, and it backfills the number when it hits, so a legacy row is matched by title exactly
//!   once and by identity forever after.
//! - **Fail CLOSED.** If a repo's existing-issue list can't be fetched, that repo is SKIPPED rather
//!   than created into — a transient read failure must never cause duplicate creation.
//! - **The identity write goes before the best-effort calls.** Board-add, assignee and sub-issue
//!   linking can all throw; if identity were written after them, a failure there would leave a real
//!   GitHub issue that plan.db has no record of, and the next publish would create it again.
//!
//! NOT YET PORTED: repo scaffolding (README/topics/community files/dependency manifests). It is the
//! largest step and depends on a wide TS surface (`buildReadme`, `deriveTopics`, `communityFiles`,
//! the manifest merges), and it is repo PRESENTATION rather than plan structure — so it is tracked
//! separately rather than half-done here. A headless publish today lands the structure; it does not
//! yet dress the repos.

pub mod cli;
pub mod render;
pub mod token;

use plandb::PlanIssue;
use render::{render_issue_body, with_provenance_label, BSC_ISSUE_LABEL, BSC_ISSUE_LABEL_COLOR};

/// The GitHub calls publish needs. A trait so the orchestration can be tested against a fake: the
/// rules above are all about WHICH calls happen in which order, which a network test could not pin
/// and a unit test can.
pub trait GhApi {
    fn gql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String>;
    fn rest(&self, path: &str) -> Result<serde_json::Value, String>;
    fn post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String>;
}

/// The live transport, over the extracted Tauri-free crate.
pub struct LiveGh {
    pub token: String,
}

impl GhApi for LiveGh {
    fn gql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
        bsc_github::blocking::graphql(&self.token, query, Some(variables))
    }
    fn rest(&self, path: &str) -> Result<serde_json::Value, String> {
        bsc_github::blocking::request(&self.token, path)
    }
    fn post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        bsc_github::blocking::post(&self.token, path, body)
    }
}

/// What happened to one object, for the run report. Mirrors the status the UI card showed, so the
/// two surfaces describe a publish the same way.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub id: String,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Created,
    Exists,
    Skipped,
    Error,
}

impl Outcome {
    fn new(id: impl Into<String>, status: Status, detail: impl Into<String>) -> Self {
        Outcome { id: id.into(), status, detail: Some(detail.into()) }
    }
}

/// The full run report.
#[derive(Debug, Default, serde::Serialize)]
pub struct Report {
    pub outcomes: Vec<Outcome>,
}

impl Report {
    pub fn push(&mut self, o: Outcome) {
        self.outcomes.push(o);
    }
    /// Whether anything errored — the process exit code keys off this, so a partial failure is not
    /// reported as a clean publish.
    pub fn any_error(&self) -> bool {
        self.outcomes.iter().any(|o| o.status == Status::Error)
    }
}

// ── 1. Repositories — verify each exists; create if missing ────────────────────

/// The publishing account's login, used to decide `user/repos` vs `orgs/<owner>/repos` and as the
/// default issue assignee. A failure here is non-fatal: it only costs the org-repo fallback.
pub fn viewer_login(api: &dyn GhApi) -> String {
    api.gql("{ viewer { login } }", serde_json::Value::Null)
        .ok()
        .and_then(|v| v.get("viewer")?.get("login")?.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Ensure every repo exists, creating the missing ones. Returns each repo's GraphQL node id, which
/// the board-link step needs.
pub fn publish_repositories(
    api: &dyn GhApi,
    repos: &[String],
    description: &str,
    private: bool,
    viewer: &str,
    report: &mut Report,
) -> std::collections::HashMap<String, String> {
    let mut node_ids = std::collections::HashMap::new();
    for full_name in repos {
        let id = format!("repo:{full_name}");
        let (owner, name) = match full_name.split_once('/') {
            Some(p) => p,
            None => {
                report.push(Outcome::new(id, Status::Error, "not an owner/name repo"));
                continue;
            }
        };
        // An existing repo is detected here and NEVER re-created, so the visibility below governs
        // creation only.
        if let Ok(existing) = api.rest(&format!("repos/{full_name}")) {
            if let Some(node) = existing.get("node_id").and_then(|v| v.as_str()) {
                node_ids.insert(full_name.clone(), node.to_string());
                report.push(Outcome::new(id, Status::Exists, "on github"));
                continue;
            }
        }
        let path = if owner.eq_ignore_ascii_case(viewer) {
            "user/repos".to_string()
        } else {
            format!("orgs/{owner}/repos")
        };
        let body = serde_json::json!({ "name": name, "private": private, "description": description });
        match api.post(&path, &body) {
            Ok(created) => {
                if let Some(node) = created.get("node_id").and_then(|v| v.as_str()) {
                    node_ids.insert(full_name.clone(), node.to_string());
                }
                report.push(Outcome::new(id, Status::Created, "created"));
            }
            Err(e) => report.push(Outcome::new(id, Status::Error, e)),
        }
    }
    node_ids
}

// ── 2. Project board — reuse an existing board or create one, then link the repos ──

/// Ensure a ProjectV2 board exists and every repo is linked to it. `existing` short-circuits to a
/// board already recorded for the project.
pub fn ensure_project_board(
    api: &dyn GhApi,
    existing: Option<&str>,
    repos: &[String],
    viewer: &str,
    title: &str,
    node_ids: &std::collections::HashMap<String, String>,
    report: &mut Report,
) -> Option<String> {
    let project_id = match existing {
        Some(id) if !id.is_empty() => {
            report.push(Outcome::new("project", Status::Exists, "linked"));
            Some(id.to_string())
        }
        _ => {
            let owner_login = repos
                .first()
                .and_then(|r| r.split('/').next())
                .filter(|s| !s.is_empty())
                .unwrap_or(viewer);
            if owner_login.is_empty() {
                report.push(Outcome::new("project", Status::Error, "no owner to create project under"));
                return None;
            }
            let owner = api.gql(
                "query($login:String!){ repositoryOwner(login:$login){ id } }",
                serde_json::json!({ "login": owner_login }),
            );
            let owner_id = owner
                .ok()
                .and_then(|v| v.get("repositoryOwner")?.get("id")?.as_str().map(str::to_string));
            let Some(owner_id) = owner_id else {
                report.push(Outcome::new(
                    "project",
                    Status::Error,
                    format!("could not resolve owner '{owner_login}'"),
                ));
                return None;
            };
            let created = api.gql(
                "mutation($ownerId:ID!,$title:String!){
                     createProjectV2(input:{ownerId:$ownerId,title:$title}){ projectV2 { id number url } }
                   }",
                serde_json::json!({ "ownerId": owner_id, "title": title }),
            );
            match created {
                Ok(v) => {
                    let pv = v.get("createProjectV2").and_then(|c| c.get("projectV2"));
                    match pv.and_then(|p| p.get("id")).and_then(|i| i.as_str()) {
                        Some(id) => {
                            let num = pv
                                .and_then(|p| p.get("number"))
                                .and_then(|n| n.as_i64())
                                .map(|n| format!("#{n}"))
                                .unwrap_or_else(|| "created".to_string());
                            report.push(Outcome::new("project", Status::Created, num));
                            Some(id.to_string())
                        }
                        None => {
                            report.push(Outcome::new("project", Status::Error, "project not created"));
                            None
                        }
                    }
                }
                Err(e) => {
                    report.push(Outcome::new("project", Status::Error, e));
                    None
                }
            }
        }
    };

    // Link every repo to the board. Idempotent server-side, so an already-linked repo just errors
    // harmlessly and is ignored.
    if let Some(pid) = project_id.as_deref() {
        for full_name in repos {
            if let Some(node) = node_ids.get(full_name) {
                let _ = api.gql(
                    "mutation($p:ID!,$r:ID!){ linkProjectV2ToRepository(input:{projectId:$p,repositoryId:$r}){ repository { id } } }",
                    serde_json::json!({ "p": pid, "r": node }),
                );
            }
        }
    }
    project_id
}

// ── 3. Issues ──────────────────────────────────────────────────────────────────

/// What an existing-issue scan found for one repo, so the create loop can decide per issue.
pub struct ExistingIssues {
    pub numbers: std::collections::HashSet<i64>,
    /// title → the FIRST row carrying it. One fetch, not one query per issue: a per-issue lookup is
    /// the N-per-item fan-out this codebase has repeatedly paid for.
    pub by_title: std::collections::HashMap<String, (i64, Option<String>)>,
}

/// Scan a repo's existing issues. `Err` means the scan FAILED and the caller must skip the repo —
/// distinct from a successful scan that found nothing.
pub fn scan_existing(api: &dyn GhApi, full_name: &str) -> Result<ExistingIssues, String> {
    let rows = api.rest(&format!("repos/{full_name}/issues?state=all&per_page=100"))?;
    let arr = rows.as_array().cloned().unwrap_or_default();
    let mut numbers = std::collections::HashSet::new();
    let mut by_title: std::collections::HashMap<String, (i64, Option<String>)> = std::collections::HashMap::new();
    for r in arr {
        if let Some(n) = r.get("number").and_then(|v| v.as_i64()) {
            numbers.insert(n);
            if let Some(t) = r.get("title").and_then(|v| v.as_str()) {
                let node = r.get("node_id").and_then(|v| v.as_str()).map(str::to_string);
                by_title.entry(t.to_string()).or_insert((n, node));
            }
        }
    }
    Ok(ExistingIssues { numbers, by_title })
}

/// What the create loop decided for one issue — extracted so the rules are unit-testable without a
/// transport at all.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueAction {
    /// Already on GitHub under this number; nothing to do.
    AlreadyPublished(i64),
    /// Matched a pre-existing issue by TITLE — link it (a one-time migration for legacy rows).
    LinkExisting(i64, Option<String>),
    /// Matched by title but the match carried no usable number — treat as existing, write nothing.
    /// Writing a 0/absent number would fabricate an identity pointing at nothing, and the next
    /// publish would trust it and skip the issue forever.
    ExistsUnlinked,
    /// Not on GitHub — create it.
    Create,
}

/// Decide what to do with one plan row, given what the repo already holds. Pure.
pub fn decide(issue: &PlanIssue, existing: &ExistingIssues) -> IssueAction {
    // IDENTITY FIRST — a row that knows its number is settled, whatever its title now says.
    if let Some(n) = issue.gh_number {
        if existing.numbers.contains(&n) {
            return IssueAction::AlreadyPublished(n);
        }
    }
    match existing.by_title.get(&issue.title) {
        Some((n, node)) if *n > 0 => IssueAction::LinkExisting(*n, node.clone()),
        Some(_) => IssueAction::ExistsUnlinked,
        None => IssueAction::Create,
    }
}

/// The labels an issue is created with: its own, plus its `stream:<id>` when it has an owning
/// stream, plus the provenance stamp. Labelling AT CREATION — where the real number is in hand —
/// avoids the fragile post-hoc "label by the plan's predicted number" pass, whose numbers 404 when
/// an issue failed to post or the numbering drifted.
pub fn labels_for(issue: &PlanIssue) -> Vec<String> {
    let mut labels = issue.labels.clone();
    if let Some(s) = issue.stream.as_deref().filter(|s| !s.is_empty()) {
        labels.push(format!("stream:{s}"));
    }
    with_provenance_label(&labels)
}

/// Which repo an issue belongs to: its declared `repo`, else the default (first) repo.
pub fn repo_for<'a>(issue: &'a PlanIssue, repos: &'a [String]) -> Option<&'a String> {
    match issue.repo.as_ref().filter(|r| !r.is_empty()) {
        Some(r) => repos.iter().find(|x| *x == r).or(Some(r)),
        None => repos.first(),
    }
}

/// Ensure the labels an issue set uses exist on the repo. A 422 means "already there" and is
/// harmless, so failures are ignored.
fn ensure_labels(api: &dyn GhApi, full_name: &str, issues: &[&PlanIssue]) {
    let _ = api.post(
        &format!("repos/{full_name}/labels"),
        &serde_json::json!({ "name": BSC_ISSUE_LABEL, "color": BSC_ISSUE_LABEL_COLOR }),
    );
    let mut seen = std::collections::HashSet::new();
    for iss in issues {
        for l in &iss.labels {
            if seen.insert(l.clone()) {
                let _ = api.post(
                    &format!("repos/{full_name}/labels"),
                    &serde_json::json!({ "name": l, "color": "0e8a16" }),
                );
            }
        }
        if let Some(s) = iss.stream.as_deref().filter(|s| !s.is_empty()) {
            let label = format!("stream:{s}");
            if seen.insert(label.clone()) {
                let _ = api.post(
                    &format!("repos/{full_name}/labels"),
                    &serde_json::json!({ "name": label, "color": "5319e7" }),
                );
            }
        }
    }
}

/// Where a decided issue's GitHub identity should be written back to the plan store.
pub struct Identity {
    pub r#ref: String,
    pub gh_number: i64,
    pub gh_node_id: Option<String>,
}

/// Create (or reconcile) every issue for one repo. Returns the identities to persist — the caller
/// writes them, so this stays testable without a store.
#[allow(clippy::too_many_arguments)]
pub fn create_issues_for_repo(
    api: &dyn GhApi,
    full_name: &str,
    issues: &[&PlanIssue],
    project_id: Option<&str>,
    default_assignee: &str,
    report: &mut Report,
) -> Vec<Identity> {
    let mut identities = Vec::new();

    // FAIL CLOSED: without a reliable view of what exists, skip the repo rather than risk
    // duplicating every issue in it.
    let existing = match scan_existing(api, full_name) {
        Ok(e) => e,
        Err(_) => {
            for iss in issues {
                report.push(Outcome::new(
                    format!("issue:{full_name}:{}", iss.r#ref),
                    Status::Skipped,
                    "couldn't verify existing issues — skipped",
                ));
            }
            return identities;
        }
    };

    ensure_labels(api, full_name, issues);

    for iss in issues {
        let id = format!("issue:{full_name}:{}", iss.r#ref);
        match decide(iss, &existing) {
            IssueAction::AlreadyPublished(n) => {
                report.push(Outcome::new(id, Status::Exists, format!("#{n}")));
            }
            IssueAction::LinkExisting(n, node) => {
                identities.push(Identity { r#ref: iss.r#ref.clone(), gh_number: n, gh_node_id: node });
                report.push(Outcome::new(id, Status::Exists, format!("#{n} · linked")));
            }
            IssueAction::ExistsUnlinked => {
                report.push(Outcome::new(id, Status::Exists, "already exists"));
            }
            IssueAction::Create => {
                let body = serde_json::json!({
                    "title": iss.title,
                    "body": render_issue_body(iss),
                    "labels": labels_for(iss),
                });
                match api.post(&format!("repos/{full_name}/issues"), &body) {
                    Ok(created) => {
                        let number = created.get("number").and_then(|v| v.as_i64()).unwrap_or(0);
                        let node = created.get("node_id").and_then(|v| v.as_str()).map(str::to_string);
                        // The identity write is recorded BEFORE the best-effort calls below, so a
                        // failure there can never leave a real issue plan.db has no record of.
                        if number > 0 {
                            identities.push(Identity {
                                r#ref: iss.r#ref.clone(),
                                gh_number: number,
                                gh_node_id: node.clone(),
                            });
                        }
                        if let (Some(pid), Some(node)) = (project_id, node.as_deref()) {
                            let _ = api.gql(
                                "mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }",
                                serde_json::json!({ "p": pid, "c": node }),
                            );
                        }
                        // Assign AFTER the issue exists, so an invalid / no-access login (a 422) is
                        // skipped gracefully and never loses the issue.
                        if !default_assignee.is_empty() && number > 0 {
                            let _ = api.post(
                                &format!("repos/{full_name}/issues/{number}/assignees"),
                                &serde_json::json!({ "assignees": [default_assignee] }),
                            );
                        }
                        report.push(Outcome::new(id, Status::Created, format!("#{number}")));
                    }
                    Err(e) => report.push(Outcome::new(id, Status::Error, e)),
                }
            }
        }
    }
    identities
}
