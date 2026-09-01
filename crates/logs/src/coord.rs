//! The `coord.log` ingest — parse a line, fold it into the coordination state, replay a whole log.
//!
//! ## Why this is Rust
//!
//! `coord.log` is written by the BACKEND (the app's pty env-writer stages it; `bsc plan request`
//! appends to it) and by the pure-shell `bsc-*` emitters in `src-tauri/data/shell/coord-emit.sh`. It
//! was READ only in TypeScript — `coordinationLog.ts` over the latch/waiter model in
//! `coordinationState.ts` — so the fleet's own state (who is parked, who is ready, what an actor from
//! another project tried to direct) could only be known while a renderer was alive. That is the
//! inversion `epic-frontend-logic-over-backend-resources-belongs-in-rust` exists to remove.
//!
//! ## Its relationship to [`crate::waiting`]
//!
//! [`crate::waiting::waiting_in`] already re-derives a NARROW projection of this same fold — the
//! blocked-on-a-human queue — and says in its own doc comment that it cannot share an implementation
//! with the reducer and so is "tested here independently rather than assumed equivalent". Independent
//! tests of two copies is precisely how its `woke` arm drifted: it cleared only a `wait` while the
//! reducer also clears `asking`, so a woken session's ask was immortal in `bsc logs waiting` and the
//! director was re-handed it every sweep.
//!
//! This module is the FULL fold, and it is proved against the TypeScript case by case
//! (`coordLog.fixtures.json`) rather than tested independently. Re-deriving `waiting()` from it, and
//! retiring the TypeScript, are separate items: the epic is explicit that a copy is removed only
//! after the disagreement has been shown absent in the field, not on the strength of a green test.
//!
//! ## Two places the port is deliberately narrower than JavaScript
//!
//! Both are recorded rather than papered over, because a silent difference is the whole failure mode
//! this module exists to end.
//!
//! - **Timestamps.** The reducer dates a line with `Date.parse`, which accepts far more than anything
//!   ever writes here. [`coord_at`] accepts the emitted grammar (`date -u +%Y-%m-%dT%H:%M:%SZ`, which
//!   `epoch_ms_to_iso8601` also produces) and falls back to `0` otherwise, exactly as the reducer
//!   does for a string that is not a time. A zone-less or fractional-second timestamp is NOT
//!   reproduced — and is not emitted; see `zoneless_and_fractional_timestamps_are_out_of_domain`.
//! - **`Number()` on a `#`-ref.** [`js_number`] reproduces the three behaviours that actually reach
//!   it — it trims, it reads exponent notation, and it maps an empty string to `0` — all three
//!   pinned by the fixture. It does NOT reproduce JavaScript's hexadecimal (`Number("0x10") === 16`)
//!   or binary/octal literal forms; see `hex_refs_are_out_of_domain`.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------------------------
// Refs and latches
// ---------------------------------------------------------------------------------------------

/// A structured dependency target — what a session is blocked *on*, or what landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CoordRef {
    Issue { number: i64 },
    Contract { name: String },
    File { path: String },
    Predicate { expr: String },
    Session { id: String },
}

/// The authoritative signal that satisfied a latch.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SatisfySource {
    Merged,
    Closed,
    Landed,
}

/// Per-ref latch status. `Satisfied` wakes dependents; `Failed` HOLDS them — finished is not
/// succeeded, and the two are distinct on purpose.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum LatchStatus {
    Satisfied { source: SatisfySource, at: i64 },
    Failed { reason: String, at: i64 },
}

/// Canonical string key for a ref — and the wire form too: exactly the token the completion emitters
/// take as their argument (`bsc-landed '#42'`).
pub fn ref_key(r: &CoordRef) -> String {
    match r {
        CoordRef::Issue { number } => format!("#{number}"),
        CoordRef::Contract { name } => format!("contract:{name}"),
        CoordRef::File { path } => format!("file:{path}"),
        CoordRef::Predicate { expr } => format!("predicate:{expr}"),
        CoordRef::Session { id } => format!("session:{id}"),
    }
}

/// JavaScript's `Number(s)` for the subset that reaches a `#`-ref: it TRIMS, it reads exponent
/// notation, and `Number("")` is `0`. See the module docs for what it deliberately does not cover.
fn js_number(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() {
        return Some(0.0);
    }
    // `parse::<f64>` accepts `inf`/`NaN` spellings JavaScript does not; requiring finiteness rejects
    // them, and every non-finite value would fail the integer test below anyway.
    s.parse::<f64>().ok().filter(|v| v.is_finite())
}

/// Parse a wire token (`#42`, `contract:X`, `file:path`, `predicate:expr`, `session:id`) into a ref —
/// the argument form of `bsc-landed`/`merged`/`closed`/`failed`, and of the dep column of a pre-#1039
/// `blocked` line. `None` for an unrecognized or empty token. A bare `42` is an issue; an unprefixed
/// non-numeric token is a predicate.
///
/// The `#` and bare-digit branches are NOT symmetric and that is faithful, not a bug: `#0` is
/// rejected (an issue number must be positive) while a bare `0` is accepted by the digits regex and
/// becomes issue 0. Both are pinned by the fixture.
pub fn parse_ref(token: &str) -> Option<CoordRef> {
    let t = token.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(rest) = t.strip_prefix('#') {
        let n = js_number(rest)?;
        return if n.fract() == 0.0 && n > 0.0 {
            Some(CoordRef::Issue { number: n as i64 })
        } else {
            None
        };
    }
    if let Some(colon) = t.find(':') {
        if colon > 0 {
            let prefix = &t[..colon];
            let rest = t[colon + 1..].trim();
            if rest.is_empty() {
                return None;
            }
            return match prefix {
                "contract" => Some(CoordRef::Contract { name: rest.to_string() }),
                "file" => Some(CoordRef::File { path: rest.to_string() }),
                "predicate" => Some(CoordRef::Predicate { expr: rest.to_string() }),
                "session" => Some(CoordRef::Session { id: rest.to_string() }),
                _ => None,
            };
        }
    }
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        // Through `f64` rather than `i64` so the value matches the reducer's for a token wider than
        // an i64 — the number type is what differs, not the parse.
        return Some(CoordRef::Issue { number: t.parse::<f64>().ok()? as i64 });
    }
    Some(CoordRef::Predicate { expr: t.to_string() })
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/// A parked session waiting on every ref in `deps`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Waiter {
    pub session: String,
    pub deps: Vec<CoordRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub registered_at: i64,
}

/// A session paused for the USER (`bsc-wait`) — no deps, never auto-woken.
///
/// NOT [`crate::waiting::WaitingSession`], which is a row of the `bsc logs waiting` QUEUE and spans
/// four kinds across two logs. This is the reducer's `waiting` list, one of that queue's inputs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaitingSession {
    pub session: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub at: i64,
}

/// A session parked on a `bsc-ask` question to the director — resumed when it answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskingSession {
    pub session: String,
    pub question: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub at: i64,
}

/// A shaped issue the issuer captured, awaiting the director's `bsc-assign`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingIssue {
    pub id: String,
    pub session: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub suggested: Option<String>,
    pub at: i64,
}

/// A worker in MAINTENANCE: every owned issue done, parked alive and ready rather than ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintainingSession {
    pub session: String,
    pub note: String,
    pub at: i64,
}

/// A mid-build plan update the planner streamed to a running director/issuer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceivedBrief {
    pub id: String,
    pub from: String,
    pub target: String,
    pub body: String,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<CoordRef>,
    pub at: i64,
}

/// A subagent a session spawned — recorded because a fork has no pane, no roster row and no branch,
/// so without this it is the one actor in the fleet nobody can see.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnedFork {
    pub id: String,
    pub session: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_type: Option<String>,
    pub at: i64,
}

/// An open commission in the studio network: one studio session asked another to author an artifact.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCommission {
    pub id: String,
    pub from: String,
    pub target: String,
    pub body: String,
    #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<CoordRef>,
    pub at: i64,
    /// Set once a matching `deliver` arrives: the authored artifact's id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered: Option<String>,
}

/// A worker→director change request awaiting an answer. The durable record is in the project's
/// plan.db; this is the delivery signal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub id: String,
    /// The requesting SESSION (the pane id from the line's session column), not plan.db's `from`.
    pub from: String,
    pub text: String,
    pub at: i64,
}

/// A pending injection produced when the director assigns work to a worker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedWork {
    pub session: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub body: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub at: i64,
}

/// A pending wake produced when the director answers a parked session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnsweredWake {
    pub session: String,
    pub answer: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<String>,
    pub at: i64,
}

/// An event REFUSED at delivery because its target belongs to a different project. Kept rather than
/// dropped: a silently swallowed answer looks to the director exactly like one that was delivered,
/// so it would go on believing it had unblocked a worker it never reached.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossProjectRefusal {
    /// `answer` or `assign`.
    pub kind: String,
    pub from: String,
    pub target: String,
    pub at: i64,
}

/// Stable per-EVENT key for a refusal, so a consumer reports each one exactly once.
///
/// `at` IS part of the key, and that is the point of keying per event rather than per pair: a
/// refusal is not a state that resolves, it is a thing that happened. The same director really can
/// misdirect the same worker again a minute later, and that second attempt is news.
pub fn refusal_key(r: &CrossProjectRefusal) -> String {
    format!("{}@{}@{}@{}", r.kind, r.from, r.target, r.at)
}

/// The coordinator's persistable state: the latch table plus every parked/pending list.
///
/// `latches` is a `BTreeMap` where the reducer has an insertion-ordered object — key order is not
/// part of the contract (every read is by key), and ordering it makes the state comparable.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordState {
    pub latches: std::collections::BTreeMap<String, LatchStatus>,
    pub waiters: Vec<Waiter>,
    pub waiting: Vec<WaitingSession>,
    pub asking: Vec<AskingSession>,
    pub issues: Vec<PendingIssue>,
    pub maintaining: Vec<MaintainingSession>,
    pub briefs: Vec<ReceivedBrief>,
    pub forks: Vec<SpawnedFork>,
    pub commissions: Vec<OpenCommission>,
    pub requests: Vec<OpenRequest>,
}

/// Whether `ref` is satisfied — truly done, not merely failed.
pub fn is_satisfied(s: &CoordState, r: &CoordRef) -> bool {
    matches!(s.latches.get(&ref_key(r)), Some(LatchStatus::Satisfied { .. }))
}

/// Whether all of a waiter's deps are satisfied.
pub fn is_ready(s: &CoordState, w: &Waiter) -> bool {
    w.deps.iter().all(|d| is_satisfied(s, d))
}

/// Waiters currently blocked on a ref that has *failed* — a stalled chain to escalate.
pub fn stalled_waiters(s: &CoordState, r: &CoordRef) -> Vec<Waiter> {
    let key = ref_key(r);
    if !matches!(s.latches.get(&key), Some(LatchStatus::Failed { .. })) {
        return Vec::new();
    }
    s.waiters.iter().filter(|w| w.deps.iter().any(|d| ref_key(d) == key)).cloned().collect()
}

/// Register a blocking session. `ready` is whether all its deps are ALREADY satisfied — the
/// register-then-check that defeats a lost wakeup, so the caller may proceed immediately. When
/// already ready the waiter is not added (there is nothing to wait for); otherwise it is
/// added/replaced by session id.
pub fn register_waiter(s: &CoordState, w: Waiter) -> (CoordState, bool) {
    let ready = is_ready(s, &w);
    let mut next = s.clone();
    next.waiters.retain(|x| x.session != w.session);
    if !ready {
        next.waiters.push(w);
    }
    (next, ready)
}

/// Mark a ref satisfied (`landed`/`merged`/`closed`). Returns the waiters now fully ready, removing
/// them from the table. Idempotent: re-delivering a satisfy is harmless, because readiness is state.
pub fn satisfy(s: &CoordState, r: &CoordRef, source: SatisfySource, at: i64) -> (CoordState, Vec<Waiter>) {
    let mut next = s.clone();
    next.latches.insert(ref_key(r), LatchStatus::Satisfied { source, at });
    let woken: Vec<Waiter> = next.waiters.iter().filter(|w| is_ready(&next, w)).cloned().collect();
    let ids: std::collections::HashSet<&str> = woken.iter().map(|w| w.session.as_str()).collect();
    next.waiters = s.waiters.iter().filter(|w| !ids.contains(w.session.as_str())).cloned().collect();
    (next, woken)
}

/// Mark a ref failed. Does NOT satisfy the latch — dependents stay blocked and surface as a stalled
/// chain. Returns the waiters now stalled on it. Idempotent.
pub fn fail(s: &CoordState, r: &CoordRef, reason: &str, at: i64) -> (CoordState, Vec<Waiter>) {
    let mut next = s.clone();
    next.latches.insert(ref_key(r), LatchStatus::Failed { reason: reason.to_string(), at });
    let stalled = stalled_waiters(&next, r);
    (next, stalled)
}

// ---------------------------------------------------------------------------------------------
// Project scoping
// ---------------------------------------------------------------------------------------------

/// The PROJECT a pane belongs to. Pane identity is `<projectKey>:<stream>`, so the scope is already
/// on the wire and this only reads it. A pane id with no colon yields the whole string — see
/// [`same_coord_project`] for how an unplaceable id is then treated at delivery.
pub fn coord_project_of(pane: &str) -> &str {
    match pane.find(':') {
        Some(i) => &pane[..i],
        None => pane,
    }
}

/// May `from` direct `target`? Only within one project.
///
/// `coord.log` is ONE app-wide file and every consumer replays the whole tail, so before this a
/// director in project A could answer a worker in project B — through the same trusted channel the
/// worker's real director uses, with nothing in-band to tell them apart.
///
/// REFUSES ONLY ON PROOF OF CROSSING. An id with no `:` cannot be placed in a project (the retired
/// positional ids, a hand-run emitter, `?` from an unset `BSC_AUDIT_PANE`) and refusing what cannot
/// be placed would break single-project coordination that never used prefixed ids. The residual is
/// deliberate: a bare-id target is reachable from any project. Tightening that means retiring bare
/// ids, not tightening this rule.
pub fn same_coord_project(from: &str, target: &str) -> bool {
    let a = coord_project_of(from);
    let b = coord_project_of(target);
    if a == from || b == target {
        return true;
    }
    a == b
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/// A structured coordination event — one per `$BSC_COORD_LOG` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum CoordEvent {
    /// No emitter since #1039 removed runtime dependency-wait; parsing stays so an older log replays.
    Blocked {
        session: String,
        deps: Vec<CoordRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint: Option<String>,
        at: i64,
    },
    Landed { r#ref: CoordRef, at: i64 },
    Merged { r#ref: CoordRef, at: i64 },
    Closed { r#ref: CoordRef, at: i64 },
    Failed { r#ref: CoordRef, reason: String, at: i64 },
    Woke { session: String, at: i64 },
    Waiting {
        session: String,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint: Option<String>,
        at: i64,
    },
    Ask {
        session: String,
        question: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        checkpoint: Option<String>,
        at: i64,
    },
    /// `from` is the EMITTER's pane. It was parsed and thrown away until the cross-project refusal:
    /// without it there is nothing to compare the target against.
    Answer { from: String, target: String, answer: String, at: i64 },
    Issue {
        session: String,
        id: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        body: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suggested: Option<String>,
        at: i64,
    },
    Assign {
        session: String,
        target: String,
        body: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        issue_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        at: i64,
    },
    Maintain {
        session: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        note: Option<String>,
        at: i64,
    },
    /// Emitted by the `bsc-fork` PreToolUse hook, so it lands whether or not the spawning session
    /// chose to announce itself — the visibility cannot depend on the forker's cooperation.
    Fork {
        session: String,
        description: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        subagent_type: Option<String>,
        at: i64,
    },
    Request { session: String, id: String, text: String, at: i64 },
    #[serde(rename = "request-resolved")]
    RequestResolved { id: String, at: i64 },
    Brief {
        from: String,
        target: String,
        body: String,
        #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<CoordRef>,
        id: String,
        at: i64,
    },
    Commission {
        from: String,
        target: String,
        body: String,
        #[serde(rename = "ref", default, skip_serializing_if = "Option::is_none")]
        r#ref: Option<CoordRef>,
        id: String,
        at: i64,
    },
    Deliver { commission_id: String, artifact_id: String, from: String, at: i64 },
    Verdict {
        juror: String,
        target: String,
        verdict: JuryVerdict,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        relevant: Option<bool>,
        at: i64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JuryVerdict {
    Pass,
    Reject,
}

/// Date a line the way the reducer does: the emitted ISO-8601 grammar, else `0`. See the module docs
/// for the two forms `Date.parse` accepts that this deliberately does not.
fn coord_at(ts: &str) -> i64 {
    bsc_util::iso8601_to_epoch_ms(ts).unwrap_or(0)
}

/// `rest[i]?.trim() || undefined` — an absent, empty or all-whitespace column is `None`, and a
/// present one is stored TRIMMED.
fn opt_trimmed(cols: &[&str], i: usize) -> Option<String> {
    let v = cols.get(i)?.trim();
    if v.is_empty() {
        None
    } else {
        Some(v.to_string())
    }
}

/// `rest[i] ?? ""` — the raw column, NOT trimmed. Several payload fields keep their whitespace
/// (`waiting.reason`, `answer.answer`, `assign.body`, `brief.body`) and the difference is visible in
/// the fixture, so the two accessors are kept apart rather than unified into one tolerant helper.
fn raw(cols: &[&str], i: usize) -> String {
    cols.get(i).copied().unwrap_or("").to_string()
}

/// Parse one TSV `$BSC_COORD_LOG` line into an event, or `None` if unrecognized.
///
/// Columns: `ts \t session \t kind \t <payload…>`. A line with FEWER THAN FOUR columns is rejected
/// outright — which is why even a payload-less `woke` is emitted with a trailing empty column.
pub fn parse_coord_line(line: &str) -> Option<CoordEvent> {
    // `line.replace(/\r?\n$/, "")` — ONE trailing newline, with an optional CR before it. A line
    // ending in a bare CR is left alone, as it is there.
    let line = match line.strip_suffix('\n') {
        Some(l) => l.strip_suffix('\r').unwrap_or(l),
        None => line,
    };
    let cols: Vec<&str> = line.split('\t').collect();
    if cols.len() < 4 {
        return None;
    }
    let at = coord_at(cols[0]);
    let session = cols[1].to_string();
    let kind = cols[2];
    let rest = &cols[3..];
    match kind {
        "blocked" => {
            let col = raw(rest, 0);
            let deps: Vec<CoordRef> = col.split(',').filter_map(parse_ref).collect();
            if deps.is_empty() {
                return None;
            }
            Some(CoordEvent::Blocked { session, deps, checkpoint: opt_trimmed(rest, 1), at })
        }
        "landed" => parse_ref(&raw(rest, 0)).map(|r| CoordEvent::Landed { r#ref: r, at }),
        "merged" => parse_ref(&raw(rest, 0)).map(|r| CoordEvent::Merged { r#ref: r, at }),
        "closed" => parse_ref(&raw(rest, 0)).map(|r| CoordEvent::Closed { r#ref: r, at }),
        "failed" => parse_ref(&raw(rest, 0)).map(|r| CoordEvent::Failed { r#ref: r, reason: raw(rest, 1), at }),
        "waiting" => Some(CoordEvent::Waiting {
            session,
            reason: raw(rest, 0),
            checkpoint: opt_trimmed(rest, 1),
            at,
        }),
        "ask" => Some(CoordEvent::Ask {
            session,
            question: raw(rest, 0),
            checkpoint: opt_trimmed(rest, 1),
            at,
        }),
        "fork" => {
            let description = raw(rest, 0).trim().to_string();
            if description.is_empty() {
                return None;
            }
            Some(CoordEvent::Fork { session, description, subagent_type: opt_trimmed(rest, 1), at })
        }
        "answer" => {
            let target = raw(rest, 0).trim().to_string();
            if target.is_empty() {
                return None;
            }
            Some(CoordEvent::Answer { from: session, target, answer: raw(rest, 1), at })
        }
        "request" => {
            let id = raw(rest, 0).trim().to_string();
            if id.is_empty() {
                return None;
            }
            Some(CoordEvent::Request { session, id, text: raw(rest, 1), at })
        }
        "request-resolved" => {
            let id = raw(rest, 0).trim().to_string();
            if id.is_empty() {
                return None;
            }
            Some(CoordEvent::RequestResolved { id, at })
        }
        "issue" => {
            // payload = <title> \t <body?> \t <suggested?> \t <id?>
            let title = raw(rest, 0).trim().to_string();
            if title.is_empty() {
                return None;
            }
            let id = opt_trimmed(rest, 3).unwrap_or_else(|| format!("{session}@{at}"));
            Some(CoordEvent::Issue {
                session,
                id,
                title,
                body: opt_trimmed(rest, 1),
                suggested: opt_trimmed(rest, 2),
                at,
            })
        }
        "assign" => {
            // payload = <target> \t <body> \t <issueId?> \t <title?>
            let target = raw(rest, 0).trim().to_string();
            if target.is_empty() {
                return None;
            }
            Some(CoordEvent::Assign {
                session,
                target,
                body: raw(rest, 1),
                issue_id: opt_trimmed(rest, 2),
                title: opt_trimmed(rest, 3),
                at,
            })
        }
        "maintain" => Some(CoordEvent::Maintain { session, note: opt_trimmed(rest, 0), at }),
        "brief" | "commission" => {
            // payload = <target> \t <body> \t <ref?>. The session column is the emitter; the id
            // (`<from>@<at>`) dedupes a replayed log, and for a commission it is what a `deliver`
            // references back.
            let target = raw(rest, 0).trim().to_string();
            if target.is_empty() {
                return None;
            }
            let body = raw(rest, 1);
            if body.trim().is_empty() {
                return None;
            }
            let r = parse_ref(&raw(rest, 2));
            let id = format!("{session}@{at}");
            Some(if kind == "brief" {
                CoordEvent::Brief { from: session, target, body, r#ref: r, id, at }
            } else {
                CoordEvent::Commission { from: session, target, body, r#ref: r, id, at }
            })
        }
        "deliver" => {
            let commission_id = raw(rest, 0).trim().to_string();
            let artifact_id = raw(rest, 1).trim().to_string();
            if commission_id.is_empty() || artifact_id.is_empty() {
                return None;
            }
            Some(CoordEvent::Deliver { commission_id, artifact_id, from: session, at })
        }
        "verdict" => {
            // payload = <target> \t <pass|reject> \t <reason?> \t <relevant?>
            let target = raw(rest, 0).trim().to_string();
            let v = raw(rest, 1).trim().to_lowercase();
            let verdict = match v.as_str() {
                "pass" => JuryVerdict::Pass,
                "reject" => JuryVerdict::Reject,
                _ => return None,
            };
            if target.is_empty() {
                return None;
            }
            // An ABSENT column is `undefined`; a PRESENT but empty one is `true`. The two must not
            // collapse — that asymmetry is the reducer's, and it is in the fixture.
            let relevant = rest
                .get(3)
                .map(|c| { let c = c.trim(); c != "false" && c != "0" });
            Some(CoordEvent::Verdict {
                juror: session,
                target,
                verdict,
                reason: opt_trimmed(rest, 2),
                relevant,
                at,
            })
        }
        "woke" => Some(CoordEvent::Woke { session, at }),
        _ => None,
    }
}

/// What folding one event triggered, alongside the next state.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    pub state: CoordState,
    pub woken: Vec<Waiter>,
    pub ready: bool,
    pub stalled: Vec<Waiter>,
    pub answered: Vec<AnsweredWake>,
    pub assigned: Vec<AssignedWork>,
    pub refused: Vec<CrossProjectRefusal>,
}

impl Applied {
    fn state_only(state: CoordState) -> Self {
        Applied { state, ..Default::default() }
    }
}

/// The checkpoint a directive carries into the resumed session: an ask's, else a user-wait's, else a
/// dependency waiter's — the reducer's `ask ?? waiting ?? waiter` precedence.
fn checkpoint_for(s: &CoordState, target: &str) -> Option<String> {
    s.asking
        .iter()
        .find(|a| a.session == target)
        .and_then(|a| a.checkpoint.clone())
        .or_else(|| s.waiting.iter().find(|w| w.session == target).and_then(|w| w.checkpoint.clone()))
        .or_else(|| s.waiters.iter().find(|w| w.session == target).and_then(|w| w.checkpoint.clone()))
}

/// Clear every park for `target` — the state half of the director's universal unblock.
fn unpark(state: &mut CoordState, target: &str) {
    state.asking.retain(|a| a.session != target);
    state.waiters.retain(|w| w.session != target);
    state.waiting.retain(|w| w.session != target);
}

/// Fold one event into the coordination state, returning what it triggered.
pub fn apply_coord_event(s: &CoordState, e: &CoordEvent) -> Applied {
    match e {
        CoordEvent::Blocked { session, deps, checkpoint, at } => {
            let (mut state, ready) = register_waiter(
                s,
                Waiter {
                    session: session.clone(),
                    deps: deps.clone(),
                    checkpoint: checkpoint.clone(),
                    registered_at: *at,
                },
            );
            // A session that now declares a real dependency leaves the manual-wait list.
            state.waiting.retain(|w| &w.session != session);
            Applied { state, ready, ..Default::default() }
        }
        CoordEvent::Waiting { session, reason, checkpoint, at } => {
            let mut state = s.clone();
            state.waiting.retain(|w| &w.session != session);
            state.waiting.push(WaitingSession {
                session: session.clone(),
                reason: reason.clone(),
                checkpoint: checkpoint.clone(),
                at: *at,
            });
            Applied::state_only(state)
        }
        CoordEvent::Landed { r#ref, at } | CoordEvent::Merged { r#ref, at } | CoordEvent::Closed { r#ref, at } => {
            let source = match e {
                CoordEvent::Landed { .. } => SatisfySource::Landed,
                CoordEvent::Merged { .. } => SatisfySource::Merged,
                _ => SatisfySource::Closed,
            };
            let (state, woken) = satisfy(s, r#ref, source, *at);
            Applied { state, woken, ..Default::default() }
        }
        CoordEvent::Failed { r#ref, reason, at } => {
            let (state, stalled) = fail(s, r#ref, reason, *at);
            Applied { state, stalled, ..Default::default() }
        }
        CoordEvent::Woke { session, at: _ } => {
            // `maintaining` is CARRIED, not cleared: once a worker enters maintenance it stays a
            // maintenance worker across dispatches — auto-end permanently skips it, and that IS the
            // mode.
            let mut state = s.clone();
            state.waiters.retain(|w| &w.session != session);
            state.waiting.retain(|w| &w.session != session);
            state.asking.retain(|a| &a.session != session);
            Applied::state_only(state)
        }
        CoordEvent::Ask { session, question, checkpoint, at } => {
            let mut state = s.clone();
            state.asking.retain(|a| &a.session != session);
            state.asking.push(AskingSession {
                session: session.clone(),
                question: question.clone(),
                checkpoint: checkpoint.clone(),
                at: *at,
            });
            // Asking the director supersedes any prior user-wait registration for this session.
            state.waiting.retain(|w| &w.session != session);
            Applied::state_only(state)
        }
        CoordEvent::Answer { from, target, answer, at } => {
            // The director is addressing a specific worker — resume it whatever its park (an ask, a
            // dependency block, or a user-wait) and deliver the directive. `bsc-answer` is the
            // universal "unblock + tell this worker", not just the reply to an ask.
            //
            // CROSS-PROJECT REFUSAL leaves the STATE untouched as well as the delivery: clearing the
            // park here would mark the worker answered by an actor with no authority over it, so its
            // REAL director would then see nothing outstanding and never reply.
            if !same_coord_project(from, target) {
                return Applied {
                    state: s.clone(),
                    refused: vec![CrossProjectRefusal {
                        kind: "answer".into(),
                        from: from.clone(),
                        target: target.clone(),
                        at: *at,
                    }],
                    ..Default::default()
                };
            }
            let checkpoint = checkpoint_for(s, target);
            let mut state = s.clone();
            unpark(&mut state, target);
            Applied {
                state,
                answered: vec![AnsweredWake {
                    session: target.clone(),
                    answer: answer.clone(),
                    checkpoint,
                    at: *at,
                }],
                ..Default::default()
            }
        }
        CoordEvent::Request { session, id, text, at } => {
            // Dedup by id so a replayed log doesn't double it — the same guard `issue` uses.
            let mut state = s.clone();
            state.requests.retain(|r| &r.id != id);
            state.requests.push(OpenRequest {
                id: id.clone(),
                from: session.clone(),
                text: text.clone(),
                at: *at,
            });
            Applied::state_only(state)
        }
        CoordEvent::RequestResolved { id, at: _ } => {
            // Removing it here is what lets the pump's surfaced-once guard be pruned, so a later
            // re-file of the same ask surfaces again rather than being suppressed by a stale key.
            let mut state = s.clone();
            state.requests.retain(|r| &r.id != id);
            Applied::state_only(state)
        }
        CoordEvent::Issue { session, id, title, body, suggested, at } => {
            let mut state = s.clone();
            state.issues.retain(|i| &i.id != id);
            state.issues.push(PendingIssue {
                id: id.clone(),
                session: session.clone(),
                title: title.clone(),
                body: body.clone(),
                suggested: suggested.clone(),
                at: *at,
            });
            Applied::state_only(state)
        }
        CoordEvent::Assign { session, target, body, issue_id, title, at } => {
            // Same refusal as `answer`, and for the stronger reason: an assign hands a worker WORK.
            // Taking an assignment from another project's director means building something for a
            // plan, repo and lane that actor has no authority over.
            if !same_coord_project(session, target) {
                return Applied {
                    state: s.clone(),
                    refused: vec![CrossProjectRefusal {
                        kind: "assign".into(),
                        from: session.clone(),
                        target: target.clone(),
                        at: *at,
                    }],
                    ..Default::default()
                };
            }
            let checkpoint = checkpoint_for(s, target);
            let mut state = s.clone();
            unpark(&mut state, target);
            if let Some(iid) = issue_id {
                state.issues.retain(|i| &i.id != iid);
            }
            Applied {
                state,
                assigned: vec![AssignedWork {
                    session: target.clone(),
                    title: title.clone(),
                    body: body.clone(),
                    checkpoint,
                    at: *at,
                }],
                ..Default::default()
            }
        }
        CoordEvent::Maintain { session, note, at } => {
            // A finished worker parks alive in maintenance. Replace any prior entry, and drop it from
            // waiting/asking — it is idle-ready, not waiting on a human.
            let mut state = s.clone();
            state.maintaining.retain(|m| &m.session != session);
            state.maintaining.push(MaintainingSession {
                session: session.clone(),
                note: note.clone().unwrap_or_default(),
                at: *at,
            });
            state.waiting.retain(|w| &w.session != session);
            state.asking.retain(|a| &a.session != session);
            Applied::state_only(state)
        }
        CoordEvent::Fork { session, description, subagent_type, at } => {
            // Appended + deduped by id, like a brief. Never auto-cleared — this records what a
            // session DID, which does not stop being true.
            let id = format!("{session}@{at}");
            let mut state = s.clone();
            state.forks.retain(|f| f.id != id);
            state.forks.push(SpawnedFork {
                id,
                session: session.clone(),
                description: description.clone(),
                subagent_type: subagent_type.clone(),
                at: *at,
            });
            Applied::state_only(state)
        }
        CoordEvent::Brief { from, target, body, r#ref, id, at } => {
            // Unlike an ask/issue there is no consuming event that clears a brief — it is a standing
            // record; the director's surfacing is guarded once-per-pane by the pump, not by removal.
            let mut state = s.clone();
            state.briefs.retain(|b| &b.id != id);
            state.briefs.push(ReceivedBrief {
                id: id.clone(),
                from: from.clone(),
                target: target.clone(),
                body: body.clone(),
                r#ref: r#ref.clone(),
                at: *at,
            });
            Applied::state_only(state)
        }
        CoordEvent::Commission { from, target, body, r#ref, id, at } => {
            let mut state = s.clone();
            state.commissions.retain(|c| &c.id != id);
            state.commissions.push(OpenCommission {
                id: id.clone(),
                from: from.clone(),
                target: target.clone(),
                body: body.clone(),
                r#ref: r#ref.clone(),
                at: *at,
                delivered: None,
            });
            Applied::state_only(state)
        }
        CoordEvent::Deliver { commission_id, artifact_id, .. } => {
            // An unmatched deliver (no open commission for the id — a truncated log) is a no-op
            // rather than an error.
            let mut state = s.clone();
            for c in state.commissions.iter_mut() {
                if &c.id == commission_id {
                    c.delivered = Some(artifact_id.clone());
                }
            }
            Applied::state_only(state)
        }
        // Verdicts do not move the latch/waiter state — the foreman tallies them off the log and
        // emits the revert (a `failed` event) when the panel rejects. So this fold is a no-op.
        CoordEvent::Verdict { .. } => Applied::state_only(s.clone()),
    }
}

/// An insertion-ordered map keyed by session id — JavaScript `Map` semantics, which the replay
/// depends on: `set` on an existing key keeps its ORIGINAL position and replaces the value, and
/// `ready`/`answered`/`assigned` are that order. A `HashMap` would lose it and a `BTreeMap` would
/// silently substitute alphabetical order for arrival order.
struct OrderedMap<T> {
    entries: Vec<(String, T)>,
}

impl<T> OrderedMap<T> {
    fn new() -> Self {
        OrderedMap { entries: Vec::new() }
    }
    fn set(&mut self, key: &str, value: T) {
        match self.entries.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.entries.push((key.to_string(), value)),
        }
    }
    fn remove(&mut self, key: &str) {
        self.entries.retain(|(k, _)| k != key);
    }
    fn values(self) -> Vec<T> {
        self.entries.into_iter().map(|(_, v)| v).collect()
    }
}

/// The result of replaying a whole log.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ingested {
    pub state: CoordState,
    pub woken: Vec<Waiter>,
    /// Waiters that became ready and have NOT yet been acknowledged by a `woke` — the ones still
    /// awaiting actuation. The `woke` event is what makes a wake idempotent across polls and app
    /// restarts.
    pub ready: Vec<Waiter>,
    pub answered: Vec<AnsweredWake>,
    pub assigned: Vec<AssignedWork>,
    /// Events refused for crossing a project boundary — surfaced rather than dropped, so the sender
    /// can be told its answer never landed.
    pub refused: Vec<CrossProjectRefusal>,
}

/// Replay a whole `$BSC_COORD_LOG` (oldest-first) into coordination state — the coordinator's
/// rebuild-from-disk. Unparseable lines are skipped.
///
/// Note what is NOT propagated: `apply_coord_event`'s per-event `ready` flag (the register-then-check
/// that lets a caller proceed immediately) is dropped here, so a `blocked` whose deps were ALREADY
/// satisfied registers no waiter and reports no pending wake. That is the reducer's behaviour and the
/// fixture pins it.
pub fn ingest_coord_log(lines: &[String], initial: CoordState) -> Ingested {
    let mut state = initial;
    let mut woken: Vec<Waiter> = Vec::new();
    let mut pending: OrderedMap<Waiter> = OrderedMap::new();
    let mut answered_pending: OrderedMap<AnsweredWake> = OrderedMap::new();
    let mut assigned_pending: OrderedMap<AssignedWork> = OrderedMap::new();
    let mut refused: Vec<CrossProjectRefusal> = Vec::new();

    for line in lines {
        let Some(ev) = parse_coord_line(line) else { continue };
        if let CoordEvent::Woke { session, .. } = &ev {
            pending.remove(session);
            answered_pending.remove(session);
            assigned_pending.remove(session);
            state = apply_coord_event(&state, &ev).state;
            continue;
        }
        let r = apply_coord_event(&state, &ev);
        state = r.state;
        for w in r.woken {
            let key = w.session.clone();
            pending.set(&key, w.clone());
            woken.push(w);
        }
        for a in r.answered {
            let key = a.session.clone();
            answered_pending.set(&key, a);
        }
        for a in r.assigned {
            let key = a.session.clone();
            assigned_pending.set(&key, a);
        }
        refused.extend(r.refused);
    }

    Ingested {
        state,
        woken,
        ready: pending.values(),
        answered: answered_pending.values(),
        assigned: assigned_pending.values(),
        refused,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------------------------
    // The parity fixture — see the module docs for why the expectations are GENERATED, not typed.
    // -----------------------------------------------------------------------------------------

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        refs: Vec<RefCase>,
        projects: Vec<ProjectCase>,
        refusal_keys: Vec<RefusalKeyCase>,
        lines: Vec<LineCase>,
        logs: Vec<LogCase>,
    }
    #[derive(Deserialize)]
    struct RefCase {
        token: String,
        #[serde(rename = "ref")]
        r#ref: Option<CoordRef>,
        key: Option<String>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProjectCase {
        from: String,
        target: String,
        from_project: String,
        target_project: String,
        same: bool,
    }
    #[derive(Deserialize)]
    struct RefusalKeyCase {
        refusal: CrossProjectRefusal,
        key: String,
    }
    #[derive(Deserialize)]
    struct LineCase {
        name: String,
        line: String,
        event: Option<CoordEvent>,
    }
    #[derive(Deserialize)]
    struct LogCase {
        name: String,
        lines: Vec<String>,
        result: Ingested,
    }

    /// Resolved BY FILENAME under `src/`, the same rule `find_fixture` uses for the tunnel contract —
    /// so moving a feature slice does not break this, but RENAMING the fixture means updating this
    /// call in lockstep. Exactly one match is required: zero or a collision is a hard failure rather
    /// than a silent first-hit.
    fn fixture() -> Fixture {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("coordLog.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one coordLog.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// THE POINT OF THIS MODULE: Rust must agree with the TypeScript that ships today, case for case,
    /// before anything is switched over to it. `coord.log` drives who the director talks to and what a
    /// worker is handed; a fold that is subtly different after a port is worse than one never ported.
    #[test]
    fn rust_parses_the_same_refs_the_typescript_does() {
        let fx = fixture();
        assert!(fx.refs.len() >= 25, "the fixture must exercise the whole grammar: {}", fx.refs.len());
        assert!(fx.refs.iter().any(|c| c.r#ref.is_none()), "the REJECTIONS are half the contract");
        for c in &fx.refs {
            let got = parse_ref(&c.token);
            assert_eq!(got, c.r#ref, "parse_ref differs for {:?}", c.token);
            assert_eq!(got.as_ref().map(ref_key), c.key, "ref_key differs for {:?}", c.token);
        }
    }

    #[test]
    fn rust_scopes_projects_the_same_way_the_typescript_does() {
        let fx = fixture();
        assert!(fx.projects.iter().any(|c| !c.same), "at least one pair must actually cross");
        assert!(
            fx.projects.iter().any(|c| c.same && c.from_project != c.target_project),
            "and at least one must be ALLOWED despite differing prefixes — the unplaceable-id rule"
        );
        for c in &fx.projects {
            assert_eq!(coord_project_of(&c.from), c.from_project, "project of {:?}", c.from);
            assert_eq!(coord_project_of(&c.target), c.target_project, "project of {:?}", c.target);
            assert_eq!(
                same_coord_project(&c.from, &c.target),
                c.same,
                "scope differs for {:?} -> {:?}",
                c.from,
                c.target
            );
        }
        for c in &fx.refusal_keys {
            assert_eq!(refusal_key(&c.refusal), c.key, "refusal key differs for {:?}", c.refusal);
        }
    }

    #[test]
    fn rust_parses_the_same_lines_the_typescript_does() {
        let fx = fixture();
        assert!(fx.lines.len() >= 60, "the fixture must cover every arm: {}", fx.lines.len());
        let rejected = fx.lines.iter().filter(|c| c.event.is_none()).count();
        assert!(rejected >= 20, "only {rejected} rejection cases — the null returns are the easy half to drop");
        for c in &fx.lines {
            assert_eq!(parse_coord_line(&c.line), c.event, "parse differs for case {:?}", c.name);
        }
    }

    #[test]
    fn rust_folds_a_whole_log_the_same_way_the_typescript_does() {
        let fx = fixture();
        assert!(fx.logs.len() >= 20, "the fixture must replay real logs: {}", fx.logs.len());
        for c in &fx.logs {
            let got = ingest_coord_log(&c.lines, CoordState::default());
            assert_eq!(got.state, c.result.state, "state differs for log {:?}", c.name);
            assert_eq!(got.woken, c.result.woken, "woken differs for log {:?}", c.name);
            assert_eq!(got.ready, c.result.ready, "ready differs for log {:?}", c.name);
            assert_eq!(got.answered, c.result.answered, "answered differs for log {:?}", c.name);
            assert_eq!(got.assigned, c.result.assigned, "assigned differs for log {:?}", c.name);
            assert_eq!(got.refused, c.result.refused, "refused differs for log {:?}", c.name);
        }
    }

    /// The fixture must actually reach the refusal path on BOTH directives, or the security-relevant
    /// half of the port is untested while every other assertion above still passes.
    #[test]
    fn the_fixture_exercises_the_cross_project_refusal_on_answer_and_assign() {
        let fx = fixture();
        let mut kinds: Vec<String> =
            fx.logs.iter().flat_map(|l| l.result.refused.iter().map(|r| r.kind.clone())).collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds, vec!["answer".to_string(), "assign".to_string()]);
    }

    // -----------------------------------------------------------------------------------------
    // The two places the port is deliberately narrower than JavaScript. Recorded as tests so the
    // boundary is a fact in the suite rather than a claim in a comment.
    // -----------------------------------------------------------------------------------------

    /// `Date.parse` accepts both of these; the emitted grammar contains neither, and neither is in
    /// the fixture. A zone-less timestamp is LOCAL time to `Date.parse`, so pinning it would pin the
    /// generating machine's timezone into a committed artifact.
    #[test]
    fn zoneless_and_fractional_timestamps_are_out_of_domain() {
        assert_eq!(coord_at("2026-08-31T12:00:01Z"), 1788177601000);
        // No zone: accepted here as UTC, where `Date.parse` would read it as local.
        assert_eq!(coord_at("2026-08-31T12:00:01"), 1788177601000);
        // Fractional seconds: rejected here (⇒ 0), accepted by `Date.parse`.
        assert_eq!(coord_at("2026-08-31T12:00:01.500Z"), 0);
        assert_eq!(coord_at("not-a-time"), 0);
        assert_eq!(coord_at(""), 0);
    }

    /// `Number("0x10") === 16` in JavaScript. Not reproduced, and not emitted: a `#`-ref is written
    /// by a human or by `bsc-landed '#42'`, never in a radix literal.
    #[test]
    fn hex_refs_are_out_of_domain() {
        assert_eq!(parse_ref("#0x10"), None);
        // The three `Number()` behaviours that DO reach it are reproduced, and are in the fixture.
        assert_eq!(parse_ref("# 7"), Some(CoordRef::Issue { number: 7 }));
        assert_eq!(parse_ref("#1e3"), Some(CoordRef::Issue { number: 1000 }));
        assert_eq!(parse_ref("#"), None);
    }

    // -----------------------------------------------------------------------------------------
    // Properties the fixture cannot state, because they are about the SHAPE of the model rather
    // than about one captured answer.
    // -----------------------------------------------------------------------------------------

    /// `failed` is not a satisfy, and this is the distinction the whole latch model turns on:
    /// finished is not succeeded, so a dependent must stay blocked and surface as a stalled chain.
    #[test]
    fn a_failed_latch_holds_its_dependents_where_a_satisfied_one_releases_them() {
        let r = CoordRef::Issue { number: 42 };
        let (s, _) = register_waiter(
            &CoordState::default(),
            Waiter { session: "alpha:api".into(), deps: vec![r.clone()], checkpoint: None, registered_at: 1 },
        );
        let (failed, stalled) = fail(&s, &r, "the gate went red", 2);
        assert_eq!(stalled.len(), 1, "the dependent is stalled, not woken");
        assert_eq!(failed.waiters.len(), 1, "and it is still parked");
        assert!(!is_satisfied(&failed, &r));

        let (ok, woken) = satisfy(&failed, &r, SatisfySource::Merged, 3);
        assert_eq!(woken.len(), 1, "a later satisfy releases it");
        assert!(ok.waiters.is_empty());
    }

    /// The register-then-check that defeats a lost wakeup: a producer that finished BEFORE the waiter
    /// registered must not leave it parked forever.
    #[test]
    fn registering_against_an_already_satisfied_dep_is_ready_and_parks_nothing() {
        let r = CoordRef::Issue { number: 42 };
        let (s, _) = satisfy(&CoordState::default(), &r, SatisfySource::Landed, 1);
        let (next, ready) = register_waiter(
            &s,
            Waiter { session: "alpha:api".into(), deps: vec![r], checkpoint: None, registered_at: 2 },
        );
        assert!(ready, "already satisfied ⇒ proceed immediately");
        assert!(next.waiters.is_empty(), "and nothing is parked to be woken later");
    }

    /// `Map` insertion order is load-bearing for `ready`/`answered`/`assigned`, and it is the one
    /// thing a `HashMap` port would lose silently while every fixture case with a single waiter kept
    /// passing.
    #[test]
    fn pending_wakes_come_back_in_arrival_order_not_alphabetical() {
        let line = |ts: &str, session: &str, kind: &str, a: &str, b: &str| {
            format!("{ts}\t{session}\t{kind}\t{a}\t{b}")
        };
        let lines = vec![
            line("2026-08-31T12:00:01Z", "zulu:api", "blocked", "#42", ""),
            line("2026-08-31T12:00:02Z", "alpha:api", "blocked", "#42", ""),
            line("2026-08-31T12:00:03Z", "mike:api", "blocked", "#42", ""),
            line("2026-08-31T12:00:04Z", "svc", "landed", "#42", ""),
        ];
        let got = ingest_coord_log(&lines, CoordState::default());
        let order: Vec<&str> = got.ready.iter().map(|w| w.session.as_str()).collect();
        assert_eq!(order, vec!["zulu:api", "alpha:api", "mike:api"]);
    }

    /// A directive that crosses a project boundary must leave the target's park INTACT. Clearing it
    /// would mark the worker answered by an actor with no authority over it, and its real director
    /// would then see nothing outstanding and never reply — the quiet half of the bug.
    #[test]
    fn a_refused_directive_changes_no_state_at_all() {
        let before = ingest_coord_log(
            &["2026-08-31T12:00:01Z\talpha:api\task\twhich pagination?\t".to_string()],
            CoordState::default(),
        );
        let after = ingest_coord_log(
            &[
                "2026-08-31T12:00:01Z\talpha:api\task\twhich pagination?\t".to_string(),
                "2026-08-31T12:00:02Z\tbeta:director\tanswer\talpha:api\tcursor".to_string(),
            ],
            CoordState::default(),
        );
        assert_eq!(after.state, before.state, "the refused answer moved nothing");
        assert!(after.answered.is_empty(), "and delivered nothing");
        assert_eq!(after.refused.len(), 1, "but it is REPORTED, not swallowed");
    }
}
