//! Who is blocked on a human? (#4015) — the `bsc logs waiting` query.
//!
//! A session waiting on a person is the most urgent thing in a fleet and the easiest to miss. Until
//! now nothing could ENUMERATE them: not the user, not the director, not an agent. The nearest thing
//! was `bsc-fleet`, a shell/awk helper that needs `fleet.roster.tsv` in the project hub and predates
//! both the request lane (#4001) and the permission-prompt signal (#4005), so it cannot see either.
//!
//! ## Four ways to end up blocked, two logs
//!
//! | kind         | log          | opened by                  | closed by                                |
//! |--------------|--------------|----------------------------|------------------------------------------|
//! | `wait`       | coord.log    | `waiting` (`bsc-wait`)     | `answer` · `assign` · `woke` · `maintain` |
//! | `ask`        | coord.log    | `ask` (`bsc-ask`)          | `answer` · `assign` · `woke` · `maintain` |
//! | `request`    | coord.log    | `request` (#4001)          | `request-resolved`                        |
//! | `permission` | activity.log | `attn` (#4005)             | `run` / `idle`                            |
//!
//! `wait` and `ask` share a closing set because they are two statements of ONE condition — the pane is
//! parked — and every event that unparks it ends both. That row used to read `woke, answer` / `answer`,
//! and the narrower reality behind it is what let the queue accumulate: `woke` cleared only a wait, and
//! `assign`/`maintain` cleared nothing, so an ask outlived every event that actually resolved it.
//!
//! The open/close pairing is re-derived from the WHOLE log on every call, exactly as the frontend
//! reducer does — so the answer is correct across an app restart and does not depend on having
//! observed the opening event live. The pairing logic cannot be shared with that reducer (it is
//! TypeScript), so each rule is tested here independently rather than assumed equivalent.
//!
//! Chronological, oldest-first: this is a QUEUE, and the longest-waiting session is the one to clear
//! first.

use crate::{read_stream, PaneActivity};
use std::collections::HashMap;
use std::path::Path;

/// One session blocked on a person.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingSession {
    /// The pane/session that is blocked.
    pub pane: String,
    /// `wait` · `ask` · `request` · `permission` — what kind of answer it needs.
    pub kind: String,
    /// The question / reason / request text. Empty for a permission prompt, which carries none.
    pub detail: String,
    /// Epoch-ms of the opening event.
    pub at: u64,
    /// The request id, for `kind = "request"` (what `bsc plan request resolve` takes). Else empty.
    pub id: String,
}

/// The two kinds that mean "this PANE is parked" — as opposed to `request` (keyed by row id, closed
/// by its own `request-resolved`) and `permission` (a latest-state read from the activity log).
///
/// Every event that unblocks a pane clears both, because a pane is parked for ONE reason at a time:
/// `bsc-ask` supersedes a plain `bsc-wait` when it arrives, so clearing only one kind leaves the
/// other stranded. Factored out because the four clearing arms must not drift apart — three of them
/// were added or corrected together after `woke` cleared only `wait` and the queue stopped emptying.
fn parked(w: &WaitingSession) -> bool {
    w.kind == "ask" || w.kind == "wait"
}

/// The project a pane id belongs to — everything before the FIRST colon of `<projectKey>:<stream>`
/// (`alpha:repo:triage` is alpha's). A pane id with no colon yields the whole string; see
/// [`same_coord_project`] for how an unplaceable id is then treated.
///
/// Mirrors `coordProjectOf` in `coordinationLog.ts`. The two cannot share an implementation (one is
/// TypeScript), so both are tested independently against the same rule.
pub fn coord_project_of(pane: &str) -> &str {
    match pane.find(':') {
        Some(i) => &pane[..i],
        None => pane,
    }
}

/// May an event emitted by `from` act on `target`? REFUSES ONLY ON PROOF OF CROSSING.
///
/// `coord.log` is one app-wide file, so an event names its actor and its subject with no project
/// field — the project is carried by the pane-id grammar and nowhere else. When BOTH ids are
/// project-qualified and the projects differ, the event is crossing and is refused. When either id
/// cannot be placed (a bare id: the retired positional ids, a hand-run emitter, `?` from an
/// unset `BSC_AUDIT_PANE`) it is ALLOWED, because refusing what we cannot place would break
/// single-project coordination that never used prefixed ids.
pub fn same_coord_project(from: &str, target: &str) -> bool {
    let a = coord_project_of(from);
    let b = coord_project_of(target);
    if a == from || b == target {
        return true; // one side is unplaceable — no proof of crossing
    }
    a == b
}

/// Every session currently blocked on a human, oldest first.
///
/// MUST agree with the frontend reducer (`coordinationLog.ts`), which computes the same queue for the
/// director pump and the Coordination inbox. When they disagree the director is the one that suffers:
/// its protocol tells it to run `bsc logs waiting` and drive the queue to empty, so a stale row here
/// is a question it is asked forever. The clearing set is `answer` · `assign` · `woke` · `maintain`.
pub fn waiting(dir: &Path) -> Vec<WaitingSession> {
    waiting_in(dir, None)
}

/// [`waiting`], narrowed to one project's rows.
///
/// `scope` is the CALLER's pane id (`$BSC_AUDIT_PANE`), not a project key — the caller knows who it
/// is, and deriving the project here keeps the pane-id grammar the single place that defines it.
/// `None` (or an unplaceable id) returns the whole queue, which is what the app and a human at a
/// plain shell want.
///
/// This is the display half of the same rule the clearing arms enforce: a director sweeping its queue
/// must not be handed another project's blocked workers, because the queue's whole contract is "these
/// are yours to clear" and it has no authority over any of them.
pub fn waiting_in(dir: &Path, scope: Option<&str>) -> Vec<WaitingSession> {
    let mut open: Vec<WaitingSession> = Vec::new();

    for e in read_stream(dir, "coord") {
        // The coord stream's `fields` are the raw columns from the KIND onward (`lib.rs`: `f[2..]`),
        // and `summary` is kind+payload joined with spaces for display. So the kind is fields[0], NOT
        // `summary` — reading `summary` as the kind matches nothing and the queue silently comes back
        // empty, which is exactly how the first version of this failed.
        let kind = e.fields.first().map(|s| s.trim()).unwrap_or("");
        let a = e.fields.get(1).map(|s| s.trim()).unwrap_or("");
        let b = e.fields.get(2).map(|s| s.trim()).unwrap_or("");
        let at = e.ts_ms.max(0) as u64;
        match kind {
            // `bsc-wait` — parked for the user.
            "waiting" if !e.session.is_empty() => {
                open.retain(|w| !(w.pane == e.session && w.kind == "wait"));
                open.push(WaitingSession { pane: e.session.clone(), kind: "wait".into(), detail: a.to_string(), at, id: String::new() });
            }
            // `bsc-ask` — a question for the director. It SUPERSEDES a plain wait for the same
            // session (mirroring the frontend reducer): the session is parked for one reason, and the
            // question is the more specific, more actionable statement of it.
            "ask" if !e.session.is_empty() => {
                open.retain(|w| !(w.pane == e.session && (w.kind == "ask" || w.kind == "wait")));
                open.push(WaitingSession { pane: e.session.clone(), kind: "ask".into(), detail: a.to_string(), at, id: String::new() });
            }
            // `bsc-answer <target>` — the director's universal unblock: it resumes the target whatever
            // it was parked on, so it clears BOTH an ask and a wait, not just the ask.
            //
            // SCOPED to the emitter's project (#coord-log-is-app-wide-answers-cross-projects). Without
            // the guard, another project's director answering `alpha:api` erases alpha's row from
            // alpha's OWN queue — so alpha's real director runs `bsc logs waiting`, sees nothing
            // outstanding, and never replies. That is the quiet half of the same bug: not a wrong
            // answer delivered, but a real question made invisible.
            "answer" if !a.is_empty() && same_coord_project(&e.session, a) => {
                open.retain(|w| !(w.pane == a && parked(w)))
            }
            // `bsc-assign <target>` — dispatching work to a worker ANSWERS it. The frontend reducer has
            // always cleared `asking` for the assign target alongside `answer`; this had no arm at all,
            // so an assigned worker stayed in the queue as though still asking. Same project guard.
            "assign" if !a.is_empty() && same_coord_project(&e.session, a) => {
                open.retain(|w| !(w.pane == a && parked(w)))
            }
            // The coordinator woke a parked session. This cleared ONLY a `wait`, which is the bug: the
            // frontend reducer clears `asking` on `woke` too, so a woken session's ASK was immortal
            // here and the director was re-handed it every sweep.
            "woke" if !e.session.is_empty() => open.retain(|w| !(w.pane == e.session && parked(w))),
            // `bsc-maintain` — the worker declared everything it owns is done and parked alive+ready.
            // That is the OPPOSITE of blocked on a human, and it had no arm either. It matters most:
            // `maintain` is the most common event in a real log (a finished worker is told to park
            // rather than end), so every finished worker sat in the queue forever.
            "maintain" if !e.session.is_empty() => open.retain(|w| !(w.pane == e.session && parked(w))),
            // A worker->director change request (#4001). Keyed by ID, not session: two workers can
            // have distinct open requests, and the resolve names the id.
            "request" if !a.is_empty() => {
                open.retain(|w| !(w.kind == "request" && w.id == a));
                open.push(WaitingSession { pane: e.session.clone(), kind: "request".into(), detail: b.to_string(), at, id: a.to_string() });
            }
            // Scoped too, and here the guard also settles a COLLISION: request ids are per-project
            // sequence numbers, so `7` exists in every project that has had seven requests. Unscoped,
            // one director resolving its own #7 closed everybody else's.
            "request-resolved" if !a.is_empty() => {
                open.retain(|w| !(w.kind == "request" && w.id == a && same_coord_project(&e.session, &w.pane)))
            }
            _ => {}
        }
    }

    // Permission prompts come from the OTHER log, and are a per-pane latest-state read rather than a
    // paired open/close — `pane_activity` has already collapsed each pane to its newest row, so a pane
    // still sitting on `attn` is still stopped.
    for row in crate::pane_activity(dir) {
        let PaneActivity { pane, state, at } = row;
        if state == "attn" {
            open.push(WaitingSession { pane, kind: "permission".into(), detail: String::new(), at, id: String::new() });
        }
    }

    if let Some(me) = scope {
        open.retain(|w| same_coord_project(me, &w.pane));
    }
    open.sort_by_key(|w| w.at);
    open
}

/// Group the queue by pane, for a compact human rendering.
pub fn waiting_by_pane(rows: &[WaitingSession]) -> Vec<(String, Vec<&WaitingSession>)> {
    let mut order: Vec<String> = Vec::new();
    let mut by: HashMap<String, Vec<&WaitingSession>> = HashMap::new();
    for w in rows {
        if !by.contains_key(&w.pane) {
            order.push(w.pane.clone());
        }
        by.entry(w.pane.clone()).or_default().push(w);
    }
    order.into_iter().map(|p| { let v = by.remove(&p).unwrap_or_default(); (p, v) }).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch log dir — mirrors the `tmp()` helper in `lib.rs` (this crate has no tempfile
    /// dev-dependency, and tests run as threads of one process so the pid alone is not unique).
    fn dir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir()
            .join(format!("bsc-waiting-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn coord(d: &std::path::Path, lines: &[&str]) {
        std::fs::write(d.join("coord.log"), lines.join("
") + "
").unwrap();
    }
    fn activity(d: &std::path::Path, lines: &[&str]) {
        std::fs::write(d.join("activity.log"), lines.join("
") + "
").unwrap();
    }
    /// A coord line: `ts \t session \t kind \t a \t b`.
    fn c(ts: &str, session: &str, kind: &str, a: &str, b: &str) -> String {
        format!("{ts}\t{session}\t{kind}\t{a}\t{b}")
    }

    #[test]
    fn a_parked_wait_is_listed_and_a_wake_clears_it() {
        let d = dir();
        coord(&d, &[&c("2026-07-30T10:00:00Z", "auth", "waiting", "needs a decision", "")]);
        let r = waiting(&d);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "wait");
        assert_eq!(r[0].detail, "needs a decision");

        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "waiting", "needs a decision", ""),
            &c("2026-07-30T10:01:00Z", "auth", "woke", "", ""),
        ]);
        assert!(waiting(&d).is_empty(), "a wake clears the park");
    }

    #[test]
    fn an_unanswered_ask_is_listed_and_the_answer_clears_it() {
        let d = dir();
        coord(&d, &[&c("2026-07-30T10:00:00Z", "auth", "ask", "which pagination?", "")]);
        assert_eq!(waiting(&d)[0].kind, "ask");

        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "ask", "which pagination?", ""),
            &c("2026-07-30T10:01:00Z", "director", "answer", "auth", "use cursors"),
        ]);
        assert!(waiting(&d).is_empty(), "the answer clears the ask");
    }

    #[test]
    fn an_ask_supersedes_a_plain_wait_for_the_same_session() {
        // The session is parked for ONE reason; the question is the more specific statement of it.
        // Listing both would double-count a single blocked worker.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "waiting", "no instructions", ""),
            &c("2026-07-30T10:01:00Z", "auth", "ask", "which pagination?", ""),
        ]);
        let r = waiting(&d);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "ask");
    }

    #[test]
    fn an_answer_also_clears_a_plain_wait() {
        // `bsc-answer` is the director's universal unblock — it resumes the target whatever it was
        // parked on. Clearing only asks would strand every worker parked by `bsc-wait`.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "waiting", "no instructions", ""),
            &c("2026-07-30T10:01:00Z", "director", "answer", "auth", "carry on"),
        ]);
        assert!(waiting(&d).is_empty());
    }

    #[test]
    fn an_open_request_is_listed_by_id_and_resolving_clears_it() {
        let d = dir();
        coord(&d, &[&c("2026-07-30T10:00:00Z", "auth", "request", "7", "no develop branch")]);
        let r = waiting(&d);
        assert_eq!(r[0].kind, "request");
        assert_eq!(r[0].id, "7", "the id is what `bsc plan request resolve` takes");
        assert_eq!(r[0].detail, "no develop branch");

        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "request", "7", "no develop branch"),
            &c("2026-07-30T10:01:00Z", "director", "request-resolved", "7", "created it"),
        ]);
        assert!(waiting(&d).is_empty());
    }

    #[test]
    fn requests_are_keyed_by_id_not_session() {
        // One worker can have several distinct open requests, and each resolve names ONE id.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "request", "1", "first"),
            &c("2026-07-30T10:01:00Z", "auth", "request", "2", "second"),
            &c("2026-07-30T10:02:00Z", "director", "request-resolved", "1", "done"),
        ]);
        let r = waiting(&d);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].id, "2");
    }

    #[test]
    fn a_permission_prompt_is_listed_from_the_activity_log() {
        // The #4005 signal, and the only source that is a latest-state read rather than a pair.
        let d = dir();
        activity(&d, &["2026-07-30T10:00:00Z\tauth\tattn"]);
        let r = waiting(&d);
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].kind, "permission");
        assert_eq!(r[0].pane, "auth");
    }

    #[test]
    fn a_turn_boundary_clears_a_permission_prompt() {
        // `Notification` only ever fires; the next `run`/`idle` row supersedes it. Without this a pane
        // would stay in the queue forever after a single prompt.
        let d = dir();
        activity(&d, &["2026-07-30T10:00:00Z\tauth\tattn", "2026-07-30T10:01:00Z\tauth\trun"]);
        assert!(waiting(&d).is_empty());
    }

    #[test]
    fn a_close_with_no_matching_open_is_harmless() {
        // A rotated log can drop the opening event. The close must not throw or resurrect anything.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "director", "answer", "ghost", "hi"),
            &c("2026-07-30T10:00:01Z", "director", "request-resolved", "99", "x"),
            &c("2026-07-30T10:00:02Z", "ghost", "woke", "", ""),
        ]);
        assert!(waiting(&d).is_empty());
    }

    #[test]
    fn the_queue_is_oldest_first_across_both_logs() {
        // It is a QUEUE — the longest-waiting session is the one to clear first, and the ordering has
        // to hold across the two different files it is assembled from.
        let d = dir();
        coord(&d, &[&c("2026-07-30T10:05:00Z", "later", "ask", "second", "")]);
        activity(&d, &["2026-07-30T10:00:00Z\tearlier\tattn"]);
        let r = waiting(&d);
        assert_eq!(r.iter().map(|w| w.pane.as_str()).collect::<Vec<_>>(), vec!["earlier", "later"]);
    }

    #[test]
    fn nothing_waiting_is_an_empty_list_not_an_error() {
        let d = dir();
        assert!(waiting(&d).is_empty(), "missing logs read as an empty queue");
    }

    #[test]
    fn grouping_preserves_queue_order_and_collects_a_panes_asks() {
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "a", "request", "1", "one"),
            &c("2026-07-30T10:01:00Z", "b", "ask", "q", ""),
            &c("2026-07-30T10:02:00Z", "a", "request", "2", "two"),
        ]);
        let rows = waiting(&d);
        let g = waiting_by_pane(&rows);
        assert_eq!(g.iter().map(|(p, _)| p.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(g[0].1.len(), 2, "both of a's requests group together");
    }

    /// The regression this item exists for: a queue that could not empty (#logs-waiting-honours-
    /// every-clearing-event). Each of these three events clears an ask in the FRONTEND reducer, and
    /// each was either wrong or missing here — so the director's own queue tool re-handed it the same
    /// resolved questions on every sweep, for two weeks.
    #[test]
    fn woke_clears_an_ask_not_only_a_wait() {
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "ask", "which base branch?", ""),
            &c("2026-07-30T10:05:00Z", "p:api", "woke", "", ""),
        ]);
        assert!(waiting(&d).is_empty(), "a woken session is not still asking: {:?}", waiting(&d));
    }

    #[test]
    fn maintain_clears_the_queue_for_a_finished_worker() {
        // The highest-volume case by far: a finished worker is told to park in MAINTENANCE rather
        // than end, so it emits `maintain` repeatedly. Declaring everything done is the opposite of
        // being blocked on a human.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "ask", "no issues assigned yet", ""),
            &c("2026-07-30T11:00:00Z", "p:api", "maintain", "owned issues complete — standing by", ""),
        ]);
        assert!(waiting(&d).is_empty(), "a maintaining worker is not blocked: {:?}", waiting(&d));
    }

    #[test]
    fn assign_clears_the_target_the_same_way_answer_does() {
        // Dispatching work to a worker ANSWERS its question — the reducer has always treated it so.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "ask", "what should I pick up?", ""),
            &c("2026-07-30T10:30:00Z", "p:director", "assign", "p:api", "add a retry to the upload path"),
        ]);
        assert!(waiting(&d).is_empty(), "an assigned worker is not still asking: {:?}", waiting(&d));
    }

    #[test]
    fn a_clearing_event_does_not_close_someone_elses_row() {
        // The clearing arms key on the pane, so one worker being unblocked must not empty another's.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "ask", "mine", ""),
            &c("2026-07-30T10:01:00Z", "p:web", "ask", "also mine", ""),
            &c("2026-07-30T10:05:00Z", "p:api", "maintain", "done", ""),
        ]);
        let rows = waiting(&d);
        assert_eq!(rows.len(), 1, "only p:api clears: {rows:?}");
        assert_eq!(rows[0].pane, "p:web");
    }

    #[test]
    fn a_later_ask_reopens_after_a_clear() {
        // Clearing is not permanent — a worker that asks again after being woken is blocked again.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "ask", "first", ""),
            &c("2026-07-30T10:05:00Z", "p:api", "woke", "", ""),
            &c("2026-07-30T10:10:00Z", "p:api", "ask", "second", ""),
        ]);
        let rows = waiting(&d);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].detail, "second");
    }

    // -- Cross-project scoping (#coord-log-is-app-wide-answers-cross-projects) -------------------
    //
    // `coord.log` is ONE app-wide file and this query replays the whole tail, so before these guards
    // any project's director could reach into any other's queue. The frontend reducer
    // (`coordinationLog.ts`) enforces the same rule on delivery; these tests state it independently
    // because the two implementations cannot share code and MUST NOT drift.

    #[test]
    fn the_project_is_read_off_the_pane_id() {
        assert_eq!(coord_project_of("alpha:api"), "alpha");
        assert_eq!(coord_project_of("alpha:repo:triage"), "alpha", "only the FIRST colon delimits");
        assert_eq!(coord_project_of("bare"), "bare");
    }

    #[test]
    fn an_unplaceable_id_is_allowed_refusal_needs_proof_of_crossing() {
        // Bare ids (the retired positional ids, a hand-run emitter, `?` from an unset
        // BSC_AUDIT_PANE) cannot be placed in a project. Refusing them would break single-project
        // coordination that never used prefixed ids — which this item requires to be UNCHANGED.
        assert!(same_coord_project("director", "auth"));
        assert!(same_coord_project("alpha:director", "auth"));
        assert!(same_coord_project("director", "alpha:api"));
        assert!(same_coord_project("alpha:director", "alpha:api"));
        assert!(!same_coord_project("beta:director", "alpha:api"), "both placed, and they differ");
    }

    #[test]
    fn another_projects_answer_does_not_clear_the_ask() {
        // THE REPORTED INCIDENT, in its quiet form. If beta's answer clears alpha's row here, then
        // alpha's OWN director runs `bsc logs waiting`, sees an empty queue, and never replies — the
        // worker waits forever on a question nobody can see.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "alpha:api", "ask", "which pagination?", ""),
            &c("2026-07-30T10:01:00Z", "beta:director", "answer", "alpha:api", "proceed, do not ask the user"),
        ]);
        let rows = waiting(&d);
        assert_eq!(rows.len(), 1, "alpha is still asking: {rows:?}");
        assert_eq!(rows[0].pane, "alpha:api");

        // ...and its real director still clears it.
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "alpha:api", "ask", "which pagination?", ""),
            &c("2026-07-30T10:01:00Z", "beta:director", "answer", "alpha:api", "proceed, do not ask the user"),
            &c("2026-07-30T10:02:00Z", "alpha:director", "answer", "alpha:api", "use cursors"),
        ]);
        assert!(waiting(&d).is_empty(), "the OWNING director clears it");
    }

    #[test]
    fn another_projects_assign_does_not_clear_the_ask() {
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "alpha:api", "ask", "what should I pick up?", ""),
            &c("2026-07-30T10:01:00Z", "beta:director", "assign", "alpha:api", "refactor the adapter"),
        ]);
        assert_eq!(waiting(&d).len(), 1, "an assign from another project is not an answer");
    }

    #[test]
    fn a_request_id_collision_across_projects_resolves_only_its_own() {
        // Request ids are PER-PROJECT sequence numbers, so `7` exists in every project that has had
        // seven requests. Unscoped, alpha resolving its #7 closed beta's #7 too.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "alpha:api", "request", "7", "alpha's request"),
            &c("2026-07-30T10:00:01Z", "beta:api", "request", "7", "beta's request"),
            &c("2026-07-30T10:01:00Z", "alpha:director", "request-resolved", "7", "done"),
        ]);
        let rows = waiting(&d);
        assert_eq!(rows.len(), 1, "only alpha's #7 closes: {rows:?}");
        assert_eq!(rows[0].detail, "beta's request");
    }

    #[test]
    fn the_queue_is_scoped_to_the_callers_project() {
        // Criterion 4: the queue's contract is "these are yours to clear". A director handed another
        // project's blocked workers has no authority over any of them.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "alpha:api", "ask", "mine", ""),
            &c("2026-07-30T10:01:00Z", "beta:web", "ask", "not mine", ""),
        ]);
        let mine = waiting_in(&d, Some("alpha:director"));
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].pane, "alpha:api");

        // No scope (a plain shell, or --all) still sees everything.
        assert_eq!(waiting_in(&d, None).len(), 2);
    }

    #[test]
    fn scoping_leaves_a_single_project_log_untouched() {
        // The compatibility half of criterion 6: a fleet whose panes were never project-prefixed must
        // behave exactly as before, scope or no scope.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "auth", "ask", "which base branch?", ""),
            &c("2026-07-30T10:01:00Z", "web", "waiting", "needs a decision", ""),
        ]);
        assert_eq!(waiting_in(&d, Some("director")).len(), 2, "bare ids all coordinate together");
        assert_eq!(waiting_in(&d, None).len(), 2);
    }

    #[test]
    fn a_request_is_not_cleared_by_a_pane_unblock() {
        // A `request` is keyed by ROW ID and closed only by its own `request-resolved` — waking or
        // maintaining the pane must not silently close a tracked contract.
        let d = dir();
        coord(&d, &[
            &c("2026-07-30T10:00:00Z", "p:api", "request", "7", "no develop branch to target"),
            &c("2026-07-30T10:05:00Z", "p:api", "maintain", "done", ""),
        ]);
        let rows = waiting(&d);
        assert_eq!(rows.len(), 1, "the tracked request survives: {rows:?}");
        assert_eq!(rows[0].kind, "request");
    }
}
