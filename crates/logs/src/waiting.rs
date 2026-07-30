//! Who is blocked on a human? (#4015) — the `bsc logs waiting` query.
//!
//! A session waiting on a person is the most urgent thing in a fleet and the easiest to miss. Until
//! now nothing could ENUMERATE them: not the user, not the director, not an agent. The nearest thing
//! was `bsc-fleet`, a shell/awk helper that needs `fleet.roster.tsv` in the project hub and predates
//! both the request lane (#4001) and the permission-prompt signal (#4005), so it cannot see either.
//!
//! ## Four ways to end up blocked, two logs
//!
//! | kind         | log          | opened by                  | closed by            |
//! |--------------|--------------|----------------------------|----------------------|
//! | `wait`       | coord.log    | `waiting` (`bsc-wait`)     | `woke`, `answer`     |
//! | `ask`        | coord.log    | `ask` (`bsc-ask`)          | `answer`             |
//! | `request`    | coord.log    | `request` (#4001)          | `request-resolved`   |
//! | `permission` | activity.log | `attn` (#4005)             | `run` / `idle`       |
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

/// Every session currently blocked on a human, oldest first.
pub fn waiting(dir: &Path) -> Vec<WaitingSession> {
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
            "answer" if !a.is_empty() => open.retain(|w| !(w.pane == a && (w.kind == "ask" || w.kind == "wait"))),
            // The coordinator woke a parked session.
            "woke" if !e.session.is_empty() => open.retain(|w| !(w.pane == e.session && w.kind == "wait")),
            // A worker->director change request (#4001). Keyed by ID, not session: two workers can
            // have distinct open requests, and the resolve names the id.
            "request" if !a.is_empty() => {
                open.retain(|w| !(w.kind == "request" && w.id == a));
                open.push(WaitingSession { pane: e.session.clone(), kind: "request".into(), detail: b.to_string(), at, id: a.to_string() });
            }
            "request-resolved" if !a.is_empty() => open.retain(|w| !(w.kind == "request" && w.id == a)),
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
}
