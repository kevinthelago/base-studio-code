//! The pure arithmetic behind every `bsc mem` report — no store, no I/O, so the decisions that matter
//! are unit-testable without a database.

use serde::Serialize;

/// A summary of one set of measurements.
///
/// Every field is `Option` for the same reason the underlying columns are: an ABSENT measurement is
/// not a zero. A set with no readings reports `n: 0` and nothing else, rather than a median of 0 that
/// a reader would take for a very fast build.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// How many rows were considered — including the ones that carried no reading.
    pub n: usize,
    /// How many of those actually carried a reading. `n - measured` is the unmeasured remainder, and
    /// it is reported rather than hidden: a summary over 2 readings out of 40 rows is a different
    /// claim from one over 40, and collapsing them would let a confident number rest on almost nothing.
    pub measured: usize,
    pub median: Option<i64>,
    pub worst: Option<i64>,
    pub latest: Option<i64>,
}

/// Summarize readings given NEWEST FIRST, which is the order the store returns.
///
/// `latest` is therefore the first element, not the largest timestamp — the caller has already ordered
/// them and re-deriving it here would be a second opinion about ordering that could disagree.
pub fn summarize(newest_first: &[Option<i64>]) -> Summary {
    let mut vals: Vec<i64> = newest_first.iter().filter_map(|v| *v).collect();
    let summary = Summary {
        n: newest_first.len(),
        measured: vals.len(),
        latest: newest_first.iter().find_map(|v| *v),
        worst: vals.iter().copied().max(),
        median: median(&mut vals),
    };
    summary
}

/// The median of a set, or `None` when it is empty.
///
/// MEDIAN AND NOT MEAN, deliberately. Build times are dominated by whether the cache was warm: a cold
/// first build is minutes against seconds, and a single one of those drags a mean far enough to hide a
/// real regression in every run after it. The median is what makes a trend readable across a mix of
/// warm and cold runs, which is the only mix that ever actually occurs.
///
/// An even-sized set takes the LOWER of the two middles rather than averaging them, so the reported
/// number is always one that was really observed.
pub fn median(vals: &mut [i64]) -> Option<i64> {
    if vals.is_empty() {
        return None;
    }
    vals.sort_unstable();
    Some(vals[(vals.len() - 1) / 2])
}

/// One half of a [`compare`], named so an ABSENT half can say so.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Half {
    /// No rows fell in this half at all.
    ///
    /// REPORTED, NEVER FOLDED INTO ZERO. An empty window is not a fast one — it is a window nothing
    /// was measured in, and the two mean opposite things to someone deciding whether a change helped.
    /// `bsc perf compare` states the same rule; this is the same rule for the same reason.
    Absent,
    Present(Summary),
}

/// Split readings at a boundary and summarize both halves.
///
/// `at` is inclusive of the AFTER half: a reading exactly at the boundary belongs to the change, not
/// to the state before it. Timestamps are epoch ms, and the rows arrive newest first.
pub fn compare(rows: &[(i64, Option<i64>)], at: i64) -> (Half, Half) {
    let half = |take_after: bool| {
        let vals: Vec<Option<i64>> =
            rows.iter().filter(|(ts, _)| (*ts >= at) == take_after).map(|(_, v)| *v).collect();
        if vals.is_empty() {
            Half::Absent
        } else {
            Half::Present(summarize(&vals))
        }
    };
    (half(false), half(true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_median_is_a_value_that_was_actually_observed() {
        assert_eq!(median(&mut [10, 20]), Some(10), "an even set takes the lower middle, not an average");
        assert_eq!(median(&mut [30, 10, 20]), Some(20));
        assert_eq!(median(&mut []), None);
    }

    /// The reason the median is the median: one cold build must not move the trend.
    #[test]
    fn a_single_cold_build_does_not_drag_the_median_the_way_a_mean_would() {
        let warm_with_one_cold = [Some(20), Some(21), Some(19), Some(22), Some(600)];
        let s = summarize(&warm_with_one_cold);
        assert_eq!(s.median, Some(21), "the cold 600s run is an outlier, not the story");
        assert_eq!(s.worst, Some(600), "and it is still reported as the worst, never hidden");
    }

    /// An unmeasured row is COUNTED but not averaged — the caller can see the summary rests on 2 of 4.
    #[test]
    fn unmeasured_rows_are_counted_and_reported_rather_than_silently_dropped() {
        let s = summarize(&[None, Some(10), None, Some(30)]);
        assert_eq!((s.n, s.measured), (4, 2), "4 rows, 2 of them measured — both are stated");
        assert_eq!(s.median, Some(10));
        assert_eq!(s.latest, Some(10), "latest is the newest row that HAS a reading");
    }

    /// A set with no readings at all reports nothing rather than zero.
    #[test]
    fn a_set_with_no_readings_reports_absent_values_not_zeroes() {
        let s = summarize(&[None, None]);
        assert_eq!((s.n, s.measured), (2, 0));
        assert_eq!((s.median, s.worst, s.latest), (None, None, None));
        assert_ne!(s.median, Some(0), "absent and zero are different answers");
    }

    /// AN EMPTY HALF IS ABSENT, never zero. This is the whole discipline of the compare verb: a change
    /// with no measurements after it has not been shown to help.
    #[test]
    fn an_empty_half_is_absent_not_a_fast_one() {
        let rows = [(100, Some(50)), (90, Some(60))];
        let (before, after) = compare(&rows, 500);
        assert!(matches!(before, Half::Present(_)));
        assert_eq!(after, Half::Absent, "nothing measured after the boundary is not an improvement");
    }

    /// The boundary belongs to the AFTER half — a reading taken exactly at the change is the change's.
    #[test]
    fn the_boundary_reading_belongs_to_the_after_half() {
        let rows = [(200, Some(10)), (100, Some(90))];
        let (before, after) = compare(&rows, 200);
        assert_eq!(before, Half::Present(Summary { n: 1, measured: 1, median: Some(90), worst: Some(90), latest: Some(90) }));
        assert_eq!(after, Half::Present(Summary { n: 1, measured: 1, median: Some(10), worst: Some(10), latest: Some(10) }));
    }
}
