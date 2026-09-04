//! WHEN something was observed, and therefore whether you may believe it.

use serde::{Deserialize, Serialize};

/// How long an observation stays believable by default: five minutes.
///
/// Chosen to be shorter than a human's sense of "just now" rather than tuned to any one source. A
/// budget that is too SHORT costs an extra probe; one that is too LONG presents a dead host as live,
/// which is the failure this module exists to prevent. When they conflict, prefer the extra probe.
pub const DEFAULT_BUDGET_MS: u64 = 5 * 60 * 1000;

/// A reading taken from a real system at a real time.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct Observation {
    /// What was seen — `"current"`, `"unreachable"`, a version, a health line.
    pub state: String,
    /// When, in epoch milliseconds. `None` means NEVER OBSERVED, which is not the same as "observed
    /// and found empty" and must never collapse into it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at_ms: Option<u64>,
}

impl Observation {
    /// A reading taken now.
    pub fn seen(state: impl Into<String>, at_ms: u64) -> Self {
        Observation { state: state.into(), at_ms: Some(at_ms) }
    }

    /// Never looked. Distinct from every other value here.
    pub fn never() -> Self {
        Observation { state: String::new(), at_ms: None }
    }
}

/// Whether an observation may still be believed.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Freshness {
    /// Within budget. The state is the answer.
    Fresh,
    /// Observed, but too long ago to present as current.
    Stale,
    /// Never observed at all.
    Never,
}

impl Freshness {
    /// Read an observation against a budget.
    ///
    /// A reading from the FUTURE is `Fresh`, not an error: clocks disagree across machines, and a
    /// device whose clock runs a minute ahead must not have its perfectly good answer discarded. The
    /// direction that matters is the old one.
    pub fn of(obs: &Observation, now_ms: u64, budget_ms: u64) -> Freshness {
        match obs.at_ms {
            None => Freshness::Never,
            Some(at) if now_ms.saturating_sub(at) > budget_ms => Freshness::Stale,
            Some(_) => Freshness::Fresh,
        }
    }

    /// May a reader present this state as the current truth?
    pub fn is_believable(self) -> bool {
        matches!(self, Freshness::Fresh)
    }
}

/// The state to SHOW, which is not always the state that was read.
///
/// This is the single place the freshness rule becomes visible, so a renderer and a serializer cannot
/// apply it differently — and neither can forget it, which is the actual risk. A caller that wants the
/// raw reading can still have it from [`Observation::state`]; this is what any DISPLAY must use.
pub fn presented_state(obs: &Observation, now_ms: u64, budget_ms: u64) -> String {
    match Freshness::of(obs, now_ms, budget_ms) {
        Freshness::Fresh => obs.state.clone(),
        // Both say "unknown", and they say WHY differently, because the operator's next move differs:
        // a stale reading means go and look again; never-observed means nothing has ever looked.
        Freshness::Stale => "unknown (stale)".to_string(),
        Freshness::Never => "unknown (never observed)".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: u64 = 1_000_000_000;

    #[test]
    fn a_recent_reading_is_fresh_and_shows_its_state() {
        let o = Observation::seen("current", NOW - 1000);
        assert_eq!(Freshness::of(&o, NOW, DEFAULT_BUDGET_MS), Freshness::Fresh);
        assert_eq!(presented_state(&o, NOW, DEFAULT_BUDGET_MS), "current");
    }

    #[test]
    fn a_reading_past_its_budget_shows_unknown_not_its_last_value() {
        // THE POINT OF THE MODULE. `context.md` presented seven-week-old facts as current and sent a
        // model at a dead host. An old reading must not render as the answer.
        let o = Observation::seen("current", NOW - DEFAULT_BUDGET_MS - 1);
        assert_eq!(Freshness::of(&o, NOW, DEFAULT_BUDGET_MS), Freshness::Stale);
        assert!(presented_state(&o, NOW, DEFAULT_BUDGET_MS).starts_with("unknown"));
        assert_eq!(o.state, "current", "the raw reading is still available to a caller that wants it");
    }

    #[test]
    fn never_observed_and_observed_stale_are_different_answers() {
        // They both mean "do not believe this", but the operator's next move differs: one says look
        // again, the other says nothing has ever looked. Collapsing them hides which.
        let stale = Observation::seen("current", NOW - DEFAULT_BUDGET_MS - 1);
        let never = Observation::never();
        assert_ne!(Freshness::of(&stale, NOW, DEFAULT_BUDGET_MS), Freshness::of(&never, NOW, DEFAULT_BUDGET_MS));
        assert_ne!(presented_state(&stale, NOW, DEFAULT_BUDGET_MS), presented_state(&never, NOW, DEFAULT_BUDGET_MS));
    }

    #[test]
    fn an_empty_state_observed_is_not_the_same_as_never_observed() {
        // "I looked and there was nothing" is a real answer; "I never looked" is not. A reader that
        // treats them alike cannot tell a working-but-idle system from an unmonitored one.
        let looked = Observation::seen("", NOW);
        assert_eq!(Freshness::of(&looked, NOW, DEFAULT_BUDGET_MS), Freshness::Fresh);
        assert_eq!(Freshness::of(&Observation::never(), NOW, DEFAULT_BUDGET_MS), Freshness::Never);
    }

    #[test]
    fn a_clock_that_runs_ahead_does_not_discard_a_good_reading() {
        // Machines disagree about the time. Losing a device's answer because its clock is a minute
        // fast would be a self-inflicted outage; the direction that matters is OLD, not future.
        let o = Observation::seen("current", NOW + 60_000);
        assert_eq!(Freshness::of(&o, NOW, DEFAULT_BUDGET_MS), Freshness::Fresh);
    }

    #[test]
    fn exactly_at_the_budget_is_still_fresh() {
        // Pinned so the boundary cannot drift silently between a renderer and a serializer.
        let o = Observation::seen("current", NOW - DEFAULT_BUDGET_MS);
        assert_eq!(Freshness::of(&o, NOW, DEFAULT_BUDGET_MS), Freshness::Fresh);
    }

    #[test]
    fn only_fresh_is_believable() {
        assert!(Freshness::Fresh.is_believable());
        assert!(!Freshness::Stale.is_believable());
        assert!(!Freshness::Never.is_believable());
    }
}
