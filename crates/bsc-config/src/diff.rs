//! A minimal line-based diff for `bsc config status`/`diff` (#168).
//!
//! Trims the common prefix and suffix of lines between two texts and reports the differing middle as
//! removed/added — not a full LCS/Myers diff, but enough to show WHAT changed for the kind of small,
//! mostly-single-region edits a config file gets in practice (one prompt paragraph, one permission
//! entry), without pulling in an external diff dependency for a CLI this small.

/// One rendered line of a [`line_diff`] result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiffLine {
    /// An unchanged line, kept for context.
    Context(String),
    /// A line present in the OLD (on-disk) text but not the new (packaged) one.
    Removed(String),
    /// A line present in the NEW (packaged) text but not the old (on-disk) one.
    Added(String),
    /// `n` unchanged lines were elided between two hunks of context.
    Elided(usize),
}

/// How many lines of unchanged context to keep around a change, before eliding the rest.
const CONTEXT: usize = 2;

/// Diff `old` against `new`, line by line, keeping [`CONTEXT`] lines of surrounding context and
/// eliding the rest of any long common run. `old`/`new` are whole-file text; `\r\n` is treated as a
/// plain line — callers compare bytes already normalized the same way on both sides (the on-disk copy
/// and the packaged seed are both stored as UTF-8 text with LF line endings in this repo).
pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine> {
    let old_lines: Vec<&str> = old.lines().collect();
    let new_lines: Vec<&str> = new.lines().collect();

    // No change at all: the prefix/suffix split below assumes a change region SEPARATES two common
    // runs, so it always treats the prefix's tail as "context before a hunk" — which, when the whole
    // file matches, elides lines that precede nothing. Short-circuit rather than teach that split
    // about a hunk that does not exist.
    if old_lines == new_lines {
        return old_lines.into_iter().map(|l| DiffLine::Context(l.to_string())).collect();
    }

    let max_common = old_lines.len().min(new_lines.len());
    let mut prefix = 0;
    while prefix < max_common && old_lines[prefix] == new_lines[prefix] {
        prefix += 1;
    }

    let mut suffix = 0;
    while suffix < max_common - prefix
        && old_lines[old_lines.len() - 1 - suffix] == new_lines[new_lines.len() - 1 - suffix]
    {
        suffix += 1;
    }

    let mut out = Vec::new();

    let prefix_context_start = prefix.saturating_sub(CONTEXT);
    if prefix_context_start > 0 {
        out.push(DiffLine::Elided(prefix_context_start));
    }
    for line in &old_lines[prefix_context_start..prefix] {
        out.push(DiffLine::Context(line.to_string()));
    }
    for line in &old_lines[prefix..old_lines.len() - suffix] {
        out.push(DiffLine::Removed(line.to_string()));
    }
    for line in &new_lines[prefix..new_lines.len() - suffix] {
        out.push(DiffLine::Added(line.to_string()));
    }
    let suffix_context_end = suffix.min(CONTEXT);
    for line in &old_lines[old_lines.len() - suffix..old_lines.len() - suffix + suffix_context_end] {
        out.push(DiffLine::Context(line.to_string()));
    }
    let elided_suffix = suffix.saturating_sub(CONTEXT);
    if elided_suffix > 0 {
        out.push(DiffLine::Elided(elided_suffix));
    }

    out
}

/// Render a [`line_diff`] result as `-`/`+`/` ` prefixed text, the shape a terminal reads as a diff
/// without needing a pager or color support.
pub fn render(lines: &[DiffLine]) -> String {
    let mut out = String::new();
    for line in lines {
        match line {
            DiffLine::Context(s) => out.push_str(&format!("  {s}\n")),
            DiffLine::Removed(s) => out.push_str(&format!("- {s}\n")),
            DiffLine::Added(s) => out.push_str(&format!("+ {s}\n")),
            DiffLine::Elided(n) => out.push_str(&format!("  … {n} unchanged line(s) …\n")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identical_texts_diff_to_nothing_but_context() {
        let d = line_diff("a\nb\nc\n", "a\nb\nc\n");
        assert!(d.iter().all(|l| matches!(l, DiffLine::Context(_))), "{d:?}");
    }

    #[test]
    fn a_single_changed_line_reports_removed_then_added() {
        let d = line_diff("a\nb\nc\n", "a\nX\nc\n");
        assert_eq!(
            d,
            vec![
                DiffLine::Context("a".into()),
                DiffLine::Removed("b".into()),
                DiffLine::Added("X".into()),
                DiffLine::Context("c".into()),
            ]
        );
    }

    #[test]
    fn an_appended_line_reports_as_a_pure_addition() {
        let d = line_diff("a\nb\n", "a\nb\nc\n");
        assert_eq!(d, vec![DiffLine::Context("a".into()), DiffLine::Context("b".into()), DiffLine::Added("c".into())]);
    }

    #[test]
    fn a_long_common_run_beyond_context_is_elided() {
        let old = "1\n2\n3\n4\n5\n6\nX\n";
        let new = "1\n2\n3\n4\n5\n6\nY\n";
        let d = line_diff(old, new);
        // 6 unchanged lines of prefix, CONTEXT=2 kept, 4 elided.
        assert_eq!(d[0], DiffLine::Elided(4));
        assert!(matches!(d[1], DiffLine::Context(_)));
        assert!(d.iter().any(|l| matches!(l, DiffLine::Removed(s) if s == "X")));
        assert!(d.iter().any(|l| matches!(l, DiffLine::Added(s) if s == "Y")));
    }

    #[test]
    fn render_prefixes_each_kind() {
        let s = render(&[
            DiffLine::Context("a".into()),
            DiffLine::Removed("b".into()),
            DiffLine::Added("c".into()),
            DiffLine::Elided(3),
        ]);
        assert_eq!(s, "  a\n- b\n+ c\n  … 3 unchanged line(s) …\n");
    }

    #[test]
    fn completely_different_single_line_files_show_a_full_replace() {
        let d = line_diff("old\n", "new\n");
        assert_eq!(d, vec![DiffLine::Removed("old".into()), DiffLine::Added("new".into())]);
    }
}
