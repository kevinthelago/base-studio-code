//! The OWNERSHIP axis (`the-ownership-axis-is-feature-on-both-graphs`) — which feature owns a
//! component, and the one-time derivation of it from the folder path it was organized under.
//!
//! ## Why a second field rather than redefining `folder`
//!
//! `folder` answers *where did this come from* — it is derived from `src` ([`crate::folder_from_src`]),
//! it names emit paths, and `bsc ui regroup` re-derives it. `domain` answers *what does this belong
//! to*. Overloading one field with both meanings makes the backfill fight `regroup`: every re-derive
//! would undo it. So `domain` is stored, `folder` stays derived, and the mapping below is what
//! connects them ONCE.
//!
//! ## Why `domain` and not `feature`
//!
//! The algorithms library already carries `domain` with feature-shaped values (`planner`, `glance`,
//! `fleet`, `core`, …) and `bsc graph impl list --domain` already filters on it. One word across both
//! graphs means one query a worker has to learn, and a plan feature's `requires` list can name records
//! in either without the caller knowing which store answers.
//!
//! ## The grouping is a LENS, not a partition
//!
//! A domain scopes who may WRITE a record. It never scopes what may REFERENCE one: a `glance`
//! component composing a `core` component is the normal case (measured at the split: 577 of 927
//! component `composes` edges point at the baseline). Technology already works this way and
//! `componentsLens.test.ts` guards it — a domain filter that hid an edge the store holds would rebuild
//! the silo epic #3114 removed.

/// The baseline domain: usable from anywhere, and depended upon by everything.
///
/// Named to match the algorithms library's existing `core`, so the two graphs answer "what is safe to
/// build on" with the same word.
pub const CORE: &str = "core";

/// The app SHELL's own domain — the surface that composes every feature and belongs to none.
///
/// Separate from [`CORE`] on purpose: the shell may depend on features (it mounts them), which is
/// exactly what the baseline may not do. Folding the two together would make that legal for `core` and
/// lose the one asymmetry the rule rests on.
pub const SHELL: &str = "shell";

/// Derive a component's feature domain from its FOLDER path, or `None` when the folder does not say.
///
/// The mapping is deliberately small and total over the shapes the store actually holds — measured
/// across all 448 records at the split:
///
/// - `shared/**`, `components/**`, `src/components/**` → [`CORE`] — the feature-agnostic UI (98 records)
/// - `app/**`                                          → [`SHELL`] (25 under `app/console`, 17 under `app`)
/// - `features/<x>/**`                                 → `<x>` (settings 56, glance 22, designs 16, …)
///
/// `None` for anything else, INCLUDING an empty folder. That is the important half: 44 records carry no
/// folder at all (and no `kitId` and no `name` — they are hollow), and bucketing them under a default
/// would hide a data-quality problem inside a migration. An unmapped record is reported, never guessed.
pub fn feature_from_folder(folder: &str) -> Option<String> {
    let f = folder.trim().trim_start_matches("./").replace('\\', "/");
    let f = f.trim_start_matches('/');
    if f.is_empty() {
        return None;
    }
    // `src/` is a root, not a segment: `src/components/ui` is the same place as `components/ui`.
    let f = f.strip_prefix("src/").unwrap_or(f);
    let mut segs = f.split('/').filter(|s| !s.is_empty());
    match segs.next()? {
        "shared" | "components" => Some(CORE.to_string()),
        "app" => Some(SHELL.to_string()),
        // `features/<x>` — the feature IS the second segment. `features` alone names no feature, so it
        // is unmapped rather than a domain called "features".
        "features" => segs.next().map(str::to_owned),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_and_components_are_the_baseline() {
        for f in ["shared/ui/controls", "shared/ui", "shared", "components/ui", "src/components/ui"] {
            assert_eq!(feature_from_folder(f).as_deref(), Some(CORE), "{f}");
        }
    }

    #[test]
    fn app_is_the_shell_and_not_the_baseline() {
        // The distinction the whole rule rests on: the shell composes features, the baseline may not.
        for f in ["app", "app/console", "app/console/panes/views"] {
            assert_eq!(feature_from_folder(f).as_deref(), Some(SHELL), "{f}");
        }
        assert_ne!(feature_from_folder("app").as_deref(), Some(CORE));
    }

    #[test]
    fn a_feature_is_the_segment_after_features() {
        assert_eq!(feature_from_folder("features/glance").as_deref(), Some("glance"));
        assert_eq!(feature_from_folder("features/settings/cards").as_deref(), Some("settings"));
        assert_eq!(feature_from_folder("features/glance/fleet").as_deref(), Some("glance"));
    }

    #[test]
    fn bare_features_names_no_feature() {
        // Not a domain called "features" — that would be a bucket nobody chose.
        assert_eq!(feature_from_folder("features"), None);
        assert_eq!(feature_from_folder("features/"), None);
    }

    #[test]
    fn an_absent_folder_is_unmapped_never_defaulted() {
        // 44 of 448 records are hollow (no folder, no kitId, no name). Defaulting them into a domain
        // would bury that in the migration; they have to surface as unmapped and be adjudicated.
        for f in ["", "   ", "/"] {
            assert_eq!(feature_from_folder(f), None, "{f:?}");
        }
    }

    #[test]
    fn an_unrecognised_root_is_unmapped_rather_than_guessed() {
        assert_eq!(feature_from_folder("vendor/thing"), None);
        assert_eq!(feature_from_folder("ui/data"), None);
    }

    #[test]
    fn normalizes_separators_and_roots_the_way_folder_derivation_does() {
        assert_eq!(feature_from_folder("src/shared/ui").as_deref(), Some(CORE));
        assert_eq!(feature_from_folder("./features/logs").as_deref(), Some("logs"));
        assert_eq!(feature_from_folder("features\\teams").as_deref(), Some("teams"));
        assert_eq!(feature_from_folder("  features/mcp  ").as_deref(), Some("mcp"));
    }

    #[test]
    fn is_stable_under_re_derivation() {
        // The backfill must be a no-op on its second run, so the mapping cannot depend on state.
        let f = "features/designs";
        assert_eq!(feature_from_folder(f), feature_from_folder(f));
    }
}
