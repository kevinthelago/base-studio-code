//! THE ADJUDICATION DIFF — what one copy of a module has that the other does not.
//!
//! Extracted from `bsc ui diff` so the rule is testable: the verb prints with `println!`, which the
//! in-process harness cannot capture, and a display bug that is only ever read by eye is how this one
//! survived. Measured on `app/useAppBoot.ts`, the report said `record 1 lines / file 1 lines` for a
//! 100-line module and then printed the whole thing twice.
//!
//! A LINE-SET DIFF, NOT AN LCS: the question an adjudicator asks is "what does one copy have that the
//! other does not", and for a decision about dropped exports a set difference answers it directly.

use bsc_record::record_source::code_only;

/// Normalize a source into comparable DISPLAY lines.
///
/// SPLIT BEFORE COLLAPSING. [`code_only`] replaces every whitespace RUN with a single space — newlines
/// included — so `code_only(src).split('\n')` yields exactly ONE element. Normalizing each line on its
/// own keeps what the normalization is for (a transcription preamble and an absolutized import must not
/// read as differences) while leaving lines to diff.
pub fn norm_lines(src: &str) -> Vec<String> {
    src.split('\n')
        .map(code_only)
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

/// What each side holds that the other does not, plus the two line counts.
pub struct BodyDiff {
    pub only_record: Vec<String>,
    pub only_file: Vec<String>,
    pub record_lines: usize,
    pub file_lines: usize,
}

/// Compare a record's body against its file, as lines.
pub fn body_diff(record_body: &str, file_src: &str) -> BodyDiff {
    let (r, f) = (norm_lines(record_body), norm_lines(file_src));
    let set_r: std::collections::BTreeSet<String> = r.iter().cloned().collect();
    let set_f: std::collections::BTreeSet<String> = f.iter().cloned().collect();
    BodyDiff {
        only_record: set_r.iter().filter(|l| !set_f.contains(*l)).cloned().collect(),
        only_file: set_f.iter().filter(|l| !set_r.contains(*l)).cloned().collect(),
        record_lines: r.len(),
        file_lines: f.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE REGRESSION. A record differing from its file by ONE line must report that ONE line — not the
    /// whole module twice, and not `1 lines / 1 lines`.
    #[test]
    fn a_one_line_difference_is_isolated() {
        let rec = "const first = 1;\nconst second = 2;\nconst third = 3;\n";
        let file = "const first = 1;\nconst second = 2;\nvoid hydrateNetworks();\nconst third = 3;\n";
        let d = body_diff(rec, file);
        assert_eq!(d.only_file, vec!["void hydrateNetworks();".to_string()]);
        assert!(d.only_record.is_empty(), "{:?}", d.only_record);
        // ...and the counts are REAL. `1 lines / 1 lines` for a multi-line module was the tell.
        assert_eq!((d.record_lines, d.file_lines), (3, 4));
    }

    /// The bug itself, stated as the thing that must not come back: collapsing first leaves no lines.
    #[test]
    fn collapsing_before_splitting_would_yield_a_single_line() {
        let src = "const first = 1;\nconst second = 2;\n";
        assert_eq!(norm_lines(src).len(), 2, "normalizing per line keeps the lines");
        // The old path, spelled out — one element, which is what made the diff degenerate.
        assert_eq!(code_only(src).split('\n').count(), 1, "if this is ever >1, `code_only` changed");
    }

    /// THE NORMALIZATION IS LOAD-BEARING and must survive the fix: reformatting is not a difference.
    /// Reporting it as one is how 21 candidates were once written off as drift.
    #[test]
    fn reformatting_is_still_not_a_difference() {
        let a = "const  x   =    1;\n";
        let b = "const x = 1;\n";
        let d = body_diff(a, b);
        assert!(d.only_record.is_empty() && d.only_file.is_empty(), "whitespace is not content");
    }

    /// A blank line is not content either — otherwise every spacing change reads as a difference.
    #[test]
    fn blank_lines_are_dropped_from_both_sides() {
        let d = body_diff("const x = 1;\n\n\nconst y = 2;\n", "const x = 1;\nconst y = 2;\n");
        assert!(d.only_record.is_empty() && d.only_file.is_empty());
        assert_eq!((d.record_lines, d.file_lines), (2, 2));
    }
    /// THE OTHER HALF OF THE SAME BUG, and the more serious one. `exported_names` scans LINE BY LINE for
    /// a leading `export`, so handing it a collapsed string yields at most the FIRST export — which made
    /// `bsc ui diff`'s decisive question ("would this retirement DROP an export?") answer `(none)` for
    /// every multi-export module, not because nothing is dropped but because it could never see past the
    /// first one. Pinned here because `body_diff` is the module that owns the newline concern.
    #[test]
    fn exported_names_needs_line_structure_and_a_collapsed_source_hides_every_export_but_the_first() {
        use bsc_record::record_source::{exported_names, norm};
        let src = "export const a = 1;\nexport const b = 2;\nexport function c() {}\n";

        let full = exported_names(&norm(src)).expect("knowable");
        assert_eq!(full.len(), 3, "the normalized source sees every export: {full:?}");

        let collapsed = exported_names(&code_only(src)).expect("knowable");
        assert_eq!(collapsed.len(), 1, "a collapsed source sees only the first — this is the trap");
        assert!(
            collapsed.len() < full.len(),
            "if these ever agree, `code_only` stopped eating newlines and this guard is moot"
        );
    }
}
