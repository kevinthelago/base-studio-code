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
/// A tier-to-tier BRIEF (#2377) — under the three-tier funnel this is the architect's ONE outbound
/// channel (#funnel-generalize-brief-channel). Its payload is three fields (target, body, optional
/// ref), so it emits through [`emit3`] rather than the two-field [`emit`].
///
/// It exists as a `bsc` VERB, not only as the `bsc-brief` shell helper, because a restricted session's
/// allow-list may hold nothing but `bsc ` store verbs — a shell function on that surface would break
/// the invariant `sessionRoles.test.ts` pins. The helper stays for unrestricted senders.
pub const KIND_BRIEF: &str = "brief";
/// The coord kind announcing that a request was answered, so the pump stops surfacing it.
pub const KIND_REQUEST_RESOLVED: &str = "request-resolved";

/// Strip the field separators, matching the shell emitters' `tr '\t\n' '  '`.
fn clean(s: &str) -> String {
    s.chars().map(|c| if c == '\t' || c == '\n' || c == '\r' { ' ' } else { c }).collect()
}

/// Append one coord record. Best-effort: any failure is swallowed, because a coordination
/// notification must never break the store write it accompanies.
pub fn emit(kind: &str, a: &str, b: &str) {
    emit_fields(kind, &[a, b]);
}

/// Append one coord record with THREE payload fields — the shape a `brief` line takes
/// (`<target>`, `<body>`, `<ref?>`). [`emit`] is the two-field case; both go through
/// [`emit_fields`], so there is one implementation and the records cannot drift apart.
pub fn emit3(kind: &str, a: &str, b: &str, c: &str) {
    emit_fields(kind, &[a, b, c]);
}

/// The one writer. Best-effort: any failure is swallowed, because a coordination notification must
/// never break the store write it accompanies.
fn emit_fields(kind: &str, payload: &[&str]) {
    let Ok(path) = std::env::var("BSC_COORD_LOG") else { return };
    if path.is_empty() {
        return;
    }
    let pane = std::env::var("BSC_AUDIT_PANE").unwrap_or_else(|_| "?".into());
    let mut line = format!("{}\t{}\t{}", bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms()), clean(&pane), kind);
    for f in payload {
        line.push('\t');
        line.push_str(&clean(f));
    }
    line.push('\n');
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #funnel-generalize-brief-channel — a brief carries THREE payload fields (target, body, ref),
    /// so its record must have six columns. The frontend parser reads the ref at `rest[2]`; emitting
    /// it through the two-field [`emit`] would silently drop it and every architect brief would
    /// arrive ref-less — a loss nothing downstream could detect.
    #[test]
    fn a_brief_emits_three_payload_fields() {
        let dir = std::env::temp_dir().join(format!("bsc-coord3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("coord.log");
        let prev = std::env::var("BSC_COORD_LOG").ok();
        std::env::set_var("BSC_COORD_LOG", &log);
        emit3(KIND_BRIEF, "proj:director", "ship the auth slice", "#42");
        let body = std::fs::read_to_string(&log).unwrap_or_default();
        match prev {
            Some(p) => std::env::set_var("BSC_COORD_LOG", p),
            None => std::env::remove_var("BSC_COORD_LOG"),
        }
        let _ = std::fs::remove_dir_all(&dir);

        let cols: Vec<&str> = body.trim_end().split('\t').collect();
        assert_eq!(cols.len(), 6, "ts, pane, kind + three payload fields: {body:?}");
        assert_eq!(cols[2], "brief");
        assert_eq!(cols[3], "proj:director");
        assert_eq!(cols[5], "#42", "the ref must survive — it is the third payload field");
    }

    #[test]
    fn field_separators_are_stripped_from_free_text() {
        // A raw newline in a request body would terminate the record early and corrupt the FOLLOWING
        // line of the shared log — the failure would show up as a mis-parsed unrelated event.
        assert_eq!(clean("a\tb\nc\rd"), "a b c d");
        assert!(!clean("multi\nline\tbody").contains('\n'));
    }

    /// The coord log is parsed positionally by BOTH the frontend reducer and `bsc logs waiting`, so a
    /// timestamp in the wrong shape corrupts every consumer. Pinned here even though the formatting is
    /// now the shared helper's job (#4021 dropped a hand-rolled duplicate of it that lived here).
    #[test]
    fn the_timestamp_matches_the_shell_emitters_shape() {
        let ts = bsc_util::epoch_ms_to_iso8601(bsc_util::now_ms());
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
