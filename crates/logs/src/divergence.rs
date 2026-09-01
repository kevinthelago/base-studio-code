//! `bsc logs divergence` — the query step 7 of the migration epic asks.
//!
//! The epic ends each migration with *"delete the TypeScript only after the disagreement log has been
//! empty in the field."* This answers that, per surface: how many times the two implementations
//! disagreed, when it first and last happened, and — the part a count alone cannot give you — the
//! DISTINCT VALUES they disagreed about, which is what tells you whether the divergence is one stale
//! entry or a systematic hole.
//!
//! # An absent stream is UNKNOWN, never zero
//!
//! This is the whole point and it is worth stating plainly, because getting it wrong turns the
//! instrument into a lie that reads exactly like good news.
//!
//! [`read_divergence`] returns `Option`. `None` means the stream FILE DOES NOT EXIST — nothing ever
//! wired it, or nothing has ever written to it — and the honest answer is *we do not know*. `Some`
//! with no row for a surface means the stream is live and that surface has not diverged, which is the
//! evidence step 7 wants.
//!
//! The general reader cannot make this distinction and is not used here on purpose:
//! [`crate::read_stream`] does `read_to_string(..).unwrap_or_default()`, so a missing file and an
//! empty one produce the same empty vector. That is fine for a feed and fatal for a criterion.

use std::collections::BTreeMap;
use std::path::Path;

/// One surface's divergence history.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SurfaceDivergence {
    /// The derivation's id, as passed to `bsc_util::emit_divergence` — e.g. `role-gate.denied-commands`.
    pub surface: String,
    /// How many disagreements were recorded.
    pub count: usize,
    /// First and last occurrence, as the ISO-8601 stamps the emitter wrote.
    pub first_seen: String,
    pub last_seen: String,
    /// Distinct values RUST derived that the caller omitted — **the defect direction**. A non-empty
    /// list here is what should stop a deletion.
    pub derived_only: Vec<String>,
    /// Distinct values the caller carried that Rust did not. A union legitimately produces these, so
    /// they are reported for context and are not a fault.
    pub caller_only: Vec<String>,
    /// The panes that reported, so a divergence is joinable to the sessions that saw it.
    pub panes: Vec<String>,
}

/// Read the divergence stream and roll it up per surface, newest activity first.
///
/// **`None` means the stream does not exist** — unknown, not clean. See the module header.
pub fn read_divergence(dir: &Path, surface: Option<&str>) -> Option<Vec<SurfaceDivergence>> {
    let path = dir.join("divergence.log");
    // The one line that separates "we watched and saw nothing" from "we never watched".
    let text = std::fs::read_to_string(&path).ok()?;

    let mut acc: BTreeMap<String, SurfaceDivergence> = BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let f: Vec<&str> = line.split('\t').collect();
        if f.len() < 5 {
            continue; // not a divergence row
        }
        let (ts, pane, surf) = (f[0], f[1], f[2]);
        if let Some(want) = surface {
            if surf != want {
                continue;
            }
        }
        let entry = acc.entry(surf.to_string()).or_insert_with(|| SurfaceDivergence {
            surface: surf.to_string(),
            count: 0,
            first_seen: ts.to_string(),
            last_seen: ts.to_string(),
            derived_only: Vec::new(),
            caller_only: Vec::new(),
            panes: Vec::new(),
        });
        entry.count += 1;
        // The emitter appends, so the file is chronological; compare anyway rather than assume it.
        if ts < entry.first_seen.as_str() {
            entry.first_seen = ts.to_string();
        }
        if ts > entry.last_seen.as_str() {
            entry.last_seen = ts.to_string();
        }
        push_values(&mut entry.derived_only, f[3]);
        push_values(&mut entry.caller_only, f[4]);
        if !pane.is_empty() && pane != "?" && !entry.panes.iter().any(|p| p == pane) {
            entry.panes.push(pane.to_string());
        }
    }

    let mut rows: Vec<SurfaceDivergence> = acc.into_values().collect();
    // Most recently diverged first — the one still happening is the one that blocks a deletion.
    rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then_with(|| a.surface.cmp(&b.surface)));
    Some(rows)
}

/// Split a cell into distinct values, preserving first-seen order. `∅` is the emitter's explicit
/// "this side was empty" marker and contributes nothing.
fn push_values(into: &mut Vec<String>, cell: &str) {
    if cell == "∅" || cell.is_empty() {
        return;
    }
    for v in cell.split(',').map(str::trim).filter(|v| !v.is_empty()) {
        if !into.iter().any(|x| x == v) {
            into.push(v.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("divergence.log"), body).unwrap();
    }

    fn tmp(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("bsc-divread-{tag}-{}", bsc_util::now_ms()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    /// THE CRITERION. Three states, and the first two must never be confused.
    #[test]
    fn an_absent_stream_is_unknown_and_an_empty_one_is_clean() {
        let dir = tmp("states");
        std::fs::create_dir_all(&dir).unwrap();

        // No file at all — nothing ever wired or wrote it.
        assert!(read_divergence(&dir, None).is_none(), "an absent stream is UNKNOWN");

        // The file exists and is empty — we were watching and saw nothing.
        write(&dir, "");
        let clean = read_divergence(&dir, None).expect("an existing stream is knowable");
        assert!(clean.is_empty(), "no surface has diverged");

        // And a surface with rows is neither.
        write(&dir, "2026-09-01T12:00:00Z\tp:a\trole-gate.denies\tgh pr merge\t∅\n");
        let rows = read_divergence(&dir, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The stream is reachable by the words a reader actually reaches for, and `tail` can read it.
    ///
    /// The `every_reader_stream_maps_to_a_canonical_event` guard in `src-tauri` already pins that
    /// `divergence` is its own canonical name; these are the ALIASES, which nothing else covers. A
    /// reader chasing a disagreement is at least as likely to type `disagreement` or `drift`, and a
    /// dead end there is the instrument being unfindable rather than absent.
    #[test]
    fn the_stream_answers_to_the_names_a_reader_would_try() {
        for alias in ["divergence", "divergences", "disagreement", "disagreements", "drift"] {
            assert_eq!(crate::canonical_stream(alias), Some("divergence"), "{alias} should resolve");
        }
        assert_eq!(crate::canonical_stream("divergent"), None, "and a near-miss is still a miss");

        // And the raw tail reads the file the registry names, so `bsc logs tail drift` works.
        let dir = tmp("alias");
        write(&dir, "2026-09-01T12:00:00Z\tp\ts\ta\t∅\n");
        let rows = crate::tail_raw(&dir, "drift", 5, false);
        assert_eq!(rows.len(), 1, "tail resolves the alias to divergence.log");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A surface with no rows in a LIVE stream is clean; the same query against an absent stream is
    /// not. Same empty-looking answer, opposite meanings.
    #[test]
    fn a_quiet_surface_in_a_live_stream_is_not_the_same_as_no_stream() {
        let dir = tmp("quiet");
        write(&dir, "2026-09-01T12:00:00Z\tp:a\tother.surface\tx\t∅\n");
        let live = read_divergence(&dir, Some("role-gate.denies")).unwrap();
        assert!(live.is_empty(), "this surface is clean — and the stream proves we were watching");

        let empty = tmp("quiet-none");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(read_divergence(&empty, Some("role-gate.denies")).is_none(), "unknown, not clean");

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&empty);
    }

    #[test]
    fn a_surface_rolls_up_its_count_window_values_and_panes() {
        let dir = tmp("rollup");
        write(
            &dir,
            "2026-09-01T12:00:00Z\tp:a\trole-gate.denies\tgh pr merge,gh repo delete\tuser:rm\n\
             2026-09-01T13:00:00Z\tp:b\trole-gate.denies\tgh pr merge\t∅\n\
             2026-09-01T11:00:00Z\tp:a\trole-gate.denies\tgit push\t∅\n",
        );
        let rows = read_divergence(&dir, None).unwrap();
        assert_eq!(rows.len(), 1);
        let r = &rows[0];
        assert_eq!(r.count, 3);
        assert_eq!(r.first_seen, "2026-09-01T11:00:00Z", "earliest, not the file's first line");
        assert_eq!(r.last_seen, "2026-09-01T13:00:00Z");
        assert_eq!(r.derived_only, vec!["gh pr merge", "gh repo delete", "git push"], "distinct, first-seen order");
        assert_eq!(r.caller_only, vec!["user:rm"]);
        assert_eq!(r.panes, vec!["p:a", "p:b"], "deduped, joinable to sessions");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `∅` is a marker, not a value — it must never appear in a values list.
    #[test]
    fn the_empty_marker_is_never_reported_as_a_value() {
        let dir = tmp("marker");
        write(&dir, "2026-09-01T12:00:00Z\tp:a\ts\t∅\t∅\n");
        let r = &read_divergence(&dir, None).unwrap()[0];
        assert!(r.derived_only.is_empty() && r.caller_only.is_empty());
        assert_eq!(r.count, 1, "the row still counts — it was recorded");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Most-recently-diverged first: the surface still failing is the one blocking a deletion.
    #[test]
    fn surfaces_are_ordered_by_most_recent_divergence() {
        let dir = tmp("order");
        write(
            &dir,
            "2026-09-01T10:00:00Z\tp\told.surface\ta\t∅\n\
             2026-09-01T18:00:00Z\tp\tfresh.surface\tb\t∅\n",
        );
        let rows = read_divergence(&dir, None).unwrap();
        assert_eq!(rows.iter().map(|r| r.surface.as_str()).collect::<Vec<_>>(), vec!["fresh.surface", "old.surface"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A short or malformed row is skipped, not counted — a count is evidence and must not be
    /// inflated by a line the parser could not read.
    #[test]
    fn a_malformed_row_is_skipped_rather_than_counted() {
        let dir = tmp("malformed");
        write(&dir, "garbage\n2026-09-01T12:00:00Z\tp\ts\n2026-09-01T12:00:00Z\tp\ts\ta\t∅\n");
        let rows = read_divergence(&dir, None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].count, 1, "only the well-formed row counts");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The end-to-end shape: what the EMITTER writes is what this READER parses. A test that
    /// hand-writes the line proves the parser agrees with whoever typed the fixture.
    #[test]
    fn the_reader_parses_exactly_what_the_emitter_writes() {
        let dir = tmp("roundtrip");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("divergence.log");
        bsc_util::emit_divergence_to(
            &path,
            "p:api",
            "role-gate.denied-commands",
            &["gh pr merge".to_string(), "gh repo delete".to_string()],
            &["user:custom".to_string()],
        );
        let r = &read_divergence(&dir, None).unwrap()[0];
        assert_eq!(r.surface, "role-gate.denied-commands");
        assert_eq!(r.derived_only, vec!["gh pr merge", "gh repo delete"]);
        assert_eq!(r.caller_only, vec!["user:custom"]);
        assert_eq!(r.panes, vec!["p:api"]);
        assert_eq!(r.count, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
