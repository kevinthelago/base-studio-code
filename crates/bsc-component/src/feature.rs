//! The OWNERSHIP axis for components — which feature owns a record.
//!
//! The DERIVATION lives in [`bsc_util::feature_from_folder`], shared with the algorithms graph, for the
//! same reason [`crate::folder_from_src`] delegates to `bsc_util`: both stores organize by the same
//! tree, so two copies of the mapping would be two answers waiting to disagree. This module is the
//! component-side name for it, kept so this crate's callers are untouched.
//!
//! ## What `feature` is, and what it is not
//!
//! It says which feature OWNS a component — and therefore which worker may WRITE it. It is
//! SINGLE-VALUED, because a record owned by three features has no answer to that question; `core` is
//! the answer for genuinely shared ones (152 of 448 components at the split).
//!
//! It is NOT usage. Which features USE a component — many-to-many, across any number of projects —
//! is `requires` on a plan feature, mirrored onto the record as `requiredBy`
//! ([`bsc_util::required_by`]). Ownership is one; usage is many.
//!
//! It is also NOT `folder`, which stays what it always was: source provenance, derived from `src`,
//! read by emit paths and re-derived by `bsc ui regroup`. Overloading folder with ownership would make
//! every regroup silently undo the backfill.
//!
//! ## The grouping is a LENS, not a partition
//!
//! A feature scopes who may write a record. It never scopes what may REFERENCE one: a `glance`
//! component composing a `core` component is the normal case — measured at the split, 577 of 927
//! component `composes` edges point at the baseline. `componentsLens.test.ts` guards the same property
//! for technology; a feature filter that hid an edge the store holds would rebuild the silo epic #3114
//! removed.

pub use bsc_util::{feature_from_folder, FEATURE_CORE as CORE, FEATURE_SHELL as SHELL};

#[cfg(test)]
mod tests {
    use super::*;

    /// The component-side shapes specifically, so a change to the shared derivation that broke THIS
    /// store's tree would fail here and not only in `bsc-util`.
    #[test]
    fn the_component_trees_own_shapes_still_map() {
        assert_eq!(feature_from_folder("shared/ui/controls").as_deref(), Some(CORE));
        assert_eq!(feature_from_folder("shared/ui/layouts").as_deref(), Some(CORE));
        assert_eq!(feature_from_folder("app/console").as_deref(), Some(SHELL));
        assert_eq!(feature_from_folder("features/settings/cards").as_deref(), Some("settings"));
        assert_eq!(feature_from_folder("features/glance/fleet").as_deref(), Some("glance"));
    }

    #[test]
    fn a_hollow_records_empty_folder_stays_unplaced() {
        // 44 of 448 components carry no folder, kitId or name. The backfill must report them, never
        // bucket them — a data-quality question buried inside a migration is one nobody answers.
        assert_eq!(feature_from_folder(""), None);
    }
}
