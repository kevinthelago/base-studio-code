//! Pure selection for cross-worktree artifact de-duplication.
//!
//! Ported from `scripts/dedupe-plan.mjs`. Side-effect-free apart from the unit parser, so WHICH
//! files may be linked is testable without a filesystem.
//!
//! ## What is actually duplicated
//!
//! MEASURED: 721 of 765 rlibs in one worktree's `deps/` share a filename with another worktree's,
//! and sampled pairs are byte-identical — 3.6 GB per tree of the same bytes.
//!
//! They are identical for a reason, not by luck. Dependencies carry `debug = false` (the #795
//! linker-OOM fix), so no absolute paths get baked in. And a shared filename already implies shared
//! inputs: `-C metadata` folds package + features + profile + target, so two trees only agree on a
//! filename when they would produce the same bytes.
//!
//! ## Why workspace crates are excluded by construction
//!
//! Cargo folds the absolute manifest path into `-C metadata` for PATH dependencies, so our own
//! crates have a different hash in every tree and could never match anyway. They also rebuild
//! constantly, which is exactly when linking is least welcome. Excluding them is not caution, it is
//! correctness.

use crate::unit::parse_unit_file;
use std::collections::{HashMap, HashSet};

/// One artifact file, as the scanner found it. `ino` is what proves a group is ALREADY linked.
#[derive(Clone, Debug, PartialEq)]
pub struct ArtifactFile {
    pub tree: String,
    pub path: std::path::PathBuf,
    pub name: String,
    pub size: u64,
    pub mtime_ms: f64,
    pub ino: u64,
}

/// A set of same-name, same-size copies across trees that is worth hashing.
#[derive(Clone, Debug, PartialEq)]
pub struct DedupeGroup {
    pub name: String,
    pub size: u64,
    pub files: Vec<ArtifactFile>,
}

/// Group cross-tree files that are worth hashing.
///
/// Everything here is a CHEAP pre-filter; the caller still verifies sha256 before linking. Grouping
/// on name+size only narrows what has to be read, and must never be mistaken for proof of equality.
///
/// Skipped, each for its own reason:
///   - **workspace crates** — different `-C metadata` per tree, rebuild constantly (module note);
///   - **unparseable names** — the un-hashed convenience copies (`bsc`), which are the names humans
///     and `$BSC_BIN` resolve; linking those would be a functional change, not a dedup;
///   - **recently modified** — a live build in another tree must never be raced;
///   - **groups already sharing one inode** — already linked, so re-running stays cheap and
///     idempotent;
///   - **groups of one** — nothing to link against.
///
/// Returns groups of >= 2, largest reclaimable-bytes first: a partial or interrupted run should have
/// reclaimed the most it could.
pub fn plan_dedupe(
    files: &[ArtifactFile],
    workspace_crates: &HashSet<String>,
    min_age_ms: f64,
    now_ms: f64,
) -> Vec<DedupeGroup> {
    let mut order: Vec<(String, u64)> = Vec::new();
    let mut groups: HashMap<(String, u64), Vec<ArtifactFile>> = HashMap::new();

    for file in files {
        let Some(parsed) = parse_unit_file(&file.name) else { continue }; // un-hashed copy
        if is_workspace_crate(&parsed.name_part, workspace_crates) {
            continue;
        }
        if now_ms - file.mtime_ms < min_age_ms {
            continue; // could be mid-write
        }
        let key = (file.name.clone(), file.size);
        groups.entry(key.clone()).or_insert_with(|| {
            order.push(key.clone());
            Vec::new()
        });
        groups.get_mut(&key).expect("just inserted").push(file.clone());
    }

    let mut out: Vec<DedupeGroup> = Vec::new();
    for key in order {
        let group = groups.remove(&key).expect("every ordered key was inserted");
        if group.len() < 2 {
            continue;
        }
        // Already one inode across every copy — nothing to reclaim.
        if group.iter().map(|f| f.ino).collect::<HashSet<_>>().len() == 1 {
            continue;
        }
        out.push(DedupeGroup { name: key.0, size: key.1, files: group });
    }
    // Biggest first, by what the group would actually reclaim.
    out.sort_by(|a, b| {
        let ra = a.size * (a.files.len() as u64 - 1);
        let rb = b.size * (b.files.len() as u64 - 1);
        rb.cmp(&ra)
    });
    out
}

/// Does this artifact belong to a workspace crate? Checks the name-part both as-is and with a
/// leading `lib` stripped, because rlibs carry the prefix and `.d`/`.rmeta` do not. Over-matching
/// only means keeping a duplicate, which is the safe direction.
pub fn is_workspace_crate(name_part: &str, workspace: &HashSet<String>) -> bool {
    workspace.contains(name_part)
        || name_part.strip_prefix("lib").is_some_and(|rest| workspace.contains(rest))
}

/// Bytes reclaimable from a plan: every copy beyond the first collapses into the canonical inode.
pub fn reclaimable_bytes(groups: &[DedupeGroup]) -> u64 {
    groups.iter().map(|g| g.size * (g.files.len() as u64 - 1)).sum()
}

#[cfg(test)]
mod tests {
    //! Carried over from `scripts/dedupe-plan.test.ts`, assertion for assertion. These pin the
    //! EXCLUSIONS, because a mistake here links a file that should have stayed independent — the one
    //! outcome the hash check downstream cannot catch (it verifies the bytes match, not that linking
    //! them was appropriate).
    use super::*;

    const NOW: f64 = 1_000_000_000_000.0;
    /// A day old — safely past any recency floor.
    const OLD: f64 = NOW - 86_400_000.0;
    const MIN_AGE: f64 = 3_600_000.0;

    fn ws(names: &[&str]) -> HashSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    fn f(tree: &str, name: &str, size: u64, ino: u64) -> ArtifactFile {
        f_at(tree, name, size, ino, OLD)
    }

    fn f_at(tree: &str, name: &str, size: u64, ino: u64, mtime_ms: f64) -> ArtifactFile {
        ArtifactFile {
            tree: tree.to_string(),
            path: std::path::PathBuf::from(format!("{tree}/target/debug/deps/{name}")),
            name: name.to_string(),
            size,
            mtime_ms,
            ino,
        }
    }

    fn plan(files: &[ArtifactFile]) -> Vec<DedupeGroup> {
        plan_dedupe(files, &ws(&["bsc_util"]), MIN_AGE, NOW)
    }

    #[test]
    fn is_workspace_crate_matches_with_and_without_the_rlib_lib_prefix() {
        let w = ws(&["bsc_util", "base_studio_code"]);
        assert!(is_workspace_crate("bsc_util", &w)); // .d / .rmeta form
        assert!(is_workspace_crate("libbsc_util", &w)); // .rlib form
        assert!(!is_workspace_crate("serde_json", &w));
    }

    #[test]
    fn does_not_mistake_a_registry_crate_that_merely_starts_with_lib() {
        // `libduckdb_sys` is a real crate name; stripping `lib` yields `duckdb_sys`, which must not
        // accidentally match a workspace crate of that name if one ever existed.
        assert!(!is_workspace_crate("libduckdb_sys", &ws(&["bsc_util"])));
    }

    #[test]
    fn groups_the_same_artifact_across_two_trees() {
        let groups = plan(&[
            f("/a", "libserde-1111111111111111.rlib", 100, 1),
            f("/b", "libserde-1111111111111111.rlib", 100, 2),
        ]);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].files.len(), 2);
        assert_eq!(reclaimable_bytes(&groups), 100);
    }

    #[test]
    fn never_groups_a_workspace_crate_in_either_filename_form() {
        let groups = plan(&[
            f("/a", "libbsc_util-1111111111111111.rlib", 100, 1),
            f("/b", "libbsc_util-1111111111111111.rlib", 100, 2),
            f("/a", "bsc_util-1111111111111111.rmeta", 50, 3),
            f("/b", "bsc_util-1111111111111111.rmeta", 50, 4),
        ]);
        assert!(groups.is_empty());
    }

    #[test]
    fn skips_un_hashed_convenience_copies() {
        // `bsc` and `base_studio_code.pdb` are the names `$BSC_BIN` and humans resolve BY. Linking
        // them would be a functional change, not a dedup.
        assert!(plan(&[f("/a", "bsc.exe", 100, 1), f("/b", "bsc.exe", 100, 2)]).is_empty());
    }

    #[test]
    fn skips_files_modified_inside_the_recency_floor() {
        // So a live build is never raced.
        let fresh = NOW - 60_000.0; // one minute old
        let groups = plan(&[
            f_at("/a", "libserde-1111111111111111.rlib", 100, 1, fresh),
            f_at("/b", "libserde-1111111111111111.rlib", 100, 2, fresh),
        ]);
        assert!(groups.is_empty());
    }

    #[test]
    fn skips_groups_that_already_share_an_inode_so_re_running_is_idempotent() {
        let groups = plan(&[
            f("/a", "libserde-1111111111111111.rlib", 100, 7),
            f("/b", "libserde-1111111111111111.rlib", 100, 7),
        ]);
        assert!(groups.is_empty());
    }

    #[test]
    fn does_not_group_differing_sizes_even_at_the_same_name() {
        let groups = plan(&[
            f("/a", "libserde-1111111111111111.rlib", 100, 1),
            f("/b", "libserde-1111111111111111.rlib", 200, 2),
        ]);
        assert!(groups.is_empty());
    }

    #[test]
    fn orders_by_reclaimable_bytes() {
        // So an interrupted run has saved the most it could.
        let groups = plan(&[
            f("/a", "libsmall-1111111111111111.rlib", 10, 1),
            f("/b", "libsmall-1111111111111111.rlib", 10, 2),
            f("/a", "libbig-2222222222222222.rlib", 900, 3),
            f("/b", "libbig-2222222222222222.rlib", 900, 4),
        ]);
        assert_eq!(
            groups.iter().map(|g| g.name.as_str()).collect::<Vec<_>>(),
            vec!["libbig-2222222222222222.rlib", "libsmall-1111111111111111.rlib"]
        );
    }

    #[test]
    fn counts_every_copy_beyond_the_first_across_three_trees() {
        let groups = plan(&[
            f("/a", "libserde-1111111111111111.rlib", 100, 1),
            f("/b", "libserde-1111111111111111.rlib", 100, 2),
            f("/c", "libserde-1111111111111111.rlib", 100, 3),
        ]);
        assert_eq!(reclaimable_bytes(&groups), 200);
    }
}
