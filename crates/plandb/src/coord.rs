//! Coord-log emission from the `bsc plan` CLI (#4001).
//!
//! Every other coordination signal is emitted by a pure-shell helper in `data/shell/coord-emit.sh`
//! (`bsc-ask`, `bsc-wait`, `bsc-brief`, …). A request cannot be, for one reason: the notification has
//! to carry the **id** the store just assigned, and only the process that performed the insert knows
//! it. Splitting it — CLI writes the row, a shell helper announces it — would let the two drift, and
//! the failure mode is the bad one: a request filed and never announced sits in plan.db forever while
//! the director has no idea it exists.
//!
//! ## Two stores, two jobs (this is deliberate, not duplication)
//! - `plan.db` is the RECORD: durable, contractual, survives the log rotating and the app restarting.
//! - `coord.log` is the NOTIFICATION: what `useDirectorPump` re-derives its pending set from every
//!   tick, so a request is delivered even if it was filed before the pump saw the director, or across
//!   a restart.
//!
//! That is the same division `bsc-issue`/`bsc-assign` already use alongside plan.db issues. Because
//! the pump decides "still pending" from the LOG, both ends must be announced — filing and resolving
//! — or a resolved request would be re-surfaced to the director forever.
//!
//! ## Format
//! Byte-identical to `__bsc_coord` in `coord-emit.sh`: `ts \t pane \t kind \t a \t b`, with a
//! UTC RFC3339-ish timestamp. Tabs and newlines are stripped from the free-text fields, exactly as
//! the shell helpers do with `tr '\t\n' '  '` — a raw newline in a request body would otherwise
//! terminate the record early and corrupt the next line of the log.
//!
//! Silent no-op when `$BSC_COORD_LOG` is unset (a CLI run outside a session), again matching the
//! shell helpers: coordination is best-effort and must never fail the write it accompanies.

use std::io::Write;

/// The coord kind announcing a newly-filed project request.
pub const KIND_REQUEST: &str = "request";
/// The coord kind announcing that a request was answered, so the pump stops surfacing it.
pub const KIND_REQUEST_RESOLVED: &str = "request-resolved";

/// Strip the field separators, matching the shell emitters' `tr '\t\n' '  '`.
fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect()
}

/// UTC timestamp in the shell helpers' shape (`date -u +%Y-%m-%dT%H:%M:%SZ`).
///
/// Hand-rolled from the epoch rather than pulling a date crate: `plandb` has no time dependency and
/// this is the only place in the crate that needs one. Civil-date conversion is the standard
/// days-from-epoch algorithm; it is only ever read by a human, since the pump keys on the log line.
fn now_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Append one coord record. Best-effort: any failure is swallowed, because a coordination
/// notification must never break the store write it accompanies.
pub fn emit(kind: &str, a: &str, b: &str) {
    let Ok(path) = std::env::var("BSC_COORD_LOG") else { return };
    if path.is_empty() {
        return;
    }
    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
    let line = format!("{}\t{}\t{}\t{}\t{}\n", now_utc(), clean(&pane), kind, clean(a), clean(b));
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn field_separators_are_stripped_from_free_text() {
        // A raw newline in a request body would terminate the record early and corrupt the FOLLOWING
        // line of the shared log — the failure would show up as a mis-parsed unrelated event.
        assert_eq!(clean("a\tb\nc\rd"), "a b c d");
        assert!(!clean("multi\nline\tbody").contains('\n'));
    }

    #[test]
    fn the_timestamp_matches_the_shell_emitters_shape() {
        let ts = now_utc();
        assert_eq!(ts.len(), 20, "YYYY-MM-DDTHH:MM:SSZ");
        assert!(ts.ends_with('Z'));
        assert_eq!(ts.as_bytes()[4], b'-');
        assert_eq!(ts.as_bytes()[10], b'T');
        assert!(ts.starts_with("20"), "a sane year, not an epoch-0 fallback: {ts}");
    }

    #[test]
    fn emitting_without_a_coord_log_is_a_silent_no_op() {
        // A `bsc plan` run outside a session has no $BSC_COORD_LOG. It must not fail — the store
        // write it accompanies has already succeeded by this point.
        let prev = std::env::var("BSC_COORD_LOG").ok();
        // SAFETY: single-threaded test; restored below.
        unsafe { std::env::remove_var("BSC_COORD_LOG") };
        emit(KIND_REQUEST, "1", "no develop branch");
        if let Some(p) = prev {
            unsafe { std::env::set_var("BSC_COORD_LOG", p) };
        }
    }
}
