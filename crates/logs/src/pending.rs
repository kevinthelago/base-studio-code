//! What is waiting on the DIRECTOR? (#captured-issues-and-briefs-have-no-queue-to-pull-from) — the
//! `bsc logs pending` query.
//!
//! ## Two kinds, and what closes each
//!
//! | kind    | opened by                | keyed by                        | closed by                          |
//! |---------|--------------------------|---------------------------------|------------------------------------|
//! | `issue` | `issue` (`bsc-issue`)    | `--id`, else `<session>@<at>`   | `assign` carrying `--issue <id>`   |
//! | `brief` | `brief` (`bsc-brief`)    | `<session>@<at>`                | `brief-done <id>` (`bsc-brief-done`)|
//!
//! ## WHY THIS IS A SIBLING OF `waiting` AND NOT TWO MORE KINDS INSIDE IT
//!
//! The choice was made explicitly, because choosing it by accident is how the two would end up
//! sharing clearing arms that do not mean the same thing.
//!
//! `waiting` answers **"which SESSION is stopped, and needs something to resume it?"**. Every one of
//! its four kinds is a parked pane — which is precisely why its `parked()` helper exists and why
//! `answer` · `assign` · `woke` · `maintain` all clear both `wait` and `ask`: those are the events
//! that UNPARK a pane, and a pane is parked for one reason at a time.
//!
//! An `issue` and a `brief` stop nothing. Nothing is parked; work has been CAPTURED and needs
//! routing. Folding them into `waiting` would put rows into a queue whose every clearing arm is a
//! pane-unpark event and whose consumers (the frontend reducer, the Coordination inbox, the mobile
//! payload) all read it as "blocked". It would also flatten a real difference in urgency: a parked
//! session is stalled RIGHT NOW, while captured work is inventory.
//!
//! The two verbs are deliberately parallel in every other respect — same project scoping, same
//! oldest-first ordering, same whole-log re-derivation — so a director sweeping both learns one
//! discipline, not two.
//!
//! ## WHY A BRIEF NEEDED A NEW CLOSING EVENT
//!
//! An `issue` already had one: the `assign` that routes it. A `brief` had NONE — the frontend reducer
//! says so in as many words ("there is no consuming event that clears it — it's a standing record"),
//! and its surfacing was guarded once-per-pane by the pump rather than by the row being closed. Under
//! the pull model there is no pump doing that guarding, so a brief would sit in this queue forever
//! and the queue would never empty. That is the exact failure `waiting` had before its clearing arms
//! were corrected, where the director was re-handed resolved questions for two weeks.
//!
//! Three closings were considered. Reconciling a brief IMPLICITLY, via any later `assign` from the
//! target, was rejected because a brief that needs no assign — the plan already matched it, or the
//! director judged it out of scope — would then never close, which is the same bug in a new place.
//! Closing it on a recorded decision was rejected for the same reason plus a second: not every brief
//! warrants a decision record. So the close is EXPLICIT (`bsc-brief-done <id>`), mirroring the one
//! existing id-keyed pair in this log, `request` / `request-resolved`. It also happens to be the
//! honest signal: the architect wants to know the director took the brief on board, not that some
//! assign occurred nearby.
//!
//! ## Agreement with the frontend reducer
//!
//! `coordinationLog.ts` computes the same open sets for the app, and the identity rules here are
//! copied from it deliberately: an issue's id is `--id` when present and `<session>@<at>` otherwise,
//! a brief's id is always `<session>@<at>`, and an `assign` clears an issue only when it carries an
//! `--issue`. The pairing cannot be shared (that side is TypeScript), so each rule is tested here
//! independently rather than assumed equivalent — the same discipline `waiting.rs` follows.
//!
//! **`brief-done` has NO frontend arm, and that is deliberate rather than an oversight.** The app
//! does not render a pending queue at all; its `CoordState.briefs` feeds the director pump, whose
//! re-injection is already guarded by its OWN once-per-pane `surfaced` set rather than by the row
//! being removed. So removing a brief there would change what the pump surfaces while fixing nothing.
//! The new event is inert on that side by construction — `parseCoordLine`'s `default` arm returns
//! `null` for a kind it does not know, so an unparsed `brief-done` folds into no state change at all.
//! If the app ever grows a pending view, THAT is when the reducer needs the arm, and it should be
//! added with the same id rules used here.

use crate::read_stream;
use crate::waiting::same_coord_project;
use std::path::Path;

/// One row of work awaiting the director.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingItem {
    /// `issue` · `brief` — what kind of routing it needs.
    pub kind: String,
    /// The id that CLOSES this row: `bsc-assign --issue <id>` for an issue, `bsc-brief-done <id>`
    /// for a brief. Always non-empty, because a row nothing can name is a row the queue can never
    /// clear — see the synthetic `<session>@<at>` fallback.
    pub id: String,
    /// Who emitted it — the issuer/auditor for an issue, the upstream tier for a brief.
    pub from: String,
    /// A brief's target pane. Empty for an issue, which names no target until it is routed.
    pub target: String,
    /// The issue's title, or the brief's `--ref`. Empty when the emitter passed none.
    pub title: String,
    /// The body the emitter piped in.
    pub detail: String,
    /// Epoch-ms of the opening event.
    pub at: u64,
}

/// The synthetic id for a row whose emitter passed none — `<session>@<at>`.
///
/// Copied from the frontend reducer rather than invented: it already falls back to exactly this for
/// an issue, and uses it unconditionally for a brief. Deriving the id FROM THE ROW is what makes an
/// un-`--id`'d issue closable at all — the director reads the id out of this queue and passes it to
/// `bsc-assign --issue`. The alternative, minting an id inside `bsc-issue`, was rejected: it would
/// change an emitter every persona already calls, to produce a value the emitting session has no use
/// for and never sees.
fn synthetic_id(session: &str, at: u64) -> String {
    format!("{session}@{at}")
}

/// Everything awaiting the director's routing, oldest first.
pub fn pending(dir: &Path) -> Vec<PendingItem> {
    pending_in(dir, None)
}

/// [`pending`], narrowed to one project's rows.
///
/// `scope` is the CALLER's pane id (`$BSC_AUDIT_PANE`), exactly as [`crate::waiting::waiting_in`]
/// takes it — same rule, same reason: `coord.log` is one app-wide file, and a director handed
/// another project's captured work would route work it has no authority over.
pub fn pending_in(dir: &Path, scope: Option<&str>) -> Vec<PendingItem> {
    let mut open: Vec<PendingItem> = Vec::new();

    for e in read_stream(dir, "coord") {
        // `fields` are the raw columns from the KIND onward (`lib.rs`: `f[2..]`), so the kind is
        // fields[0] — reading `summary` as the kind matches nothing and the queue comes back
        // silently empty, which is how the first version of `waiting` failed.
        let kind = e.fields.first().map(|s| s.trim()).unwrap_or("");
        let f = |i: usize| e.fields.get(i).map(|s| s.trim()).unwrap_or("");
        let at = e.ts_ms.max(0) as u64;
        match kind {
            // `bsc-issue --title T --suggested S --id I` — payload = <title> <body> <suggested> <id>.
            // A title-less row is DROPPED, matching the reducer, which returns null for one: an issue
            // with nothing to call it cannot be routed by a reader.
            "issue" if !f(1).is_empty() && !e.session.is_empty() => {
                let id = if f(4).is_empty() { synthetic_id(&e.session, at) } else { f(4).to_string() };
                open.retain(|p| !(p.kind == "issue" && p.id == id));
                open.push(PendingItem {
                    kind: "issue".into(),
                    id,
                    from: e.session.clone(),
                    target: String::new(),
                    title: f(1).to_string(),
                    detail: f(2).to_string(),
                    at,
                });
            }
            // `bsc-assign <target> --issue I --title T` — payload = <target> <body> <issueId> <title>.
            // Routing the issue is what closes it. An assign with NO `--issue` closes nothing, which
            // is the reducer's rule verbatim (`e.issueId ? filter : s.issues`) — the director routed
            // something, but did not say which captured row it was, so nothing can be paired.
            //
            // Project-scoped for the same reason `answer`/`assign` are in `waiting`: one project's
            // director must not erase another's queue row.
            "assign" if !f(3).is_empty() && same_coord_project(&e.session, f(1)) => {
                open.retain(|p| !(p.kind == "issue" && p.id == f(3)))
            }
            // `bsc-brief <target> --ref R` — payload = <target> <body> <ref>. Keyed by
            // `<session>@<at>` like the reducer; the `--ref` is a PLAN reference (a feature, an
            // issue number), not this row's identity, so it rides in `title` where a reader can see
            // it. A body-less brief is dropped, matching the reducer.
            "brief" if !f(1).is_empty() && !f(2).is_empty() && !e.session.is_empty() => {
                let id = synthetic_id(&e.session, at);
                open.retain(|p| !(p.kind == "brief" && p.id == id));
                open.push(PendingItem {
                    kind: "brief".into(),
                    id,
                    from: e.session.clone(),
                    target: f(1).to_string(),
                    title: f(3).to_string(),
                    detail: f(2).to_string(),
                    at,
                });
            }
            // `bsc-brief-done <briefId>` — the director has reconciled the plan against it. The one
            // event that closes a brief; see the module header for why it had to be explicit.
            //
            // Scoped by the brief's TARGET, not its emitter: a brief travels DOWN a tier, so its
            // `session` is the architect's pane (often another project's key, or none at all) while
            // the pane entitled to close it is the target it was sent to. Scoping on the emitter
            // would refuse the director's own close of a brief addressed to it.
            "brief-done" if !f(1).is_empty() => {
                open.retain(|p| {
                    !(p.kind == "brief" && p.id == f(1) && same_coord_project(&e.session, &p.target))
                })
            }
            _ => {}
        }
    }

    if let Some(me) = scope {
        // An issue names no target, so it is placed by its EMITTER; a brief by its target, which is
        // the pane meant to act on it. Using the emitter for a brief would hide every brief from the
        // director it was addressed to, since the architect sits outside the project.
        open.retain(|p| {
            let subject = if p.kind == "brief" { p.target.as_str() } else { p.from.as_str() };
            same_coord_project(me, subject)
        });
    }
    open.sort_by_key(|p| p.at);
    open
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch log dir — mirrors `waiting.rs`'s helper (this crate has no tempfile
    /// dev-dependency, and tests run as threads of one process so the pid alone is not unique).
    fn dir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir()
            .join(format!("bsc-pending-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn coord(d: &std::path::Path, lines: &[String]) {
        std::fs::write(d.join("coord.log"), lines.join("\n") + "\n").unwrap();
    }
    /// A coord line with an arbitrary column count — these kinds carry up to five payload columns,
    /// unlike the three-column emitters `waiting` reads.
    fn c(ts: &str, session: &str, cols: &[&str]) -> String {
        format!("{ts}\t{session}\t{}", cols.join("\t"))
    }
    fn issue(ts: &str, from: &str, title: &str, body: &str, id: &str) -> String {
        c(ts, from, &["issue", title, body, "", id])
    }
    fn assign(ts: &str, from: &str, target: &str, issue_id: &str) -> String {
        c(ts, from, &["assign", target, "do it", issue_id, ""])
    }
    fn brief(ts: &str, from: &str, target: &str, body: &str, r#ref: &str) -> String {
        c(ts, from, &["brief", target, body, r#ref])
    }

    /// THE ACCEPTANCE TEST. One log holding an issue, the assign that closes it, a brief, and another
    /// project's rows — only the open, in-project rows come back.
    #[test]
    fn a_replayed_log_yields_only_the_open_in_project_rows() {
        let d = dir();
        coord(
            &d,
            &[
                // alpha: an issue that gets routed — closed, must not appear.
                issue("2026-01-01T00:00:01Z", "alpha:issuer", "Routed already", "b", "77"),
                assign("2026-01-01T00:00:02Z", "alpha:director", "alpha:api", "77"),
                // alpha: an issue still awaiting routing.
                issue("2026-01-01T00:00:03Z", "alpha:issuer", "Still open", "retry uploads", "78"),
                // alpha: a brief nobody has reconciled yet.
                brief("2026-01-01T00:00:04Z", "arch:architect", "alpha:director", "scope grew", "#12"),
                // BETA's rows — a different project entirely. None may reach alpha's director.
                issue("2026-01-01T00:00:05Z", "beta:issuer", "Beta work", "b", "99"),
                brief("2026-01-01T00:00:06Z", "arch:architect", "beta:director", "beta scope", ""),
            ],
        );

        let rows = pending_in(&d, Some("alpha:director"));
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["78", "arch:architect@1767225604000"], "open + in-project only");
        assert_eq!(rows[0].kind, "issue");
        assert_eq!(rows[0].title, "Still open");
        assert_eq!(rows[1].kind, "brief");
        assert_eq!(rows[1].target, "alpha:director");
        assert_eq!(rows[1].title, "#12", "the --ref rides in title, where a reader sees it");
        // Oldest first — this is a queue.
        assert!(rows[0].at < rows[1].at);

        // Unscoped, the whole board is visible — what a human at a plain shell asks for.
        let all = pending_in(&d, None);
        assert_eq!(all.len(), 4, "alpha's two plus beta's two: {all:?}");
    }

    /// An issue is closed by the assign that ROUTES it, and only by one naming its id. This is the
    /// reducer's rule verbatim: an assign with no `--issue` routes work but pairs with nothing.
    #[test]
    fn only_an_assign_carrying_the_issue_id_closes_it() {
        let d = dir();
        coord(
            &d,
            &[
                issue("2026-01-01T00:00:01Z", "alpha:issuer", "T", "b", "77"),
                // Routed, but the director forgot --issue: the work moved, the row did not close.
                assign("2026-01-01T00:00:02Z", "alpha:director", "alpha:api", ""),
            ],
        );
        assert_eq!(pending_in(&d, Some("alpha:director")).len(), 1, "still open");

        // Now with the id.
        coord(
            &d,
            &[
                issue("2026-01-01T00:00:01Z", "alpha:issuer", "T", "b", "77"),
                assign("2026-01-01T00:00:02Z", "alpha:director", "alpha:api", "77"),
            ],
        );
        assert!(pending_in(&d, Some("alpha:director")).is_empty(), "routed and closed");
    }

    /// An issue emitted with no `--id` is still closable: it gets the reducer's `<session>@<at>`
    /// fallback, the queue prints it, and the director passes it back. Without this an un-`--id`'d
    /// issue — which is how most personas call `bsc-issue` — could never leave the queue.
    #[test]
    fn an_issue_with_no_id_gets_a_synthetic_one_that_still_closes_it() {
        let d = dir();
        coord(&d, &[issue("2026-01-01T00:00:01Z", "alpha:issuer", "No id", "b", "")]);
        let rows = pending_in(&d, Some("alpha:director"));
        assert_eq!(rows.len(), 1);
        let id = rows[0].id.clone();
        assert_eq!(id, "alpha:issuer@1767225601000", "<session>@<epoch-ms>, as the reducer derives it");

        coord(
            &d,
            &[
                issue("2026-01-01T00:00:01Z", "alpha:issuer", "No id", "b", ""),
                assign("2026-01-01T00:00:02Z", "alpha:director", "alpha:api", &id),
            ],
        );
        assert!(pending_in(&d, Some("alpha:director")).is_empty(), "the synthetic id closes it too");
    }

    /// A brief had NO closing event before this change, so it would sit in the queue forever. The
    /// explicit `bsc-brief-done` is what lets the queue empty.
    #[test]
    fn a_brief_stays_open_until_brief_done_names_it() {
        let d = dir();
        let b = brief("2026-01-01T00:00:01Z", "arch:architect", "alpha:director", "scope grew", "");
        coord(&d, std::slice::from_ref(&b));
        let rows = pending_in(&d, Some("alpha:director"));
        assert_eq!(rows.len(), 1);
        let id = rows[0].id.clone();

        // An unrelated assign does NOT close it — the rejected implicit design, pinned so it stays
        // rejected: a brief needing no assign would otherwise never close.
        coord(&d, &[b.clone(), assign("2026-01-01T00:00:02Z", "alpha:director", "alpha:api", "77")]);
        assert_eq!(pending_in(&d, Some("alpha:director")).len(), 1, "an assign is not a reconcile");

        coord(
            &d,
            &[b.clone(), c("2026-01-01T00:00:03Z", "alpha:director", &["brief-done", &id, ""])],
        );
        assert!(pending_in(&d, Some("alpha:director")).is_empty(), "reconciled and closed");
    }

    /// A brief is placed by its TARGET, not its emitter. The architect sits outside the project it
    /// briefs, so scoping a brief by who sent it would hide every brief from the director it was
    /// addressed to — the queue would look empty precisely when it was not.
    #[test]
    fn a_brief_is_scoped_by_its_target_not_its_sender() {
        let d = dir();
        coord(&d, &[brief("2026-01-01T00:00:01Z", "arch:architect", "alpha:director", "body", "")]);
        assert_eq!(pending_in(&d, Some("alpha:director")).len(), 1, "alpha's director sees it");
        assert!(pending_in(&d, Some("beta:director")).is_empty(), "beta's does not");
    }

    /// One project's director must not close another's brief. Request ids collide across projects
    /// for the same reason (`waiting.rs` documents it), and a brief id is `<sender>@<ts>` — two
    /// projects briefed by the same architect in the same millisecond would share one.
    #[test]
    fn a_foreign_director_cannot_close_a_brief() {
        let d = dir();
        let b = brief("2026-01-01T00:00:01Z", "arch:architect", "alpha:director", "body", "");
        coord(&d, std::slice::from_ref(&b));
        let id = pending_in(&d, Some("alpha:director"))[0].id.clone();

        coord(&d, &[b.clone(), c("2026-01-01T00:00:02Z", "beta:director", &["brief-done", &id, ""])]);
        assert_eq!(
            pending_in(&d, Some("alpha:director")).len(),
            1,
            "beta closing alpha's brief must not empty alpha's queue"
        );
    }

    /// Rows the reducer refuses are refused here too: an issue with no title and a brief with no
    /// body. Both would be unroutable — nothing to call the work, or nothing to reconcile against.
    #[test]
    fn unroutable_rows_are_dropped_the_way_the_reducer_drops_them() {
        let d = dir();
        coord(
            &d,
            &[
                issue("2026-01-01T00:00:01Z", "alpha:issuer", "", "body but no title", "1"),
                brief("2026-01-01T00:00:02Z", "arch:architect", "alpha:director", "", "#9"),
                issue("2026-01-01T00:00:03Z", "alpha:issuer", "Real", "b", "2"),
            ],
        );
        let rows = pending_in(&d, Some("alpha:director"));
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].title, "Real");
    }

    /// A replayed log must not multiply a row — the queue is re-derived from the whole file on every
    /// call, so the same line seen twice is one item, keyed by id.
    #[test]
    fn a_duplicated_line_does_not_double_the_row() {
        let d = dir();
        let i = issue("2026-01-01T00:00:01Z", "alpha:issuer", "T", "b", "77");
        let b = brief("2026-01-01T00:00:02Z", "arch:architect", "alpha:director", "body", "");
        coord(&d, &[i.clone(), i, b.clone(), b]);
        assert_eq!(pending_in(&d, Some("alpha:director")).len(), 2);
    }
}
