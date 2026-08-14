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
/// A brief was RECONCILED by its receiver (#a-brief-can-be-acknowledged-so-its-queue-empties). Without
/// a closing event a brief queue can never empty, and the receiver is re-handed the same plan updates
/// forever — the failure `logs-waiting-honours-every-clearing-event` fixed for asks after two weeks.
pub const KIND_BRIEF_ACK: &str = "brief-ack";

/// One brief still awaiting acknowledgement.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenBrief {
    /// `<from>@<ts>@<target>` — DERIVED from the row, so no new storage and the log stays append-only.
    /// It includes the target because a sender can brief two different panes in the same second; keying
    /// on `<from>@<ts>` alone would collide and silently suppress the second (the bug `briefRouteKey`
    /// was widened to fix).
    pub id: String,
    pub from: String,
    pub target: String,
    pub body: String,
    pub at: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub reference: String,
}

/// The briefs that have been sent and not yet acked, oldest first.
///
/// Re-derived from the WHOLE log on every call, exactly as the ask queue is: the answer is then correct
/// across an app restart and does not depend on having observed the opening event live.
pub fn open_briefs(log: &std::path::Path) -> Vec<OpenBrief> {
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let mut open: Vec<OpenBrief> = Vec::new();
    let mut acked: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        // ts, pane, kind, then the payload
        if f.len() < 4 {
            continue;
        }
        let (at, from, kind) = (f[0], f[1], f[2]);
        match kind {
            KIND_BRIEF if f.len() >= 5 => {
                let target = f[3];
                open.push(OpenBrief {
                    id: brief_id(from, at, target),
                    from: from.to_string(),
                    target: target.to_string(),
                    body: f[4].to_string(),
                    at: at.to_string(),
                    reference: f.get(5).unwrap_or(&"").to_string(),
                });
            }
            KIND_BRIEF_ACK => {
                acked.insert(f[3].to_string());
            }
            _ => {}
        }
    }
    open.retain(|b| !acked.contains(&b.id));
    open
}

/// The derived identity of a brief row. Public so the emitter can PRINT it — a sender that cannot name
/// what it just sent has no way to ask about it later.
pub fn brief_id(from: &str, at: &str, target: &str) -> String {
    format!("{from}@{at}@{target}")
}

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

    /// A brief queue that cannot empty re-hands the receiver the same plan updates forever — the exact
    /// failure `logs-waiting-honours-every-clearing-event` fixed for asks after two weeks unnoticed.
    #[test]
    fn an_ack_closes_exactly_its_own_brief_and_the_close_survives_a_restart() {
        let dir = std::env::temp_dir().join(format!("bsc-briefq-{}-a", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("coord.log");
        std::fs::write(
            &log,
            "2026-08-14T10:00:00Z	architect	brief	p:director	descope CSV	#42
             2026-08-14T10:00:01Z	architect	brief	p:director	add audit log	
",
        )
        .unwrap();

        let open = open_briefs(&log);
        assert_eq!(open.len(), 2, "both are awaiting ack: {open:?}");
        assert_eq!(open[0].reference, "#42", "the --ref rides the row");

        // Ack ONLY the first. The pairing is re-derived from the whole log, so this holds across a
        // restart — the queue does not depend on having watched the brief arrive.
        let first = open[0].id.clone();
        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        use std::io::Write as _;
        writeln!(f, "2026-08-14T10:05:00Z	p:director	brief-ack	{first}	dropped the CSV issues").unwrap();

        let after = open_briefs(&log);
        assert_eq!(after.len(), 1, "exactly one closed: {after:?}");
        assert_eq!(after[0].body, "add audit log", "the OTHER brief is untouched");
    }

    /// The id carries the TARGET for a reason: a sender can brief two panes within the same second, and
    /// keying on `<from>@<ts>` alone would collide — acking one would silently close the other. This is
    /// the same widening `briefRouteKey` needed on the frontend.
    #[test]
    fn two_briefs_in_the_same_second_to_different_targets_do_not_collide() {
        let dir = std::env::temp_dir().join(format!("bsc-briefq-{}-b", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("coord.log");
        std::fs::write(
            &log,
            "2026-08-14T10:00:00Z	architect	brief	a:director	for a	
             2026-08-14T10:00:00Z	architect	brief	b:director	for b	
",
        )
        .unwrap();
        let open = open_briefs(&log);
        assert_eq!(open.len(), 2);
        assert_ne!(open[0].id, open[1].id, "same sender, same second, different target: {open:?}");
    }

    #[test]
    fn a_malformed_or_unrelated_row_is_skipped_rather_than_panicking() {
        // coord.log is one APP-WIDE append-only file every emitter writes to, so a brief reader meets
        // rows it does not understand constantly — and a rotated log can truncate one mid-line.
        let dir = std::env::temp_dir().join(format!("bsc-briefq-{}-c", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("coord.log");
        std::fs::write(
            &log,
            "2026-08-14T10:00:00Z	w	ask	which branch?
             short
             
             2026-08-14T10:00:02Z	architect	brief	p:director	real one	
",
        )
        .unwrap();
        let open = open_briefs(&log);
        assert_eq!(open.len(), 1, "only the brief: {open:?}");
        assert_eq!(open[0].body, "real one");
    }
}
