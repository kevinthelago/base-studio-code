//! Folder-path `group` derivation (#3579) — turn a component's `src` path into the nested,
//! `/`-delimited FOLDER PATH used to organize a kit like a completed project's folders
//! (`shared/ui/controls`, `features/github`). One definition shared by the harvest (which seeds it onto
//! candidates, `bsc-ui`) and `bsc ui regroup` (which re-derives it for the existing store), so the two
//! can never disagree.

/// Derive a component's `group` — a nested, `/`-delimited FOLDER PATH — from its `src` (#3579), so a kit
/// organizes like a real project's folders. Normalizes `\` to `/`, drops the filename, and strips a
/// leading `src/` root (harvested paths carry it, some kits' don't) for a consistent tree. Returns
/// `None` when `src` has no usable directory — a bare filename, an empty string, or a file that sits
/// directly under the `src/` root — so such a component is left UNGROUPED (never bucketed under `""`).
///
/// Examples:
/// - `src/shared/ui/controls/Button.tsx` → `Some("shared/ui/controls")`
/// - `shared/ui/d3/charts/Bar.tsx`       → `Some("shared/ui/d3/charts")`
/// - `src/Widget.tsx` / `Widget.tsx` / `""` → `None`
pub fn folder_from_src(src: &str) -> Option<String> {
    // #4107: the derivation MOVED to `bsc_util::folder_from_src` so the algorithms library shares it
    // verbatim. Kept here as the component-side name until the `group` -> `folder` rename lands, so
    // this crate's callers are untouched — but there is now exactly ONE implementation.
    bsc_util::folder_from_src(src)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_the_src_root_and_the_filename() {
        assert_eq!(
            folder_from_src("src/shared/ui/controls/Button.tsx").as_deref(),
            Some("shared/ui/controls")
        );
        assert_eq!(
            folder_from_src("src/features/github/summary/Card.tsx").as_deref(),
            Some("features/github/summary")
        );
    }

    #[test]
    fn keeps_a_path_that_has_no_src_root() {
        // react-d3's stored paths don't carry the `src/` prefix — the tree still nests correctly.
        assert_eq!(
            folder_from_src("shared/ui/d3/charts/Bar.tsx").as_deref(),
            Some("shared/ui/d3/charts")
        );
    }

    #[test]
    fn normalizes_windows_backslashes() {
        assert_eq!(
            folder_from_src("src\\shared\\ui\\layout\\Box.tsx").as_deref(),
            Some("shared/ui/layout")
        );
    }

    #[test]
    fn a_component_with_no_folder_is_unfoldered() {
        assert_eq!(folder_from_src("Button.tsx"), None); // bare filename — no directory
        assert_eq!(folder_from_src("src/Widget.tsx"), None); // directly under the src root
        assert_eq!(folder_from_src(""), None);
        assert_eq!(folder_from_src("   "), None);
    }

    #[test]
    fn an_already_clean_folder_path_is_a_fixed_point() {
        // Re-deriving from a path whose folder already equals the group returns that same folder — so
        // `regroup` is idempotent and only rewrites records whose group actually moved.
        assert_eq!(
            folder_from_src("shared/ui/data/KeyValueList.tsx").as_deref(),
            Some("shared/ui/data")
        );
    }
}
