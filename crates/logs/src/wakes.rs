//! The wake prompts — what a woken agent reads.
//!
//! # The backend wakes the session; the sentence explaining it was written elsewhere
//!
//! `src-tauri/src/fleet/wake.rs` performs the wake and already carries one such message of its own,
//! and `crates/bsc-fleet/src/cli.rs` documents the contract outright: *"without `--prompt` the app
//! supplies its standard change-request wake, so a director does not have to reproduce"* it. That
//! standard wake lived in the renderer.
//!
//! It is worth knowing what the gap cost. A director once sent `bsc fleet wake <pane> --prompt "<the
//! original task>"` six times over, because the protocol taught `--prompt` as the default and the
//! fallback it should have used sat on the other side of the boundary.
//!
//! # Four prompts, each saying something different on purpose
//!
//! * A woken WAITER learns which deps landed AND HOW each was satisfied, then is pointed at its
//!   checkpoint — so a FRESH session resumes without re-deriving context. The SOURCE is the load-bearing
//!   half: "landed" and "merged" are different facts, and a session that only knows "it is done" cannot
//!   tell whether to re-read anything.
//! * A session that paused for the USER is told the user resumed it. There are no deps to report, and
//!   an empty reason falls back to a shorter sentence rather than emitting a dangling colon.
//! * An ANSWERED session gets the director's answer and, explicitly, "Do not ask the user" — without
//!   which a parked session parks again the moment it resumes.
//! * An ASSIGNED worker is told this is NEW work and to run its normal loop, and is told to re-read its
//!   checkpoint BEFORE beginning. The order is the instruction.
//!
//! # The punctuation is not incidental
//!
//! The waiter prompt uses `--` where the other three use an em dash. That is how the strings ship, an
//! agent may be matching on them, and a port that "tidies" them is a silent behaviour change in text
//! another program reads.

use crate::coord::{ref_key, CoordRef, CoordState, LatchStatus, Waiter, WaitingSession};
use crate::deadlock::{detect_deadlocks, ProducerOf};

/// A director's answer to a parked session's question.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsweredWake {
    pub session: String,
    pub answer: String,
    #[serde(default)]
    pub checkpoint: Option<String>,
}

/// New work the director routed to a worker.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedWork {
    pub session: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub checkpoint: Option<String>,
}

/// One planned wake: the session, its deps, and the prompt to inject.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeAction {
    pub session: String,
    pub deps: Vec<CoordRef>,
    pub prompt: String,
}

/// One dep's status in the inbox view.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DepView {
    #[serde(rename = "ref")]
    pub reference: String,
    pub status: String,
}

/// One still-parked waiter, as the inbox renders it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockedView {
    pub session: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub deps: Vec<DepView>,
    /// A dep has FAILED — the chain is stalled and someone must intervene.
    pub stalled: bool,
    /// This waiter sits in a wait-for cycle.
    pub deadlocked: bool,
}

/// A ref's latch status as a short label.
fn status_of(s: &CoordState, r: &CoordRef) -> &'static str {
    match s.latches.get(&ref_key(r)) {
        Some(LatchStatus::Satisfied { .. }) => "satisfied",
        Some(LatchStatus::Failed { .. }) => "failed",
        None => "pending",
    }
}

/// The checkpoint line the waiter and user-paused prompts share.
fn resume_line(checkpoint: &str, dash: &str) -> String {
    format!("Resume from your checkpoint: {checkpoint} {dash} read it first, then continue from where you left off.")
}

/// The wake a director gets when it supplies no `--prompt` and the session is neither a parked waiter
/// nor paused for the user.
///
/// A CHANGE-REQUEST framing rather than a bare "continue": a woken worker is being brought back
/// because something needs doing, and an empty prompt would drop it at a prompt with no task.
///
/// It lives HERE, beside the four it is the fallback for, rather than in the renderer that used to own
/// it. `wakePrompts.fixtures.json` binds this string to its TypeScript twin, so the two cannot drift
/// into two different sentences for the same event.
pub const DEFAULT_WAKE_PROMPT: &str =
    "You have been woken by the director because there is a change request for your stream. \
Re-read your assignment, check `bsc plan issue list` for what is open on it, and continue.";

/// The standard wake for `session`, composed from the coordination state.
///
/// THIS IS THE FLIP. `bsc fleet wake` has always documented that "without `--prompt` the app supplies
/// its standard change-request wake", and that sentence was composed in the renderer — so a director
/// that did not know about it re-sent the original task as a `--prompt` six times over. Composing it
/// in the process that performs the wake means it cannot be skipped by a caller unaware of it.
///
/// The precedence is by SPECIFICITY, and each rung says something the next cannot:
///
/// 1. a parked WAITER whose deps are the reason it stopped — it learns which landed and HOW, which is
///    the only rung that can carry that;
/// 2. a session paused for the USER — there are no deps to report, and it is told it was resumed;
/// 3. anything else — the generic change request, because a woken session with no coordination record
///    is being brought back for work the log cannot name.
///
/// An explicit `--prompt` never reaches here: the caller prefers it, and this is only consulted when
/// none was given.
pub fn compose_wake_prompt(session: &str, s: &CoordState) -> String {
    if let Some(w) = s.waiters.iter().find(|w| w.session == session) {
        return wake_prompt_for(w, s);
    }
    if let Some(w) = s.waiting.iter().find(|w| w.session == session) {
        return waiting_wake_prompt(w);
    }
    DEFAULT_WAKE_PROMPT.to_string()
}

/// The prompt for a woken waiter — names the landed deps and HOW each was satisfied.
pub fn wake_prompt_for(w: &Waiter, s: &CoordState) -> String {
    let landed = w
        .deps
        .iter()
        .map(|d| {
            // A dep with no latch is reported as "ready" rather than omitted: a fresh session should
            // see every dep it was waiting on, including one that was never latched.
            let via = match s.latches.get(&ref_key(d)) {
                Some(LatchStatus::Satisfied { source, .. }) => {
                    serde_json::to_value(source).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_else(|| "ready".into())
                }
                _ => "ready".to_string(),
            };
            format!("{} ({via})", ref_key(d))
        })
        .collect::<Vec<_>>()
        .join(", ");

    let plural = if w.deps.len() == 1 { "dependency has" } else { "dependencies have" };
    let mut lines = vec![
        format!("Your blocking {plural} landed -- resume now."),
        format!("Satisfied: {landed}."),
    ];
    if let Some(cp) = w.checkpoint.as_deref() {
        lines.push(resume_line(cp, "--"));
    }
    lines.join("\n")
}

/// The prompt for a session that paused for the USER.
pub fn waiting_wake_prompt(w: &WaitingSession) -> String {
    let reason = w.reason.trim();
    let mut lines = vec![if reason.is_empty() {
        // No dangling colon when there is nothing to name.
        "You paused for the user — you have been resumed; proceed.".to_string()
    } else {
        format!("You paused for confirmation: {reason} — the user has resumed you; proceed.")
    }];
    if let Some(cp) = w.checkpoint.as_deref() {
        lines.push(resume_line(cp, "—"));
    }
    lines.join("\n")
}

/// The prompt for a session the director answered.
pub fn answer_wake_prompt(a: &AnsweredWake) -> String {
    let answer = a.answer.trim();
    let answer = if answer.is_empty() { "(see the director's notes)" } else { answer };
    let mut lines = vec![format!(
        "The director responded: {answer} — proceed on that basis; you are no longer parked. Do not ask the user."
    )];
    if let Some(cp) = a.checkpoint.as_deref() {
        lines.push(format!("Resume from your checkpoint: {cp} — read it first, then continue."));
    }
    lines.join("\n")
}

/// The prompt for a worker the director assigned new work.
pub fn assign_wake_prompt(a: &AssignedWork) -> String {
    let titled = if a.title.is_empty() { String::new() } else { format!(": {}", a.title) };
    let mut lines = vec![format!(
        "The director assigned you new work{titled}. Start on it now and carry it through your normal \
         loop (implement → gate → integrate). Do not ask the user."
    )];
    let body = a.body.trim();
    if !body.is_empty() {
        lines.push(String::new());
        lines.push(body.to_string());
    }
    if let Some(cp) = a.checkpoint.as_deref() {
        lines.push(String::new());
        // BEFORE beginning — the order is the instruction.
        lines.push(format!("First re-read your checkpoint: {cp}, then begin the new work."));
    }
    lines.join("\n")
}

/// Map newly-woken waiters to their wake actions.
pub fn plan_wakes(woken: &[Waiter], s: &CoordState) -> Vec<WakeAction> {
    woken
        .iter()
        .map(|w| WakeAction { session: w.session.clone(), deps: w.deps.clone(), prompt: wake_prompt_for(w, s) })
        .collect()
}

/// The inbox view: every still-parked waiter, each dep's status, whether the chain is stalled, and
/// whether it sits in a wait-for cycle.
pub fn coordination_summary(s: &CoordState, producer_of: ProducerOf) -> Vec<BlockedView> {
    let deadlocked: std::collections::HashSet<String> =
        detect_deadlocks(s, producer_of).into_iter().flat_map(|d| d.cycle).collect();
    s.waiters
        .iter()
        .map(|w| {
            let deps: Vec<DepView> = w
                .deps
                .iter()
                .map(|d| DepView { reference: ref_key(d), status: status_of(s, d).to_string() })
                .collect();
            BlockedView {
                session: w.session.clone(),
                checkpoint: w.checkpoint.clone(),
                stalled: deps.iter().any(|d| d.status == "failed"),
                deadlocked: deadlocked.contains(&w.session),
                deps,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deadlock::default_producer_of;

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("wakePrompts.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one wakePrompts.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// The STANDARD wake must be the SAME SENTENCE on both sides.
    ///
    /// This is the rung the renderer used to own, and the whole item exists because a director that
    /// did not know about it re-sent the original task six times over. Two subtly different fallbacks
    /// for one event would be that failure wearing a new hat, so the fixture binds the string itself
    /// rather than a description of it.
    #[test]
    fn the_standard_wake_matches_the_typescript_verbatim() {
        let doc = fixture();
        let want = doc["defaultWakePrompt"].as_str().expect("fixture carries the default wake");
        assert_eq!(DEFAULT_WAKE_PROMPT, want);
    }

    /// The chooser picks by SPECIFICITY, and each rung carries something the next cannot.
    #[test]
    fn compose_prefers_the_waiter_then_the_paused_then_the_generic() {
        let mut s = CoordState::default();
        // 3 — no coordination record at all ⇒ the generic change request.
        assert_eq!(compose_wake_prompt("nobody", &s), DEFAULT_WAKE_PROMPT);

        // 2 — paused for the USER: told it was resumed, and no deps are claimed.
        s.waiting.push(WaitingSession {
            session: "api".into(),
            reason: "confirm the migration".into(),
            checkpoint: None,
            at: 1,
        });
        let paused = compose_wake_prompt("api", &s);
        assert!(paused.contains("the user has resumed you"), "{paused}");
        assert_ne!(paused, DEFAULT_WAKE_PROMPT);

        // 1 — a parked WAITER wins over the paused rung: it is the only one that can name the deps.
        s.waiters.push(Waiter {
            session: "api".into(),
            deps: vec![CoordRef::Issue { number: 7 }],
            checkpoint: Some("cp-1".into()),
            registered_at: 0,
        });
        let woken = compose_wake_prompt("api", &s);
        assert!(woken.contains("#7"), "names the dep it was waiting on: {woken}");
        assert!(woken.contains("resume now"), "{woken}");
        assert_ne!(woken, paused, "the waiter rung must outrank the paused one");
    }

    /// A waiter is told HOW each dep was satisfied — the half a fresh session needs to trust it.
    #[test]
    fn the_composed_waiter_wake_carries_the_source() {
        let mut s = CoordState::default();
        s.latches.insert(
            ref_key(&CoordRef::Issue { number: 7 }),
            LatchStatus::Satisfied { source: crate::coord::SatisfySource::Merged, at: 1 },
        );
        s.waiters.push(Waiter {
            session: "api".into(),
            deps: vec![CoordRef::Issue { number: 7 }],
            checkpoint: None,
            registered_at: 0,
        });
        let got = compose_wake_prompt("api", &s);
        assert!(got.contains("merged"), "landed and merged are different facts: {got}");
    }

    fn state_with(latches: &serde_json::Value, waiters: &serde_json::Value) -> CoordState {
        let mut s = CoordState {
            latches: serde_json::from_value(latches.clone()).expect("latches"),
            ..Default::default()
        };
        if let Some(arr) = waiters.as_array() {
            for w in arr {
                s.waiters.push(serde_json::from_value(w.clone()).expect("waiter"));
            }
        }
        s
    }

    /// All four prompts, byte for byte. Reports every mismatch at once — a wrong prompt is wrong for a
    /// whole CLASS of wake, and the exact TEXT is the contract: an agent may be matching on it.
    #[test]
    fn the_wake_prompts_match_the_typescript_case_for_case() {
        let doc = fixture();
        let mut mismatches = Vec::new();
        let null = serde_json::Value::Null;

        let waiters = doc["waiterPrompts"].as_array().expect("waiterPrompts");
        assert!(waiters.len() >= 6, "only {} waiter cases", waiters.len());
        for c in waiters {
            let label = c["label"].as_str().unwrap();
            let s = state_with(&c["latches"], &null);
            let w: Waiter = serde_json::from_value(c["waiter"].clone())
                .unwrap_or_else(|e| panic!("{label}: waiter did not deserialize: {e}"));
            let got = wake_prompt_for(&w, &s);
            let want = c["prompt"].as_str().unwrap();
            if got != want {
                mismatches.push(format!("  waiter/{label}\n    ts   {want:?}\n    rust {got:?}"));
            }
        }

        for (key, f) in [
            ("waitingPrompts", 0usize),
            ("answerPrompts", 1),
            ("assignPrompts", 2),
        ] {
            let cases = doc[key].as_array().unwrap_or_else(|| panic!("{key}"));
            assert!(cases.len() >= 4, "only {} {key}", cases.len());
            for c in cases {
                let label = c["label"].as_str().unwrap();
                let want = c["prompt"].as_str().unwrap();
                let got = match f {
                    0 => waiting_wake_prompt(&serde_json::from_value(c["waiting"].clone()).unwrap()),
                    1 => answer_wake_prompt(&serde_json::from_value(c["answered"].clone()).unwrap()),
                    _ => assign_wake_prompt(&serde_json::from_value(c["assigned"].clone()).unwrap()),
                };
                if got != want {
                    mismatches.push(format!("  {key}/{label}\n    ts   {want:?}\n    rust {got:?}"));
                }
            }
        }

        // planWakes and the summary ride on the same state.
        let summaries = doc["summaries"].as_array().expect("summaries");
        assert!(summaries.len() >= 4);
        let (mut stalled_n, mut deadlocked_n) = (0usize, 0usize);
        for c in summaries {
            let label = c["label"].as_str().unwrap();
            let s = state_with(&c["latches"], &c["waiters"]);
            let got = coordination_summary(&s, &default_producer_of);
            let want: serde_json::Value = c["view"].clone();
            if want.as_array().unwrap().iter().any(|v| v["stalled"] == true) {
                stalled_n += 1;
            }
            if want.as_array().unwrap().iter().any(|v| v["deadlocked"] == true) {
                deadlocked_n += 1;
            }
            if serde_json::to_value(&got).unwrap() != want {
                mismatches.push(format!("  summary/{label}\n    ts   {want}\n    rust {}", serde_json::to_value(&got).unwrap()));
            }
        }
        assert!(stalled_n >= 1, "no STALLED case — a failed dep must be exercised");
        assert!(deadlocked_n >= 1, "no DEADLOCKED case — the detect_deadlocks join must be exercised");

        assert!(
            mismatches.is_empty(),
            "the Rust prompts disagree with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    fn waiter(session: &str, deps: &[&str], checkpoint: Option<&str>) -> Waiter {
        Waiter {
            session: session.into(),
            deps: deps.iter().map(|d| CoordRef::Session { id: (*d).to_string() }).collect(),
            checkpoint: checkpoint.map(str::to_string),
            registered_at: 0,
        }
    }

    /// The SOURCE is the load-bearing half: "landed" and "merged" are different facts, and a session
    /// that only knows "it is done" cannot tell whether to re-read anything.
    #[test]
    fn a_woken_waiter_is_told_how_each_dep_was_satisfied() {
        let mut s = CoordState::default();
        s.latches.insert(
            "session:b".into(),
            LatchStatus::Satisfied { source: crate::coord::SatisfySource::Merged, at: 1 },
        );
        let p = wake_prompt_for(&waiter("a", &["b"], None), &s);
        assert!(p.contains("(merged)"), "not merely that it landed: {p}");

        // A dep with NO latch is still named, as "ready" — a fresh session sees every dep it awaited.
        let bare = wake_prompt_for(&waiter("a", &["ghost"], None), &CoordState::default());
        assert!(bare.contains("session:ghost (ready)"), "{bare}");
    }

    /// The singular/plural agreement is part of the text an agent reads.
    #[test]
    fn the_plural_agrees_with_the_dep_count() {
        let s = CoordState::default();
        assert!(wake_prompt_for(&waiter("a", &["b"], None), &s).contains("dependency has landed"));
        assert!(wake_prompt_for(&waiter("a", &["b", "c"], None), &s).contains("dependencies have landed"));
    }

    /// Without this, a parked session parks again the moment it resumes.
    #[test]
    fn the_answered_wake_forbids_asking_the_user() {
        let a = AnsweredWake { session: "a".into(), answer: "go".into(), checkpoint: None };
        assert!(answer_wake_prompt(&a).contains("Do not ask the user"));
        // An empty answer names the notes rather than trailing off.
        let empty = AnsweredWake { session: "a".into(), answer: "   ".into(), checkpoint: None };
        assert!(answer_wake_prompt(&empty).contains("(see the director's notes)"));
    }

    /// The ORDER is the instruction: re-ground, then begin.
    #[test]
    fn an_assigned_worker_rereads_its_checkpoint_before_beginning() {
        let a = AssignedWork {
            session: "a".into(),
            title: "t".into(),
            body: "b".into(),
            checkpoint: Some("cp".into()),
        };
        let p = assign_wake_prompt(&a);
        assert!(p.find("First re-read").unwrap() > p.find("assigned you new work").unwrap());
    }

    /// No checkpoint means NO checkpoint line — not an empty or dangling one.
    #[test]
    fn an_absent_checkpoint_emits_no_line() {
        let s = CoordState::default();
        assert!(!wake_prompt_for(&waiter("a", &["b"], None), &s).contains("checkpoint"));
        let w = WaitingSession { session: "a".into(), reason: "r".into(), checkpoint: None, at: 1 };
        assert!(!waiting_wake_prompt(&w).contains("checkpoint"));
        let a = AssignedWork { session: "a".into(), title: String::new(), body: String::new(), checkpoint: None };
        assert!(!assign_wake_prompt(&a).contains("checkpoint"));
    }

    /// An empty reason takes a SHORTER sentence rather than emitting a dangling colon.
    #[test]
    fn an_empty_reason_does_not_leave_a_dangling_colon() {
        let w = WaitingSession { session: "a".into(), reason: "  ".into(), checkpoint: None, at: 1 };
        let p = waiting_wake_prompt(&w);
        assert!(!p.contains("confirmation:"), "{p}");
        assert!(p.contains("You paused for the user"));
    }
}
