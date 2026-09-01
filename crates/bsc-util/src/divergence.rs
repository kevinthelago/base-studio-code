//! The migration-divergence emitter — the instrument step 7 asks for and did not have.
//!
//! # Why this exists
//!
//! `epic-frontend-logic-over-backend-resources-belongs-in-rust` ends every migration the same way:
//! *"delete the TypeScript only after the disagreement log has been empty in the field."* During a
//! cutover Rust DERIVES a policy the frontend also computes, and the two are reconciled by UNION so
//! the cutover can never weaken anything. When they disagree, that is the signal — and the signal was
//! being spent on a bare `log::warn!`.
//!
//! Which is not nothing: it IS persisted, and it IS readable as raw text. What it is not is
//! ANSWERABLE. The existing call sites are free prose with different wording, share no marker, carry
//! no surface id, and land in an app log that ROTATES. So "has the role gate disagreed in the field?"
//! requires already knowing both phrasings and grepping a file that may have discarded the evidence —
//! and an absence of hits is indistinguishable from a rotation that dropped them. That is exactly the
//! "absence is not evidence" failure, sitting on the criterion the epic uses to decide when deleting
//! code is safe.
//!
//! # The two directions are not symmetric
//!
//! A reconciliation unions, so the caller legitimately carries MORE than the derivation: user and
//! project denylists ride along, and "the frontend has extra" means nothing at all.
//!
//! **Only `derived_only` is a defect** — a value Rust derived that the caller OMITTED, which is the
//! one direction that would have weakened the result had the reconciliation replaced instead of
//! unioned. Both are recorded, because a reader chasing a disagreement wants the whole picture, but
//! they are separate columns so a query can count the defect without the noise.
//!
//! # Contract
//!
//! * **A no-op on agreement.** Both sides equal ⇒ nothing is written and nothing is formatted. The
//!   common path is one comparison of two empty slices.
//! * **A no-op when unwired.** No `$BSC_DIVERGENCE_LOG` ⇒ no write. Reading that back as "never
//!   diverged" is the mistake this module exists to prevent, so the READER reports an absent stream
//!   as UNKNOWN rather than zero — see `logs::divergence`.
//! * **Best-effort.** A write failure is swallowed. Recording a disagreement must never break the
//!   reconciliation it is observing.
//!
//! # Worked example — retrofitting a hand-written warning
//!
//! `src-tauri/src/session/settings.rs` holds the two existing warnings and is NOT edited by this
//! item: it is the highest-conflict file in the repo and its own session owns the retrofit. This is
//! what that adoption looks like, so it is a copy rather than a design exercise.
//!
//! ```text
//! // BEFORE — free prose, no marker, no surface, counted nowhere:
//! if !missing.is_empty() {
//!     log::warn!(
//!         "the frontend's deny list was MISSING {} command(s) the role gate derives: {:?}",
//!         missing.len(), missing,
//!     );
//! }
//!
//! // AFTER — same warning, plus a counted record on its own stream:
//! bsc_util::emit_divergence("role-gate.denied-commands", &missing, &extra);
//! ```
//!
//! Keep the `log::warn!` if you want it in the app log too; they are independent. The surface id is
//! the query key, so it should name the DERIVATION, not the file — `role-gate.denied-commands`,
//! not `settings.rs`.

use std::path::{Path, PathBuf};

use crate::{append_line, epoch_ms_to_iso8601, now_ms};

/// The env var naming the divergence stream. Mirrors the `divergence` row in
/// [`crate::LOG_STREAMS`]; the registry is the source of truth and this is the name to reach for.
pub const DIVERGENCE_ENV: &str = "BSC_DIVERGENCE_LOG";

/// Flatten values into one TSV cell.
///
/// A value is an arbitrary command string or glob, so it can contain a tab or a newline and split the
/// row. Both are collapsed to a space rather than escaped: this cell is read by a human chasing a
/// disagreement, and a mangled value that is still legible beats a correctly-escaped one that needs
/// unescaping to read. `∅` marks the empty side explicitly, so a reader never has to decide whether
/// an empty cell meant "none" or "the writer forgot".
fn cell(values: &[String]) -> String {
    if values.is_empty() {
        return "∅".to_string();
    }
    values.iter().map(|v| v.replace(['\t', '\n', '\r'], " ")).collect::<Vec<_>>().join(",")
}

/// Format one divergence line: `ts · pane · surface · derived_only · caller_only`.
///
/// Pure, so the shape can be tested without touching the filesystem — and the shape is a contract,
/// because `logs::divergence` parses it back.
pub fn divergence_line(
    ts: &str,
    pane: &str,
    surface: &str,
    derived_only: &[String],
    caller_only: &[String],
) -> String {
    format!("{ts}\t{pane}\t{surface}\t{}\t{}\n", cell(derived_only), cell(caller_only))
}

/// Record that a migration's two implementations disagreed on `surface`.
///
/// `derived_only` is what Rust derived and the caller omitted — **the defect direction**.
/// `caller_only` is what the caller carried and Rust did not, which a union legitimately produces.
///
/// A NO-OP when both are empty, so the agreeing path — which is every call once a cutover is
/// healthy — costs one emptiness check and writes nothing.
pub fn emit_divergence(surface: &str, derived_only: &[String], caller_only: &[String]) {
    // The agreement check comes FIRST, before any environment lookup — the healthy path does one
    // comparison of two empty slices and returns.
    if derived_only.is_empty() && caller_only.is_empty() {
        return;
    }
    let path = match std::env::var_os(DIVERGENCE_ENV) {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        // Unwired: a hand shell, a unit test, a CLI invocation outside a session. Writing nowhere is
        // correct; READING that back as "never diverged" is not, and the reader refuses to.
        _ => return,
    };
    let pane =
        std::env::var("BSC_AUDIT_PANE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "?".to_string());
    emit_divergence_to(&path, &pane, surface, derived_only, caller_only);
}

/// [`emit_divergence`] with the destination and pane supplied rather than read from the environment.
///
/// Exists so the behaviour can be tested WITHOUT mutating process-global environment state. That is
/// not fastidiousness: env mutation in a test is shared under `cargo test` (one process, parallel
/// tests) and isolated under `cargo nextest` (one process per test), so a test written that way
/// passes on the gate and races locally — and the gate is the run that would stop seeing it.
pub fn emit_divergence_to(
    path: &Path,
    pane: &str,
    surface: &str,
    derived_only: &[String],
    caller_only: &[String],
) {
    if derived_only.is_empty() && caller_only.is_empty() {
        return; // agreement — checked here too, so neither entry point can lose it
    }
    let line = divergence_line(&epoch_ms_to_iso8601(now_ms()), pane, surface, derived_only, caller_only);
    append_line(path, &line);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_line_carries_both_directions_in_fixed_columns() {
        let l = divergence_line("2026-09-01T12:00:00Z", "p:api", "role-gate.denied-commands", &v(&["gh pr merge"]), &v(&["user:rm"]));
        assert_eq!(l, "2026-09-01T12:00:00Z\tp:api\trole-gate.denied-commands\tgh pr merge\tuser:rm\n");
        assert_eq!(l.trim_end().split('\t').count(), 5, "five columns, always");
    }

    /// An empty side is marked, never blank — a blank cell cannot be told apart from a writer that
    /// forgot the column.
    #[test]
    fn an_empty_side_is_marked_explicitly() {
        let l = divergence_line("T", "p", "s", &v(&["a"]), &[]);
        assert!(l.ends_with("\ta\t∅\n"), "got {l:?}");
        let r = divergence_line("T", "p", "s", &[], &v(&["b"]));
        assert!(r.ends_with("\t∅\tb\n"), "got {r:?}");
        // Both empty never reaches the formatter in practice — `emit_divergence` returns first — but
        // the formatter is still total.
        assert!(divergence_line("T", "p", "s", &[], &[]).ends_with("\t∅\t∅\n"));
    }

    /// A value can contain a tab; the row must not gain a column because of it.
    #[test]
    fn a_tab_inside_a_value_cannot_split_the_row() {
        let l = divergence_line("T", "p", "s", &v(&["git commit -m a\tb"]), &v(&["x\ny"]));
        assert_eq!(l.trim_end().split('\t').count(), 5, "still five columns: {l:?}");
        assert!(l.contains("git commit -m a b"), "the tab became a space, and the value stays legible");
        assert!(l.contains("x y"));
        assert!(!l.trim_end().contains('\n'), "no embedded newline");
    }

    #[test]
    fn several_values_share_one_cell() {
        let l = divergence_line("T", "p", "s", &v(&["a", "b", "c"]), &[]);
        assert!(l.contains("\ta,b,c\t"), "got {l:?}");
    }

    /// THE COMMON PATH. Agreement writes nothing — not an empty line, not an empty file.
    #[test]
    fn agreement_writes_nothing_and_disagreement_does() {
        let dir = std::env::temp_dir().join(format!("bsc-div-agree-{}-{:?}", now_ms(), std::thread::current().id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("divergence.log");

        emit_divergence_to(&path, "p:api", "some.surface", &[], &[]);
        assert!(!path.exists(), "agreement must not even create the file");

        // The other arm, or the assertion above proves only that nothing works.
        emit_divergence_to(&path, "p:api", "some.surface", &v(&["only-rust-has-this"]), &[]);
        assert!(path.exists(), "a real disagreement writes");
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("some.surface") && body.contains("only-rust-has-this"), "got {body:?}");
        assert_eq!(body.lines().count(), 1);

        // And it APPENDS — a second disagreement never replaces the first.
        emit_divergence_to(&path, "p:api", "other.surface", &[], &v(&["caller-extra"]));
        assert_eq!(std::fs::read_to_string(&path).unwrap().lines().count(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The env-reading entry point no-ops when unwired, rather than panicking or writing somewhere.
    /// Reading that silence back as "never diverged" is the reader's job to refuse.
    #[test]
    fn the_wired_entry_point_is_a_no_op_when_unwired() {
        // Whatever the ambient environment is, this must not panic and must not create anything.
        emit_divergence("unwired.surface", &v(&["a"]), &v(&["b"]));
    }
}
