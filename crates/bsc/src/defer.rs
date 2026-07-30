//! `bsc hook stop-defer` (#4021) — the fleet worker's Stop hook, now with information.
//!
//! ## What it replaces
//! The old hook was a one-shot:
//!
//! ```sh
//! bsc-defer() { j="$(cat)";
//!   case "$j" in *'"stop_hook_active":true'*) return 0 ;; esac;
//!   printf '{"decision":"block","reason":"…keep going…"}'; }
//! ```
//!
//! One nudge, then the worker was free to stop forever. That was deliberate — "so a finished worker is
//! never trapped" — and it was the right instinct for a hook with NO information: it could not tell a
//! finished worker from a quitting one, so it erred toward letting go. The cost was measured: of 53
//! idle panes, 20 were silently idle — no `bsc-maintain` (not finished) and no pending `bsc-ask`
//! (nothing to respond to), so nothing in the app could ever wake them.
//!
//! ## What it does instead
//! At Stop the hook already has `$BSC_PLAN_DB` and `$BSC_STREAM`, so it can answer the question that
//! actually matters — *do I still have work?* — rather than guess. That is what makes repeating the
//! bounce safe: "never trap a finished worker" stops being a guess and becomes a fact.
//!
//! The bounce counter **resets when the open-issue count drops**. A worker making progress can bounce
//! indefinitely, which is exactly right — it is working. Only a worker that keeps stopping with
//! *nothing closing* walks up to the cap.
//!
//! ## Why the last rung is not "give up"
//! A hook that silently gives up reproduces the bug it was written to fix. Past the cap the stop IS
//! allowed (never trap), but the pane is announced as `waiting` first — the app reporting an OBSERVED
//! FACT ("stopped with N issues open after M nudges"), not fabricating a question the agent never
//! asked. That single event puts it in `bsc logs waiting`, the Glance attention state, and the
//! director's idle reminder (#4019) — so a stuck worker becomes visible instead of vanishing.

use std::io::Read;

/// The directives, compiled in as the fallback. The session rc normally exports the CONFIG-RESOLVED
/// copies (user-overridable, #2145) — see `defer_prose` in `hook.rs`. Same `include_str!`-from-
/// `src-tauri/data` pattern `bsc-component` uses for the packaged kit.
pub const KEEP_GOING_DEFAULT: &str = include_str!("../../../src-tauri/data/fleet/defer-directive.md");
pub const STUCK_DEFAULT: &str = include_str!("../../../src-tauri/data/fleet/defer-stuck-directive.md");

/// Statuses that mean an issue is DONE. Everything else (`open`, `in_progress`, `blocked`, `failed`)
/// is outstanding work — `failed` included, deliberately: a failed issue is not finished, and a worker
/// stopping on one is exactly the case worth bouncing.
const DONE: &[&str] = &["complete", "verified"];

/// Consecutive stops-with-no-progress before the worker is told it looks stuck. Small: each bounce is
/// a whole extra turn, so the point is to catch a genuine stall quickly, not to grind.
pub const MAX_BOUNCES: u32 = 3;

/// What the hook decides to do with this stop.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    /// Let the worker stop.
    Allow,
    /// Let it stop, but announce the stall first (past the cap).
    AllowAndFlag { open: usize, bounces: u32 },
    /// Block the stop and push it to keep going.
    KeepGoing,
    /// Block the stop and push it to say what is blocking it.
    Stuck,
}

/// The state the decision reads. Separated from the IO so the rule is unit-testable — the whole point
/// of moving this out of shell.
#[derive(Debug, Clone, Copy)]
pub struct DeferState {
    /// Issues owned by this stream that are not done.
    pub open: usize,
    /// Is this pane ALREADY blocked on a human (an unanswered ask, a parked wait, an open request, a
    /// permission prompt)? Then stopping is correct — it is parked, not quitting.
    pub blocked_on_human: bool,
    /// Consecutive prior stops that closed nothing.
    pub bounces: u32,
}

/// The rule. Pure.
pub fn decide(s: DeferState) -> Decision {
    // Finished: nothing owned is outstanding. Same answer the old hook gave, now for a reason.
    if s.open == 0 {
        return Decision::Allow;
    }
    // Parked on a person. Bouncing here would be actively wrong: it would push a worker to "keep
    // going" past the very question it is waiting on, which is how a worker ends up guessing.
    if s.blocked_on_human {
        return Decision::Allow;
    }
    if s.bounces < MAX_BOUNCES {
        return Decision::KeepGoing;
    }
    if s.bounces == MAX_BOUNCES {
        return Decision::Stuck;
    }
    Decision::AllowAndFlag { open: s.open, bounces: s.bounces }
}

/// The persisted counter for one pane: `bounces open`.
///
/// `open` is stored alongside so the NEXT stop can tell progress from spinning — if fewer issues are
/// outstanding than last time, the worker is working and the count resets.
fn counter_path(pane: &str) -> Option<std::path::PathBuf> {
    let safe: String = pane
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Some(bsc_util::bsc_base_dir()?.join("defer").join(format!("{safe}.txt")))
}

fn read_counter(pane: &str) -> (u32, Option<usize>) {
    let Some(p) = counter_path(pane) else { return (0, None) };
    let Ok(raw) = std::fs::read_to_string(&p) else { return (0, None) };
    let mut it = raw.split_whitespace();
    let bounces = it.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    // `None` = no prior count (first stop, or an unreadable file). Deliberately an Option and NOT a
    // `usize::MAX` sentinel: a sentinel makes every real count compare as "fewer than before", so
    // every stop would look like progress and reset the cap forever — silently restoring the
    // never-escalates behaviour this exists to fix. (Written that way first; the test caught it.)
    let open = it.next().and_then(|s| s.parse().ok());
    (bounces, open)
}

fn write_counter(pane: &str, bounces: u32, open: usize) {
    let Some(p) = counter_path(pane) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, format!("{bounces} {open}"));
}

/// Next bounce count: reset on PROGRESS (fewer open than at the last stop), else increment.
///
/// `prev_open: None` means there is nothing to compare against — a first stop, or an unreadable
/// counter. That counts as NO progress, so an unreadable file cannot hold the cap open forever.
pub fn next_bounces(prev_bounces: u32, prev_open: Option<usize>, open: usize) -> u32 {
    match prev_open {
        Some(prev) if open < prev => 0,
        _ => prev_bounces.saturating_add(1),
    }
}

/// Count this stream's outstanding issues. `None` when there is no plan store or no stream to scope to
/// — a non-fleet session, where this hook has no business bouncing anything.
fn open_issues(db: &str, stream: &str) -> Option<usize> {
    if db.is_empty() || stream.is_empty() {
        return None;
    }
    let store = plandb::Store::open(std::path::Path::new(db)).ok()?;
    let issues = store.list(None, Some(stream)).ok()?;
    Some(issues.iter().filter(|i| !DONE.contains(&i.status.as_str())).count())
}

/// `bsc hook stop-defer`: decide whether this worker may end its turn.
///
/// FAIL-OPEN throughout. Every uncertain path allows the stop, because the failure modes are not
/// symmetric: wrongly allowing costs one idle worker that the director's reminder and the waiting
/// queue will surface anyway, while wrongly blocking traps a session in a loop it cannot leave.
pub fn stop_defer(keep_going: &str, stuck: &str) -> Result<(), String> {
    let mut input = String::new();
    let _ = std::io::stdin().read_to_string(&mut input);

    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_default();
    let db = std::env::var("BSC_PLAN_DB").unwrap_or_default();
    let stream = std::env::var("BSC_STREAM").unwrap_or_default();

    // No plan store / no stream ⇒ not a fleet worker with owned issues. Allow, as before.
    let Some(open) = open_issues(&db, &stream) else { return Ok(()) };

    let (prev_bounces, prev_open) = read_counter(&pane);
    let bounces = next_bounces(prev_bounces, prev_open, open);

    let blocked_on_human = bsc_util::bsc_base_dir()
        .map(|d| logs::waiting::waiting(&d).iter().any(|w| w.pane == pane))
        .unwrap_or(false);

    let decision = decide(DeferState { open, blocked_on_human, bounces });

    // Persist BEFORE acting, so a crash mid-decision cannot re-run the same bounce forever.
    write_counter(&pane, bounces, open);

    match decision {
        Decision::Allow => Ok(()),
        Decision::KeepGoing => {
            print!("{}", block_json(keep_going));
            Ok(())
        }
        Decision::Stuck => {
            print!("{}", block_json(stuck));
            Ok(())
        }
        Decision::AllowAndFlag { open, bounces } => {
            // The app speaking a FACT it observed, not a question the agent asked.
            emit_waiting(&pane, &format!(
                "stopped with {open} issue(s) still open after {bounces} nudges — no progress"
            ));
            Ok(())
        }
    }
}

/// Claude Code's Stop-hook block payload. The reason is JSON-string-escaped.
fn block_json(reason: &str) -> String {
    let esc = reason.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', " ");
    format!("{{\"decision\":\"block\",\"reason\":\"{esc}\"}}")
}

/// Append a coord `waiting` record for this pane, byte-identical to `bsc-wait`'s emitter, so the
/// existing readers (`bsc logs waiting`, the Glance attention state, the director reminder) pick it up
/// with no special case.
fn emit_waiting(pane: &str, reason: &str) {
    use std::io::Write;
    let Ok(path) = std::env::var("BSC_COORD_LOG") else { return };
    if path.is_empty() {
        return;
    }
    let clean = |s: &str| s.replace(['\t', '\n', '\r'], " ");
    let line = format!("{}\t{}\twaiting\t{}\t\n", bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms()), clean(pane), clean(reason));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st(open: usize, blocked_on_human: bool, bounces: u32) -> DeferState {
        DeferState { open, blocked_on_human, bounces }
    }

    #[test]
    fn a_finished_worker_is_never_trapped() {
        // The invariant the old one-shot existed to protect. It still holds — but now because the hook
        // KNOWS the worker is finished, rather than because it gave up after one try.
        assert_eq!(decide(st(0, false, 0)), Decision::Allow);
        assert_eq!(decide(st(0, false, 99)), Decision::Allow, "even past the cap");
    }

    #[test]
    fn a_worker_with_work_left_is_bounced_past_the_first_stop() {
        // The whole bug: the old hook allowed the SECOND stop unconditionally.
        assert_eq!(decide(st(3, false, 0)), Decision::KeepGoing);
        assert_eq!(decide(st(3, false, 1)), Decision::KeepGoing);
        assert_eq!(decide(st(3, false, MAX_BOUNCES - 1)), Decision::KeepGoing);
    }

    #[test]
    fn a_worker_parked_on_a_human_is_allowed_to_stop() {
        // Bouncing here would be actively wrong — it would push the worker past the very question it
        // is waiting on, which is how a worker ends up guessing instead of asking.
        assert_eq!(decide(st(5, true, 0)), Decision::Allow);
        assert_eq!(decide(st(5, true, MAX_BOUNCES + 5)), Decision::Allow);
    }

    #[test]
    fn at_the_cap_it_is_told_it_looks_stuck() {
        assert_eq!(decide(st(2, false, MAX_BOUNCES)), Decision::Stuck);
    }

    #[test]
    fn past_the_cap_it_is_released_but_flagged() {
        // Never trap — but never give up SILENTLY either: giving up quietly is the original bug.
        assert_eq!(
            decide(st(2, false, MAX_BOUNCES + 1)),
            Decision::AllowAndFlag { open: 2, bounces: MAX_BOUNCES + 1 }
        );
    }

    #[test]
    fn progress_resets_the_counter_so_a_working_worker_bounces_forever() {
        // The property that makes repeating the bounce safe: only a worker closing NOTHING walks up
        // to the cap. One that keeps landing issues is working, and should never be told it is stuck.
        assert_eq!(next_bounces(2, Some(5), 4), 0, "one issue closed ⇒ reset");
        assert_eq!(next_bounces(9, Some(5), 1), 0, "several closed ⇒ reset");
    }

    #[test]
    fn no_progress_increments() {
        assert_eq!(next_bounces(0, Some(5), 5), 1);
        assert_eq!(next_bounces(2, Some(5), 5), 3);
        assert_eq!(next_bounces(2, Some(5), 6), 3, "MORE open than before is not progress");
    }

    #[test]
    fn an_unknown_prior_count_reads_as_no_progress() {
        // A missing/corrupt counter must not read as progress: that would reset the cap on every stop
        // and silently restore the never-escalates behaviour. This failed when `prev_open` was a
        // `usize::MAX` sentinel — every real count is "less than" it, so everything looked like
        // progress. The Option is the fix.
        assert_eq!(next_bounces(2, None, 5), 3);
        assert_eq!(next_bounces(0, None, 99), 1);
    }

    #[test]
    fn the_block_payload_is_valid_json_with_an_escaped_reason() {
        // It is printed raw into Claude Code's Stop-hook channel; a stray quote or newline in the
        // externalized directive prose would make it unparseable and the block would be lost.
        let j = block_json("say \"hi\"\nand a \\ backslash");
        let v: serde_json::Value = serde_json::from_str(&j).expect("valid JSON");
        assert_eq!(v["decision"], "block");
        assert_eq!(v["reason"], "say \"hi\" and a \\ backslash");
    }
}
