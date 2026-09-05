//! What the ear is allowed to keep — the pure half.
//!
//! This is the file that makes always-on capture defensible. The maintainer's decision was a short
//! rolling window: enough audio to re-transcribe a stretch with a better model later, never an
//! indefinite recording of the room. A bound stated in a README is not a bound, so it is a function
//! here, and the guard runs it against a synthetic over-budget directory.
//!
//! Nothing in this module touches the filesystem. It decides; the caller deletes.

use serde::Serialize;

/// One segment already on disk.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct HeldSegment {
    pub name: String,
    pub bytes: u64,
    /// When the segment STARTED, in unix milliseconds. Age is measured from the start rather than
    /// the end because that is the oldest audio the file contains, and the promise is about how far
    /// back the ear can remember.
    pub started_unix_ms: i64,
}

/// Two independent ceilings, because either alone leaves a hole. Time alone lets a loud room fill
/// the disk inside the window; bytes alone lets a silent week keep audio from last month.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
pub struct Budget {
    pub max_bytes: u64,
    pub max_age_ms: i64,
}

impl Default for Budget {
    /// ~2 hours, and the byte ceiling that holds it at the capture format: 16 kHz mono 16-bit is
    /// 32,000 bytes per second, so two hours is ~230 MB. Rounded up to 256 MB so an ordinary
    /// two-hour window is bounded by TIME, and the byte ceiling only bites when something is wrong.
    fn default() -> Self {
        Budget { max_bytes: 256 * 1024 * 1024, max_age_ms: 2 * 60 * 60 * 1000 }
    }
}

/// Why a segment is going.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Cause {
    /// Older than the window.
    Age,
    /// Inside the window, but the bytes did not fit.
    Size,
}

#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Evicted {
    pub name: String,
    pub cause: Cause,
}

/// The decision: what to delete, and whether it was enough.
#[derive(Clone, PartialEq, Eq, Debug, Serialize)]
pub struct Eviction {
    pub delete: Vec<Evicted>,
    /// Bytes still held afterwards.
    pub kept_bytes: u64,
    /// False when the budget could NOT be met — which happens only when the protected segment
    /// alone exceeds it. Reported rather than resolved by deleting the live recording, because a
    /// retention policy that can delete the file being written to is a data-loss bug wearing a
    /// privacy costume.
    pub under_budget: bool,
}

/// Decide what to evict.
///
/// `protect` is the segment currently being written. It is never evicted, at any age or size.
///
/// **Correct when already over budget at startup**, which is the case that only arises after a
/// crash — precisely when nobody is watching. So eviction is computed from the whole set every
/// time, not applied incrementally as segments arrive.
pub fn plan_eviction(
    now_unix_ms: i64,
    held: &[HeldSegment],
    budget: &Budget,
    protect: Option<&str>,
) -> Eviction {
    let mut candidates: Vec<&HeldSegment> =
        held.iter().filter(|s| Some(s.name.as_str()) != protect).collect();
    // Oldest first — both passes evict in that order, and a stable order also makes the plan
    // reproducible for a test.
    candidates.sort_by(|a, b| {
        a.started_unix_ms.cmp(&b.started_unix_ms).then_with(|| a.name.cmp(&b.name))
    });

    let mut delete: Vec<Evicted> = Vec::new();
    let mut kept: Vec<&HeldSegment> = Vec::new();
    for s in candidates {
        if now_unix_ms.saturating_sub(s.started_unix_ms) > budget.max_age_ms {
            delete.push(Evicted { name: s.name.clone(), cause: Cause::Age });
        } else {
            kept.push(s);
        }
    }

    let protected_bytes: u64 =
        held.iter().filter(|s| Some(s.name.as_str()) == protect).map(|s| s.bytes).sum();
    let mut total: u64 = protected_bytes + kept.iter().map(|s| s.bytes).sum::<u64>();
    let mut i = 0;
    while total > budget.max_bytes && i < kept.len() {
        delete.push(Evicted { name: kept[i].name.clone(), cause: Cause::Size });
        total = total.saturating_sub(kept[i].bytes);
        i += 1;
    }

    Eviction { delete, kept_bytes: total, under_budget: total <= budget.max_bytes }
}

/// Bytes per second of the capture format, for turning a duration into a byte ceiling.
pub const BYTES_PER_SECOND: u64 = 16_000 * 2;

/// The byte ceiling that holds `seconds` of audio at the capture format.
pub fn bytes_for_seconds(seconds: u64) -> u64 {
    seconds.saturating_mul(BYTES_PER_SECOND)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000_000;
    const MB: u64 = 1024 * 1024;

    fn seg(name: &str, mb: u64, age_min: i64) -> HeldSegment {
        HeldSegment {
            name: name.into(),
            bytes: mb * MB,
            started_unix_ms: NOW - age_min * 60 * 1000,
        }
    }

    fn names(e: &Eviction) -> Vec<&str> {
        e.delete.iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn nothing_is_evicted_when_everything_fits() {
        let held = vec![seg("a", 10, 5), seg("b", 10, 30)];
        let e = plan_eviction(NOW, &held, &Budget::default(), None);
        assert!(e.delete.is_empty(), "{e:?}");
        assert!(e.under_budget);
        assert_eq!(e.kept_bytes, 20 * MB);
    }

    #[test]
    fn anything_past_the_window_goes_however_small_it_is() {
        // 1 MB total — nowhere near the byte ceiling. Only age can evict these.
        let held = vec![seg("old", 1, 200), seg("recent", 1, 5)];
        let e = plan_eviction(NOW, &held, &Budget::default(), None);
        assert_eq!(names(&e), vec!["old"], "200 minutes is past the 2h window");
        assert_eq!(e.delete[0].cause, Cause::Age);
    }

    #[test]
    fn inside_the_window_the_oldest_go_first_until_the_bytes_fit() {
        let budget = Budget { max_bytes: 25 * MB, max_age_ms: 2 * 60 * 60 * 1000 };
        let held = vec![seg("newest", 10, 1), seg("oldest", 10, 50), seg("middle", 10, 20)];
        let e = plan_eviction(NOW, &held, &budget, None);
        assert_eq!(names(&e), vec!["oldest"], "one is enough to get under: {e:?}");
        assert_eq!(e.kept_bytes, 20 * MB);
        assert!(e.under_budget);
    }

    /// THE CASE THAT ONLY HAPPENS AFTER A CRASH, which is exactly when nobody is watching. The plan
    /// is computed over the whole set every time rather than applied incrementally, so a process
    /// that starts up staring at a directory already far over budget still converges in one pass.
    #[test]
    fn a_directory_already_far_over_budget_at_startup_is_brought_back_in_one_pass() {
        let budget = Budget { max_bytes: 30 * MB, max_age_ms: 2 * 60 * 60 * 1000 };
        let held: Vec<HeldSegment> =
            (0..100).map(|i| seg(&format!("s{i:03}"), 5, 100 - i as i64)).collect();
        let e = plan_eviction(NOW, &held, &budget, None);
        assert!(e.under_budget, "one pass must be enough: kept {} bytes", e.kept_bytes);
        assert!(e.kept_bytes <= budget.max_bytes);
        // And it kept the NEWEST, not an arbitrary six.
        let deleted: Vec<&str> = names(&e);
        assert!(!deleted.contains(&"s099"), "the newest must survive: {deleted:?}");
        assert!(deleted.contains(&"s000"), "the oldest must not");
    }

    /// A retention policy that can delete the file being written to is a data-loss bug wearing a
    /// privacy costume.
    #[test]
    fn the_segment_being_written_is_never_evicted_at_any_age_or_size() {
        let budget = Budget { max_bytes: 1, max_age_ms: 0 };
        let held = vec![seg("live", 50, 999), seg("other", 50, 999)];
        let e = plan_eviction(NOW, &held, &budget, Some("live"));
        assert_eq!(names(&e), vec!["other"], "only the unprotected one goes: {e:?}");
    }

    /// When the live segment alone busts the budget the honest answer is to say so, not to delete
    /// the recording in progress.
    #[test]
    fn an_unmeetable_budget_is_reported_rather_than_met_by_deleting_the_live_recording() {
        let budget = Budget { max_bytes: MB, max_age_ms: 2 * 60 * 60 * 1000 };
        let held = vec![seg("live", 50, 0)];
        let e = plan_eviction(NOW, &held, &budget, Some("live"));
        assert!(e.delete.is_empty(), "nothing else to give: {e:?}");
        assert!(!e.under_budget, "and it must ADMIT it is over");
        assert_eq!(e.kept_bytes, 50 * MB);
    }

    #[test]
    fn age_and_size_are_reported_separately_so_a_wrong_ceiling_is_identifiable() {
        let budget = Budget { max_bytes: 10 * MB, max_age_ms: 60 * 60 * 1000 };
        let held = vec![seg("ancient", 1, 300), seg("big1", 20, 5), seg("big2", 20, 3)];
        let e = plan_eviction(NOW, &held, &budget, None);
        let by_cause: Vec<(&str, Cause)> =
            e.delete.iter().map(|d| (d.name.as_str(), d.cause)).collect();
        assert!(by_cause.contains(&("ancient", Cause::Age)), "{by_cause:?}");
        assert!(by_cause.iter().any(|(_, c)| *c == Cause::Size), "{by_cause:?}");
    }

    #[test]
    fn an_empty_directory_is_not_a_special_case() {
        let e = plan_eviction(NOW, &[], &Budget::default(), None);
        assert!(e.delete.is_empty());
        assert_eq!(e.kept_bytes, 0);
        assert!(e.under_budget);
    }

    /// The default is the maintainer's decision, so it is pinned rather than left to drift: about
    /// two hours, with a byte ceiling that does not bite first at the capture format.
    #[test]
    fn the_default_window_is_two_hours_and_time_is_what_binds_it() {
        let b = Budget::default();
        assert_eq!(b.max_age_ms, 2 * 60 * 60 * 1000);
        let two_hours = bytes_for_seconds(2 * 60 * 60);
        assert!(
            b.max_bytes > two_hours,
            "the byte ceiling ({}) must not cut the window short ({two_hours})",
            b.max_bytes
        );
        assert!(b.max_bytes < two_hours * 2, "but must still bound a runaway");
    }
}
