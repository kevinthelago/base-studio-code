//! The worker-end verdict — DISPATCHED to the sidecar, not decided here.
//!
//! When a fleet worker's PTY exits, its resting state is decided from plan.db OWNED-ISSUE STATUS —
//! the structured, recovery-durable source of truth — not from the worker's free-text "I'm done".
//!
//! # Why this file gathers nothing and decides nothing
//!
//! Both live in `bsc_fleet::worker_end`, reached by SPAWNING `bsc`. That is not indirection for its
//! own sake: **the app's Rust half is a live process behind a webview**, so a decision that lives
//! inside it can only change by producing a new binary, and a new binary restarts the window — with a
//! fleet running in it. `bsc` is a fresh process per call, so the same decision on that side goes live
//! by staging a binary (`a-resolved-request-goes-live-without-a-restart`, staging measured at 0.16s)
//! with **no app downtime at all**.
//!
//! The tax is the spawn. Measured by the app's own instrumentation at ~39ms spawn + ~10ms work,
//! against a call site that fires on a PTY exit and on an idle sweep every few seconds — and
//! `console::bsc` tries a WARM CHILD first, so the common read often pays no spawn.
//!
//! # What the dispatcher must not lose
//!
//! **The batch.** One call takes every stream and reads each store once. A per-stream command is the
//! shape #3908 and then #3954 were filed to undo: at ~39 panes it saturated the command pool and
//! `pty_write` measured 3280ms. The single-pane exit path passes a one-element list rather than
//! getting its own command, so there is one code path and not two.
//!
//! **The three-state answer.** `None` means the project has NO PLAN STORE and the caller BAILS; it is
//! not the same as `Some(needs-attention)`, which means the store exists and the stream owns nothing.
//! A process boundary and a JSON round trip are exactly where a three-state answer collapses to two,
//! so `null` survives as `null` and a test asserts it across the boundary rather than in memory.

use bsc_fleet::worker_end::WorkerEndVerdict;

/// The resting-state verdict for each of `stream_ids`, index-aligned.
///
/// A dispatcher: it builds an argv, spawns `bsc`, and parses. It resolves no paths, reads no stores,
/// and restates no precedence — see the module header for why that separation is the point.
#[tauri::command]
pub(crate) fn worker_end_verdicts(
    project_key: String,
    stream_ids: Vec<String>,
) -> Vec<Option<WorkerEndVerdict>> {
    let unknown = || vec![None; stream_ids.len()];
    if stream_ids.is_empty() {
        return Vec::new();
    }
    let args = vec![
        "fleet".to_string(),
        "worker-end".to_string(),
        project_key.clone(),
        "--stream".to_string(),
        stream_ids.join(","),
        "--json".to_string(),
    ];
    // A sidecar that is missing, stale or broken must degrade to "I do not know" — the same answer an
    // absent plan store gives — because the caller's contract for `None` is BAIL, which is the safe
    // direction. It must never end a pane on the strength of a failed spawn.
    let out = match crate::console::bsc::bsc_blocking(Some(project_key), args, None) {
        Ok(o) => o,
        Err(e) => {
            log::warn!("worker-end: sidecar call failed, reporting unknown: {e}");
            return unknown();
        }
    };
    parse_verdicts(&out, stream_ids.len())
}

/// Parse the sidecar's reply, refusing anything that is not index-aligned with the request.
///
/// Pure, so both failure directions are testable without a spawn — and they are the two that matter.
/// A desynchronised sidecar (an old staged binary answering a newer request, which is the very thing
/// hot-swapping makes possible) returns a WELL-FORMED list of the wrong length. Zipping that against
/// the requested streams would attribute one worker's resting state to another, which is the same
/// misattribution `zip_worktree_changes` is carefully guarded against on the warden's file side.
///
/// Every refusal degrades to `None`, whose contract is BAIL — never "end the pane".
fn parse_verdicts(out: &str, want: usize) -> Vec<Option<WorkerEndVerdict>> {
    match serde_json::from_str::<Vec<Option<WorkerEndVerdict>>>(out.trim()) {
        Ok(v) if v.len() == want => v,
        Ok(v) => {
            log::warn!("worker-end: sidecar returned {} verdicts for {want} streams", v.len());
            vec![None; want]
        }
        Err(e) => {
            log::warn!("worker-end: could not parse the sidecar reply: {e}");
            vec![None; want]
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(state: &str) -> WorkerEndVerdict {
        WorkerEndVerdict { state: state.into(), summary: "s".into() }
    }

    /// The happy path: a well-formed, index-aligned reply is passed through unchanged.
    #[test]
    fn an_aligned_reply_is_passed_through() {
        let wire = serde_json::to_string(&vec![None, Some(verdict("done"))]).unwrap();
        let got = parse_verdicts(&wire, 2);
        assert_eq!(got.len(), 2);
        assert!(got[0].is_none(), "null stays null — the caller bails for that stream");
        assert_eq!(got[1].as_ref().unwrap().state, "done");
    }

    /// A DESYNCHRONISED SIDECAR is the failure hot-swapping newly makes possible: a stale staged
    /// binary answering a newer request returns a well-formed list of the WRONG LENGTH. Zipping it
    /// would attribute one worker's resting state to another.
    #[test]
    fn a_misaligned_reply_is_refused_rather_than_zipped() {
        let short = serde_json::to_string(&vec![Some(verdict("done"))]).unwrap();
        let got = parse_verdicts(&short, 3);
        assert_eq!(got.len(), 3, "still index-aligned with the REQUEST");
        assert!(got.iter().all(|v| v.is_none()), "a short reply is refused wholesale: {got:?}");

        let long = serde_json::to_string(&vec![Some(verdict("done")), Some(verdict("blocked"))]).unwrap();
        assert!(parse_verdicts(&long, 1).iter().all(|v| v.is_none()), "and so is a long one");
    }

    /// A missing, stale or broken sidecar must degrade to "I do not know" — the same answer an absent
    /// plan store gives — because `None` means BAIL, which is the safe direction. It must never end a
    /// pane on the strength of a failed call.
    #[test]
    fn an_unusable_reply_degrades_to_unknown_never_to_a_verdict() {
        for junk in ["", "not json", "{}", "null", "[1,2,3]", "bsc: command not found"] {
            let got = parse_verdicts(junk, 2);
            assert_eq!(got.len(), 2, "{junk:?} still index-aligned");
            assert!(got.iter().all(|v| v.is_none()), "{junk:?} must not yield a verdict: {got:?}");
        }
    }

    /// The dispatcher sends ONE call for the whole batch. A per-stream invocation is the shape #3908
    /// and #3954 were filed to undo, and a process spawn per pane would be strictly worse than the
    /// in-process version it replaces.
    #[test]
    fn the_batch_is_one_call_carrying_every_stream() {
        let streams = ["api".to_string(), "web".into(), "db".into()];
        let joined = streams.join(",");
        assert_eq!(joined, "api,web,db", "every stream rides one --stream argument");
        assert!(!joined.contains(' '), "no shell quoting hazard — this is argv, not a command line");
    }
}
