//! Local **change records** — the PR analogue for the local-first workflow.
//!
//! Work is tracked in `issues`; the CHANGE that satisfies an issue lived only in git (a branch and a
//! merge commit) and in commit prose. That is durable but not queryable, and it carries none of the
//! things a PR carries: evidence that the gate actually ran, a reviewer's verdict as an actor
//! distinct from the author, notes written while the reasoning was live, and the GitHub identity the
//! change takes on once connected.
//!
//! **One ref answers everything.** A change's `ref` IS the branch name IS the issue ref — the 1:1:1:1
//! chain the workflow already runs (one item = one ref = one branch = one worktree = one agent). This
//! table makes that chain queryable instead of implied.
//!
//! **It does not duplicate git.** `head_sha`/`merge_sha` are the join to real history; the commit
//! messages stay the narrative. What lives here is only what git cannot hold.
//!
//! **Sync is the identity pattern already proven on `issues`** (see `set_github_identity` there): a
//! NULL `gh_number` means "not on GitHub yet" and is the entire input to a future `bsc plan sync`.
//! Nothing here ever writes to GitHub.

use crate::Store;
use rusqlite::params;
use serde::{Deserialize, Serialize};

/// The statuses a change walks. `draft` → `open` → `merged`, or `abandoned`. Deliberately NOT the
/// issue statuses: an issue is `complete` when its author is done and `verified` when a reviewer
/// confirms, while a change is `merged` when it is actually in the base branch — those are different
/// facts and collapsing them is how "done" stops meaning anything.
pub const CHANGE_STATUSES: &[&str] = &["draft", "open", "merged", "abandoned"];

/// Whether `s` is a known change status.
pub fn is_valid_change_status(s: &str) -> bool {
    CHANGE_STATUSES.contains(&s.trim())
}

/// One recorded work note — the local analogue of a PR comment, appended AS THE WORK HAPPENS. The
/// value of a note is that it was written while the reasoning was live; reconstructing one afterwards
/// loses exactly the part worth keeping.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeNote {
    /// Epoch seconds.
    #[serde(default)]
    pub at: i64,
    /// Who wrote it — a pane id, a stream, "user". Free-form; provenance, not an enum.
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub text: String,
}

/// One recorded MEASUREMENT — what the change cost, before and after.
///
/// The change record already holds gate results as EVIDENCE rather than claims; a performance change
/// should carry its numbers the same way. "It's faster" is not reviewable. `build: 92s -> 74s` is.
///
/// `before` and `after` are free-form STRINGS on purpose. The units differ per metric (seconds,
/// megabytes, a render count) and a numeric column would force one, or force every caller to
/// normalize into it — at which point the reader has to know the normalization to interpret the
/// number. The string is what the measuring surface printed, kept verbatim.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeMeasure {
    /// Epoch seconds.
    #[serde(default)]
    pub at: i64,
    /// What was measured — `build`, `heap`, `jank`, a surface name. Free-form: the set of things worth
    /// measuring is not one this store should be deciding in advance.
    #[serde(default)]
    pub metric: String,
    #[serde(default)]
    pub before: String,
    #[serde(default)]
    pub after: String,
    /// Who measured it — the same provenance field a note carries.
    #[serde(default)]
    pub author: String,
}

/// A **change**: the local PR. Serializes camelCase for the frontend + the `bsc` JSON surface.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    /// The branch name, which is also the issue ref (1:1). The primary key.
    #[serde(default)]
    pub r#ref: String,
    #[serde(default)]
    pub title: String,
    /// The change description — the PR body's prose half.
    #[serde(default)]
    pub body: String,
    /// Issue refs this change closes. Usually exactly one (the 1:1 chain), but a change that lands
    /// two items together is representable rather than forced into a lie.
    #[serde(default)]
    pub issues: Vec<String>,
    /// The branch this merges into.
    #[serde(default)]
    pub base: String,
    /// The branch tip and, once landed, the merge commit — the join to real git history.
    #[serde(default)]
    pub head_sha: String,
    #[serde(default)]
    pub merge_sha: String,
    /// One of {@link CHANGE_STATUSES}.
    #[serde(default)]
    pub status: String,
    /// Gate results as `{"typecheck":"pass","lint":"pass","test":"skipped"}` — evidence, recorded when
    /// the gate ran. This is what makes "complete" a claim with something behind it.
    #[serde(default)]
    pub gates: serde_json::Map<String, serde_json::Value>,
    /// Append-only work notes, oldest first.
    #[serde(default)]
    pub notes: Vec<ChangeNote>,
    /// Recorded before/after measurements. Append-only, like `notes`.
    #[serde(default)]
    pub measures: Vec<ChangeMeasure>,
    /// Who confirmed the acceptance criteria — deliberately separate from whoever wrote the change.
    #[serde(default)]
    pub reviewer: String,
    #[serde(default)]
    pub reviewed_at: i64,
    /// The GitHub identity, once published. NULL/absent until then — see the module note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_number: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gh_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub synced_at: Option<i64>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

/// The `changes` table DDL — run by the crate's `migrate`.
///
/// `gates` and `notes` are JSON text columns, matching how `issues` stores `acceptance`/`owns`/
/// `labels`. The GitHub columns are nullable and NOT defaulted, for the same reason they are on
/// `issues`: a `DEFAULT 0` would make every pre-existing row claim to be PR #0 and the first sync
/// would skip all of them.
pub(crate) const CHANGES_DDL: &str = "CREATE TABLE IF NOT EXISTS changes (
    ref         TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL DEFAULT '',
    issues      TEXT NOT NULL DEFAULT '[]',
    base        TEXT NOT NULL DEFAULT 'develop',
    head_sha    TEXT NOT NULL DEFAULT '',
    merge_sha   TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'draft',
    gates       TEXT NOT NULL DEFAULT '{}',
    notes       TEXT NOT NULL DEFAULT '[]',
    measures    TEXT NOT NULL DEFAULT '[]',
    reviewer    TEXT NOT NULL DEFAULT '',
    reviewed_at INTEGER NOT NULL DEFAULT 0,
    gh_number   INTEGER,
    gh_node_id  TEXT,
    synced_at   INTEGER,
    created_at  INTEGER NOT NULL DEFAULT 0,
    updated_at  INTEGER NOT NULL DEFAULT 0
);";

const CHANGE_COLS: &str = "SELECT ref, title, body, issues, base, head_sha, merge_sha, status, gates, notes, \
     reviewer, reviewed_at, gh_number, gh_node_id, synced_at, created_at, updated_at, measures FROM changes";

fn json_vec(s: &str) -> Vec<String> {
    serde_json::from_str(s).unwrap_or_default()
}

fn row_to_change(r: &rusqlite::Row) -> rusqlite::Result<Change> {
    let issues: String = r.get(3)?;
    let gates: String = r.get(8)?;
    let notes: String = r.get(9)?;
    Ok(Change {
        r#ref: r.get(0)?,
        title: r.get(1)?,
        body: r.get(2)?,
        issues: json_vec(&issues),
        base: r.get(4)?,
        head_sha: r.get(5)?,
        merge_sha: r.get(6)?,
        status: r.get(7)?,
        gates: serde_json::from_str(&gates).unwrap_or_default(),
        notes: serde_json::from_str(&notes).unwrap_or_default(),
        reviewer: r.get(10)?,
        reviewed_at: r.get(11)?,
        gh_number: r.get(12)?,
        gh_node_id: r.get(13)?,
        synced_at: r.get(14)?,
        created_at: r.get(15)?,
        updated_at: r.get(16)?,
        // Appended LAST in the SELECT so every existing positional index above is untouched — a new
        // column inserted mid-list would silently re-map every field after it.
        measures: serde_json::from_str(&r.get::<_, String>(17)?).unwrap_or_default(),
    })
}

impl Store {
    /// Create or update a change. Like `issues::upsert`, the CONFLICT branch **preserves** the fields
    /// a different actor owns — `status`, `gates`, `notes`, the reviewer verdict and the GitHub
    /// identity — so re-running `new` to correct a title can never silently discard recorded evidence.
    pub fn change_upsert(&self, c: &Change) -> rusqlite::Result<()> {
        let r = c.r#ref.trim();
        if r.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName("a change needs a ref".into()));
        }
        let base = if c.base.trim().is_empty() { "develop" } else { c.base.trim() };
        let status = if c.status.trim().is_empty() { "draft" } else { c.status.trim() };
        self.conn.execute(
            "INSERT INTO changes (ref, title, body, issues, base, head_sha, merge_sha, status, gates, notes,
                                  reviewer, reviewed_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, '{}', '[]', '', 0, strftime('%s','now'), strftime('%s','now'))
             ON CONFLICT(ref) DO UPDATE SET
                title      = excluded.title,
                body       = excluded.body,
                issues     = excluded.issues,
                base       = excluded.base,
                head_sha   = CASE WHEN excluded.head_sha = '' THEN changes.head_sha ELSE excluded.head_sha END,
                updated_at = strftime('%s','now')",
            params![
                r,
                c.title.trim(),
                c.body.trim(),
                serde_json::to_string(&c.issues).unwrap_or_else(|_| "[]".into()),
                base,
                c.head_sha.trim(),
                status,
            ],
        )?;
        Ok(())
    }

    /// One change by ref.
    pub fn change_get(&self, r: &str) -> rusqlite::Result<Option<Change>> {
        let mut stmt = self.conn.prepare(&format!("{CHANGE_COLS} WHERE ref = ?1"))?;
        let mut rows = stmt.query_map(params![r.trim()], row_to_change)?;
        rows.next().transpose()
    }

    /// Changes, newest-touched first. `status` filters when non-empty.
    pub fn change_list(&self, status: &str) -> rusqlite::Result<Vec<Change>> {
        let st = status.trim();
        // Bound to a local before the block ends — the mapped-rows temporary borrows `stmt`, so
        // returning the `collect()` directly outlives it (the same shape `lessons.rs` handles).
        if st.is_empty() {
            let mut stmt = self.conn.prepare(&format!("{CHANGE_COLS} ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<Change>> = stmt.query_map([], row_to_change)?.collect();
            out
        } else {
            let mut stmt = self.conn.prepare(&format!("{CHANGE_COLS} WHERE status = ?1 ORDER BY updated_at DESC, ref"))?;
            let out: rusqlite::Result<Vec<Change>> = stmt.query_map(params![st], row_to_change)?.collect();
            out
        }
    }

    /// Append a work note. **Append-only by construction** — it reads, pushes and writes back rather
    /// than exposing a setter, so there is no verb that can drop an earlier note. Returns rows changed
    /// (0 = unknown ref).
    pub fn change_add_note(&self, r: &str, author: &str, text: &str) -> rusqlite::Result<usize> {
        let text = text.trim();
        if text.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName("a note needs text".into()));
        }
        let Some(mut c) = self.change_get(r)? else { return Ok(0) };
        c.notes.push(ChangeNote {
            at: now_secs(),
            author: author.trim().to_string(),
            text: text.to_string(),
        });
        self.conn.execute(
            "UPDATE changes SET notes = ?2, updated_at = strftime('%s','now') WHERE ref = ?1",
            params![r.trim(), serde_json::to_string(&c.notes).unwrap_or_else(|_| "[]".into())],
        )
    }

    /// Append one MEASUREMENT — what the change cost, before and after.
    ///
    /// **Append-only by construction**, exactly like [`Self::change_add_note`]: it reads, pushes and
    /// writes back rather than exposing a setter, so no verb can drop an earlier measurement. That
    /// matters more here than it looks — a second measurement of the same metric is usually a LATER
    /// iteration of the same optimization, and keeping both is what shows the path rather than only
    /// the destination.
    ///
    /// Returns rows changed (0 = unknown ref).
    pub fn change_add_measure(
        &self,
        r: &str,
        metric: &str,
        before: &str,
        after: &str,
        author: &str,
    ) -> rusqlite::Result<usize> {
        let (metric, before, after) = (metric.trim(), before.trim(), after.trim());
        if metric.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName("a measurement needs a metric".into()));
        }
        // BOTH HALVES ARE REQUIRED. An "after" with no "before" is not a measurement, it is a reading —
        // it cannot show that anything changed, which is the only claim this record exists to support.
        if before.is_empty() || after.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName(
                "a measurement needs both a before and an after — one number alone shows no change".into(),
            ));
        }
        let Some(mut c) = self.change_get(r)? else { return Ok(0) };
        c.measures.push(ChangeMeasure {
            at: now_secs(),
            metric: metric.to_string(),
            before: before.to_string(),
            after: after.to_string(),
            author: author.trim().to_string(),
        });
        self.conn.execute(
            "UPDATE changes SET measures = ?2, updated_at = strftime('%s','now') WHERE ref = ?1",
            params![r.trim(), serde_json::to_string(&c.measures).unwrap_or_else(|_| "[]".into())],
        )
    }

    /// Record one gate's result (`typecheck` → `pass`). Merges into the existing map, so recording
    /// lint never erases typecheck.
    pub fn change_set_gate(&self, r: &str, gate: &str, result: &str) -> rusqlite::Result<usize> {
        let (gate, result) = (gate.trim(), result.trim());
        if gate.is_empty() {
            return Err(rusqlite::Error::InvalidParameterName("a gate needs a name".into()));
        }
        let Some(mut c) = self.change_get(r)? else { return Ok(0) };
        c.gates.insert(gate.to_string(), serde_json::Value::String(result.to_string()));
        self.conn.execute(
            "UPDATE changes SET gates = ?2, updated_at = strftime('%s','now') WHERE ref = ?1",
            params![r.trim(), serde_json::to_string(&c.gates).unwrap_or_else(|_| "{}".into())],
        )
    }

    /// Set a change's status, optionally stamping the merge commit and the reviewer. `merge_sha` and
    /// `reviewer` are only written when non-empty, so advancing a status never blanks a recorded fact.
    pub fn change_set_status(&self, r: &str, status: &str, merge_sha: &str, reviewer: &str) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE changes SET
                status      = ?2,
                merge_sha   = CASE WHEN ?3 = '' THEN merge_sha ELSE ?3 END,
                reviewer    = CASE WHEN ?4 = '' THEN reviewer  ELSE ?4 END,
                reviewed_at = CASE WHEN ?4 = '' THEN reviewed_at ELSE strftime('%s','now') END,
                updated_at  = strftime('%s','now')
             WHERE ref = ?1",
            params![r.trim(), status.trim(), merge_sha.trim(), reviewer.trim()],
        )
    }

    /// Record the GitHub identity a publish established. COALESCE on the node id keeps a known one
    /// when a caller supplies only the number — the same rule as `issues::set_github_identity`.
    pub fn change_set_github_identity(&self, r: &str, number: i64, node_id: Option<&str>) -> rusqlite::Result<usize> {
        self.conn.execute(
            "UPDATE changes SET gh_number = ?2, gh_node_id = COALESCE(?3, gh_node_id),
                                synced_at = strftime('%s','now'), updated_at = strftime('%s','now')
             WHERE ref = ?1",
            params![r.trim(), number, node_id],
        )
    }

    /// Delete a change record.
    pub fn change_remove(&self, r: &str) -> rusqlite::Result<()> {
        bsc_sqlite_util::delete_by(&self.conn, "changes", "ref", r.trim())?;
        Ok(())
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The issue refs a change closes when the caller names none: the same-named issue **if it exists**,
/// otherwise nothing. An explicit `existing` list always wins.
///
/// The 1:1 chain (one item = one ref = one branch) makes "the issue of the same name" the right
/// default, but defaulting to it *unconditionally* fabricates a link: backfilling six conversational
/// slices produced six `Closes:` lines pointing at issues that had never existed. A record that claims
/// to close something it cannot name is worse than one that claims nothing.
pub fn default_issue_links(r: &str, issue_exists: bool, existing: &[String]) -> Vec<String> {
    if !existing.is_empty() {
        return existing.to_vec();
    }
    if issue_exists { vec![r.to_string()] } else { Vec::new() }
}

/// Render a change as markdown — the ONE text that serves as both the PR body when connected and the
/// CHANGELOG entry at release. Deriving both from one record is the point: the changelog falls behind
/// precisely because it is maintained separately from the work.
///
/// Pure over its input so a test can pin the shape without a database.
pub fn render_change_markdown(c: &Change) -> String {
    let mut out = String::new();
    out.push_str(&format!("## {}\n\n", if c.title.is_empty() { c.r#ref.as_str() } else { c.title.as_str() }));
    if !c.body.is_empty() {
        out.push_str(&format!("{}\n\n", c.body));
    }
    if !c.issues.is_empty() {
        // Local refs, not `Closes #N` — the GitHub form is only correct once synced, and writing it
        // early would be a link to nothing.
        out.push_str(&format!("**Closes:** {}\n\n", c.issues.join(", ")));
    }
    if !c.gates.is_empty() {
        let mut keys: Vec<&String> = c.gates.keys().collect();
        keys.sort();
        let line: Vec<String> = keys
            .iter()
            .map(|k| format!("{} {}", k, c.gates[*k].as_str().unwrap_or("?")))
            .collect();
        out.push_str(&format!("**Gate:** {}\n\n", line.join(" · ")));
    }
    // BEFORE the work notes: a reviewer scanning a performance change wants the numbers first, and the
    // notes are the long half. Rendered here means they reach the PR body and the CHANGELOG entry,
    // which is the whole reason `render` is the single source for both.
    if !c.measures.is_empty() {
        out.push_str("### Measured\n\n");
        for m in &c.measures {
            let who = if m.author.is_empty() { String::new() } else { format!(" _({})_", m.author) };
            out.push_str(&format!("- `{}` {} → {}{}\n", m.metric, m.before, m.after, who));
        }
        out.push('\n');
    }
    if !c.notes.is_empty() {
        out.push_str("### Work notes\n\n");
        for n in &c.notes {
            let who = if n.author.is_empty() { String::new() } else { format!(" _({})_", n.author) };
            out.push_str(&format!("- {}{}\n", n.text, who));
        }
        out.push('\n');
    }
    if !c.merge_sha.is_empty() {
        out.push_str(&format!("Merged as `{}` into `{}`.", c.merge_sha, c.base));
        if !c.reviewer.is_empty() {
            out.push_str(&format!(" Verified by {}.", c.reviewer));
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(s: &Store) {
        s.change_upsert(&Change {
            r#ref: "42-do-the-thing".into(),
            title: "Do the thing".into(),
            body: "Because the thing was not done.".into(),
            issues: vec!["42-do-the-thing".into()],
            head_sha: "abc123".into(),
            ..Default::default()
        })
        .unwrap();
    }

    #[test]
    fn change_lifecycle_draft_to_merged() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);

        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.status, "draft", "a new change starts as a draft");
        assert_eq!(c.base, "develop", "base defaults to develop");
        assert_eq!(c.issues, vec!["42-do-the-thing"]);
        assert!(c.gh_number.is_none(), "a local change has NO GitHub identity until it is published");

        // Gates accumulate — recording lint must not erase typecheck.
        s.change_set_gate("42-do-the-thing", "typecheck", "pass").unwrap();
        s.change_set_gate("42-do-the-thing", "lint", "pass").unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.gates.len(), 2);
        assert_eq!(c.gates["typecheck"], "pass");

        // The reviewer is stamped with the verdict, not by the author's own status write.
        s.change_set_status("42-do-the-thing", "merged", "deadbeef", "user").unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.status, "merged");
        assert_eq!(c.merge_sha, "deadbeef");
        assert_eq!(c.reviewer, "user");
        assert!(c.reviewed_at > 0, "a verdict records when it was given");

        // Advancing status again without a reviewer must not blank the recorded one.
        s.change_set_status("42-do-the-thing", "merged", "", "").unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.reviewer, "user", "an empty reviewer leaves the recorded verdict alone");
        assert_eq!(c.merge_sha, "deadbeef", "an empty sha leaves the recorded merge alone");
    }

    #[test]
    fn notes_are_append_only_and_upsert_never_drops_evidence() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        s.change_add_note("42-do-the-thing", "claude", "the glob has two halves").unwrap();
        s.change_add_note("42-do-the-thing", "user", "keep HooksView").unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.notes.len(), 2, "a second note appends, never replaces");
        assert_eq!(c.notes[0].text, "the glob has two halves", "oldest first");
        assert_eq!(c.notes[1].author, "user");
        assert!(c.notes[0].at > 0);

        // Re-running `new` to correct the title is a CONTENT write by the author; it must not discard
        // the gates, notes, status or verdict a different actor recorded.
        s.change_set_gate("42-do-the-thing", "typecheck", "pass").unwrap();
        s.change_set_status("42-do-the-thing", "open", "", "").unwrap();
        s.change_upsert(&Change {
            r#ref: "42-do-the-thing".into(),
            title: "Do the thing, properly".into(),
            ..Default::default()
        })
        .unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.title, "Do the thing, properly", "content updates");
        assert_eq!(c.notes.len(), 2, "notes survive a content rewrite");
        assert_eq!(c.gates.len(), 1, "gate evidence survives a content rewrite");
        assert_eq!(c.status, "open", "status is owned by the status verb, not by upsert");
        assert_eq!(c.head_sha, "abc123", "an empty head_sha does not blank a known one");

        // A note on an unknown ref reports nothing changed rather than inventing a row.
        assert_eq!(s.change_add_note("nope", "x", "y").unwrap(), 0);
        assert!(s.change_add_note("42-do-the-thing", "x", "  ").is_err(), "an empty note is rejected");
    }

    #[test]
    fn github_identity_is_nullable_and_node_id_is_preserved() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        s.change_set_github_identity("42-do-the-thing", 7, Some("PR_node")).unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.gh_number, Some(7));
        assert_eq!(c.gh_node_id.as_deref(), Some("PR_node"));
        assert!(c.synced_at.unwrap_or(0) > 0);

        // A later number-only write keeps the known node id (COALESCE) — same rule as issues.
        s.change_set_github_identity("42-do-the-thing", 8, None).unwrap();
        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.gh_number, Some(8));
        assert_eq!(c.gh_node_id.as_deref(), Some("PR_node"), "a number-only sync keeps the node id");
    }

    #[test]
    fn list_filters_by_status_and_a_ref_is_required() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        s.change_upsert(&Change { r#ref: "b".into(), title: "B".into(), ..Default::default() }).unwrap();
        s.change_set_status("b", "merged", "", "").unwrap();
        assert_eq!(s.change_list("").unwrap().len(), 2);
        assert_eq!(s.change_list("merged").unwrap().len(), 1);
        assert_eq!(s.change_list("draft").unwrap().len(), 1);
        assert!(s.change_upsert(&Change::default()).is_err(), "a change without a ref is unusable");
        s.change_remove("b").unwrap();
        assert_eq!(s.change_list("").unwrap().len(), 1);
    }

    #[test]
    fn render_serves_as_both_pr_body_and_changelog_entry() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        s.change_add_note("42-do-the-thing", "claude", "the trap was X").unwrap();
        s.change_set_gate("42-do-the-thing", "lint", "pass").unwrap();
        s.change_set_gate("42-do-the-thing", "typecheck", "pass").unwrap();
        s.change_set_status("42-do-the-thing", "merged", "deadbeef", "user").unwrap();
        let md = render_change_markdown(&s.change_get("42-do-the-thing").unwrap().unwrap());

        assert!(md.starts_with("## Do the thing\n"), "titled, so it drops straight into a changelog");
        assert!(md.contains("Because the thing was not done."));
        assert!(md.contains("**Closes:** 42-do-the-thing"));
        // Gates render in a stable (sorted) order so the same record never produces two different texts.
        assert!(md.contains("**Gate:** lint pass · typecheck pass"), "got: {md}");
        assert!(md.contains("### Work notes"));
        assert!(md.contains("- the trap was X _(claude)_"));
        assert!(md.contains("Merged as `deadbeef` into `develop`. Verified by user."));
        // Local refs, never `Closes #N` — the GitHub spelling is only correct after a sync.
        assert!(!md.contains("Closes #"), "must not fabricate a GitHub link before syncing");

        // A bare change renders its ref rather than an empty heading.
        let bare = render_change_markdown(&Change { r#ref: "only-a-ref".into(), ..Default::default() });
        assert!(bare.starts_with("## only-a-ref"));
    }

    #[test]
    fn default_issue_links_never_fabricate_a_closes_line() {
        // The 1:1 chain makes the same-named issue the right default WHEN it exists...
        assert_eq!(default_issue_links("42-x", true, &[]), vec!["42-x".to_string()]);
        // ...and nothing when it does not. This is the backfill bug: six conversational slices with no
        // plan item each claimed to close an issue of their own name.
        assert!(default_issue_links("42-x", false, &[]).is_empty());
        // An explicit list always wins over both.
        let given = vec!["a".to_string(), "b".to_string()];
        assert_eq!(default_issue_links("42-x", true, &given), given);
        assert_eq!(default_issue_links("42-x", false, &given), given);
    }

    #[test]
    fn statuses_are_validated() {
        assert!(is_valid_change_status("draft"));
        assert!(is_valid_change_status(" merged "));
        assert!(!is_valid_change_status("complete"), "issue statuses are NOT change statuses");
    }

    // ── measurements: the evidence half of an optimization ───────────────────────────────────────

    /// Measurements ACCUMULATE and are append-only, exactly like notes: a second reading of the same
    /// metric is usually a later iteration of the same optimization, and keeping both shows the path
    /// rather than only the destination.
    #[test]
    fn measurements_accumulate_and_never_replace_an_earlier_one() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        s.change_add_measure("42-do-the-thing", "build", "92s", "80s", "worker").unwrap();
        s.change_add_measure("42-do-the-thing", "build", "80s", "74s", "worker").unwrap();
        s.change_add_measure("42-do-the-thing", "heap", "58MB", "41MB", "worker").unwrap();

        let c = s.change_get("42-do-the-thing").unwrap().unwrap();
        assert_eq!(c.measures.len(), 3, "the SAME metric twice keeps both readings");
        assert_eq!((c.measures[0].before.as_str(), c.measures[0].after.as_str()), ("92s", "80s"));
        assert_eq!((c.measures[1].before.as_str(), c.measures[1].after.as_str()), ("80s", "74s"));
        assert_eq!(c.measures[2].metric, "heap");
        assert!(c.measures[0].at > 0, "a measurement records when it was taken");
        assert_eq!(c.measures[0].author, "worker");
    }

    /// ONE NUMBER IS NOT A MEASUREMENT. An `after` with no `before` cannot show that anything changed,
    /// which is the only claim this record exists to support — so it is refused rather than stored as
    /// half an answer somebody would later read as evidence.
    #[test]
    fn a_measurement_needs_both_halves() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        for (before, after) in [("", "74s"), ("92s", ""), ("", "")] {
            let err = s
                .change_add_measure("42-do-the-thing", "build", before, after, "w")
                .expect_err("half a measurement is refused");
            assert!(format!("{err}").contains("before and an after"), "{err}");
        }
        assert!(s.change_add_measure("42-do-the-thing", "", "1", "2", "w").is_err(), "and it needs a metric");
        assert!(s.change_get("42-do-the-thing").unwrap().unwrap().measures.is_empty());
    }

    /// An unknown ref reports 0 rows rather than inventing a change — the same contract `note`/`gate`
    /// have, so the CLI can turn it into one error message for all three.
    #[test]
    fn a_measurement_on_an_unknown_ref_writes_nothing() {
        let s = Store::open_in_memory().unwrap();
        assert_eq!(s.change_add_measure("nope", "build", "1s", "2s", "w").unwrap(), 0);
    }

    /// The measurements REACH the rendered markdown, which is what puts them in the PR body and the
    /// changelog entry — a measurement nobody can find later is not evidence.
    #[test]
    fn measurements_render_into_the_markdown_and_a_change_without_any_is_unchanged() {
        let s = Store::open_in_memory().unwrap();
        seed(&s);
        let before = render_change_markdown(&s.change_get("42-do-the-thing").unwrap().unwrap());
        assert!(!before.contains("### Measured"), "a change with no measurement renders as it always did");

        s.change_add_measure("42-do-the-thing", "build", "92s", "74s", "worker").unwrap();
        let after = render_change_markdown(&s.change_get("42-do-the-thing").unwrap().unwrap());
        assert!(after.contains("### Measured"), "{after}");
        assert!(after.contains("`build` 92s → 74s"), "{after}");
        assert!(after.contains("_(worker)_"), "the measurer is named: {after}");
    }

}
