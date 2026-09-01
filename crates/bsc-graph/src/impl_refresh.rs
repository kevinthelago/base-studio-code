//! REFRESH AN IMPL RECORD FROM THE FILE IT CLAIMS TO BE — `bsc graph impl refresh`, ported from
//! `scripts/refresh-impl-from-file.mjs`.
//!
//! BY ID, NEVER BY HARVEST. `bsc graph harvest --module --apply` authors the candidate under an id
//! DERIVED FROM THE FILENAME, and four different feature barrels all derive `index.ts`. Applying them
//! in turn would write them over one another under one id — a collision that reads as "it worked" four
//! times. The real records are `teams-index.ts`, `debug-index.ts`, `kit-index.ts` and
//! `designs-index.ts`, so the id is passed rather than guessed.
//!
//! The file is the authority here, deliberately: it is the copy `tsc`, `lint`, `vitest` and
//! `vite build` all validate, and these records claim to BE it. A record that is MEANT to differ
//! should not carry a `provides` naming its file — see `bsc ui census`.

use bsc_record::record_source::exported_names;

/// What a refresh would do to one record.
#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// No record with that id — reported and skipped, so one bad id cannot fail the batch.
    NotInStore,
    /// The record already equals its file; nothing to do.
    AlreadyEqual,
    /// The record differs, with what the refresh would restore and remove.
    Refresh(Change),
}

/// The reportable shape of a refresh. The export lists are the judgement: a refresh that RESTORES
/// named exports is the point of the exercise, while one that REMOVES an export the record had is not
/// a sync at all.
#[derive(Debug, PartialEq, Eq)]
pub struct Change {
    pub before_len: usize,
    pub after_len: usize,
    /// Exports the FILE has that the record had lost. `None` when either side is unknowable — a star
    /// re-export makes the set a subset, and a subset would invent a "removal" that is not one.
    ///
    /// SORTED, where the script reported in SOURCE order. `exported_names` returns a `BTreeSet` and has
    /// 14 parity tests behind that shape, so ordering the report instead of the shared function is the
    /// cheaper half to move; alphabetical is also stable when the file is merely reordered.
    pub restored: Option<Vec<String>>,
    pub removed: Option<Vec<String>>,
}

impl Change {
    /// Does this refresh DROP an export the record carried? That is a judgement call rather than a
    /// sync — the record held something the file does not — so the caller surfaces it instead of
    /// applying it quietly.
    pub fn drops_an_export(&self) -> bool {
        self.removed.as_ref().is_some_and(|r| !r.is_empty())
    }
}

/// Decide what a refresh does, given the record's current `code` and the file's record-shaped source.
/// Pure: every store and filesystem effect belongs to the caller.
pub fn verdict(before: Option<&str>, code: &str) -> Verdict {
    let Some(before) = before else { return Verdict::NotInStore };
    if before == code {
        return Verdict::AlreadyEqual;
    }
    let (had, now) = (exported_names(before), exported_names(code));
    // Both sides must be knowable for either list to mean anything: `exported_names` returns None on a
    // star re-export, and pairing a known set against an unknown one manufactures differences.
    let (restored, removed) = match (&had, &now) {
        (Some(h), Some(n)) => (
            Some(n.difference(h).cloned().collect::<Vec<_>>()),
            Some(h.difference(n).cloned().collect::<Vec<_>>()),
        ),
        _ => (None, None),
    };
    Verdict::Refresh(Change {
        // UTF-16 CODE UNITS, matching the JS `.length` this report is compared against. Bytes and
        // chars both diverge on the first emoji or em-dash in a module.
        before_len: before.encode_utf16().count(),
        after_len: code.encode_utf16().count(),
        restored,
        removed,
    })
}

/// One `<impl-id>=<src-relative-path>` argument.
pub fn parse_pair(arg: &str) -> Result<(String, String), String> {
    match arg.split_once('=') {
        Some((id, rel)) if !id.is_empty() && !rel.is_empty() => Ok((id.to_string(), rel.to_string())),
        _ => Err(format!("bad argument \"{arg}\" — expected <impl-id>=<src-relative-path>")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_record_is_skipped_not_an_error() {
        assert_eq!(verdict(None, "export const a = 1;\n"), Verdict::NotInStore);
    }

    #[test]
    fn a_record_that_already_equals_its_file_is_skipped() {
        let s = "export const a = 1;\n";
        assert_eq!(verdict(Some(s), s), Verdict::AlreadyEqual);
    }

    /// THE POINT OF THE EXERCISE: the record had lost an export the file still has.
    #[test]
    fn a_refresh_names_the_exports_it_restores() {
        let Verdict::Refresh(c) =
            verdict(Some("export const a = 1;\n"), "export const a = 1;\nexport const b = 2;\n")
        else {
            panic!("must be a refresh")
        };
        assert_eq!(c.restored.as_deref(), Some(&["b".to_string()][..]));
        assert_eq!(c.removed.as_deref(), Some(&[][..]));
        assert!(!c.drops_an_export());
        assert!(c.after_len > c.before_len);
    }

    /// ...AND THE CASE THAT IS NOT A SYNC. The record holds something the file does not, so this is a
    /// judgement call. It is surfaced rather than applied quietly.
    #[test]
    fn a_refresh_that_would_drop_an_export_says_so() {
        let Verdict::Refresh(c) =
            verdict(Some("export const a = 1;\nexport const b = 2;\n"), "export const a = 1;\n")
        else {
            panic!("must be a refresh")
        };
        assert_eq!(c.removed.as_deref(), Some(&["b".to_string()][..]));
        assert!(c.drops_an_export(), "this is the whole warning");
    }

    /// A star re-export makes the export set a SUBSET, not the set. Reporting a difference against an
    /// unknowable side would invent a removal that is not one, so both lists go absent together.
    #[test]
    fn an_unknowable_export_set_reports_neither_list() {
        let Verdict::Refresh(c) =
            verdict(Some("export * from \"./x\";\n"), "export const a = 1;\n")
        else {
            panic!("must be a refresh")
        };
        assert!(c.restored.is_none() && c.removed.is_none(), "{c:?}");
        assert!(!c.drops_an_export(), "an unknowable side must not read as a drop");
    }

    /// The length report counts UTF-16 code units, as the JS `.length` it is compared against does.
    #[test]
    fn the_length_report_counts_utf16_code_units() {
        let Verdict::Refresh(c) = verdict(Some("x"), "// 🎉\n") else { panic!("refresh") };
        // "// 🎉\n" is 4 ASCII + a surrogate PAIR = 6 units, where chars() would say 5 and bytes 8.
        assert_eq!(c.after_len, 6, "the emoji is a surrogate pair");
    }

    /// The one place this diverges from the script, pinned so it is a decision rather than a drift: the
    /// script listed exports in SOURCE order, this lists them sorted. `exported_names` returns a
    /// `BTreeSet`, and a report that is stable when a file is merely reordered is the better default.
    #[test]
    fn the_export_lists_are_sorted_not_in_source_order() {
        let before = "export const zeta = 1;\nexport const alpha = 2;\nexport const mid = 3;\n";
        let Verdict::Refresh(c) = verdict(Some(before), "export const mid = 3;\n") else {
            panic!("must be a refresh")
        };
        assert_eq!(c.removed.as_deref(), Some(&["alpha".to_string(), "zeta".to_string()][..]));
    }

    #[test]
    fn a_pair_argument_needs_both_halves() {
        assert_eq!(parse_pair("teams-index.ts=features/teams/index.ts").unwrap(),
                   ("teams-index.ts".into(), "features/teams/index.ts".into()));
        assert!(parse_pair("teams-index.ts").is_err());
        assert!(parse_pair("=features/teams/index.ts").is_err());
        assert!(parse_pair("teams-index.ts=").is_err());
    }
}
