//! The app's stores, projected as read-only file trees.
//!
//! # Why
//!
//! An agent needs no documentation for a filesystem. `cat /plan/items/<ref>/status` or
//! `ls /coord/by-pane/<pane>` requires no recall, no schema and no `--help`. More importantly —
//! and this is the reason that survived the slice-2 measurement — a projection is what lets a
//! **read surface exist without binding a writable database into an agent's namespace**.
//!
//! The efficiency argument turned out to be weaker than assumed: measured against an *expert* use
//! of the `bsc` CLI the filesystem ties (1.0x), and only beats the *naive* path (6.2x). Keep the
//! isolation argument; do not oversell the efficiency one.
//!
//! # One shape, four stores
//!
//! | module | mounts at | shape |
//! |---|---|---|
//! | [`plan`]  | `/plan`  | records — one directory per item |
//! | [`graph`] | `/graph` | records — one directory per implementation |
//! | [`ui`]    | `/ui`    | records — one directory per component (summary tier) |
//! | [`coord`] | `/coord` | **a stream** — an append-only event log, not records |
//!
//! `coord` is the one that tests whether the model generalizes, and it does so by *not* being
//! records: a stream projects as one chronological file plus index directories that group its
//! lines. That is a different shape wearing the same interface.
//!
//! # Paths are `String`, not `PathBuf`, on purpose
//!
//! These are **guest** paths inside a Linux namespace, always separated by `/`. `PathBuf` renders
//! with the *host* separator and compares by host rules, which is how `Path::is_absolute()`
//! silently broke `bsc-sandbox` on Windows. Plain `String` means a projection cannot differ
//! between the dev host and the target.

use std::collections::BTreeMap;

pub mod coord;
pub mod graph;
pub mod plan;
pub mod ui;

/// A rendered tree: relative guest path -> file contents.
///
/// `BTreeMap` so the output is deterministic — a projection that reordered between runs would
/// make any diff of it useless.
pub type Tree = BTreeMap<String, String>;

/// An id must not be able to escape its directory when joined onto a root.
///
/// Ids come from a store rather than from user prose, but this is the one place a bad value would
/// become a path and [`materialize`] writes to disk. Rejecting is correct here — a record that
/// cannot be addressed as a path simply does not appear in the projection.
pub(crate) fn id_is_safe(r: &str) -> bool {
    !r.is_empty()
        && !r.starts_with('.')
        && r.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// Render a list as one item per line, newline-terminated, or empty for an empty list.
pub(crate) fn lines(v: &[String]) -> String {
    if v.is_empty() {
        String::new()
    } else {
        let mut s = v.join("\n");
        s.push('\n');
        s
    }
}

/// A single value as its own file, newline-terminated so `cat` reads cleanly.
pub(crate) fn line(v: &str) -> String {
    format!("{v}\n")
}

/// Turn an arbitrary store value into something addressable as one path segment.
///
/// Unlike [`id_is_safe`] this is used for *grouping* keys (a role, a domain, a verb, a pane id),
/// which routinely contain `:` or `/`. Those are index directories we invent, so mapping is
/// right where rejecting would silently drop a whole group.
pub(crate) fn slug(v: &str) -> String {
    let s: String = v
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() { "unspecified".into() } else { s }
}

/// Write a rendered tree under `root`. The only part of this crate that touches a filesystem.
///
/// Kept separate from every `project` so the rendering stays pure and testable on any host; this
/// is the one function whose behaviour depends on there being a disk.
pub fn materialize(root: &std::path::Path, tree: &Tree) -> std::io::Result<()> {
    for (rel, contents) in tree {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&path, contents)?;
    }
    Ok(())
}

/// Merge a store's tree under a prefix, so several stores compose into one projection root.
pub fn merge_under(dest: &mut Tree, prefix: &str, tree: Tree) {
    for (k, v) in tree {
        dest.insert(format!("{prefix}/{k}"), v);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_maps_rather_than_rejects() {
        // Grouping keys routinely hold ':' (pane ids) and '/' (folders). Rejecting them would
        // silently drop a whole index directory.
        assert_eq!(slug("design-studio:designer-react"), "design-studio-designer-react");
        assert_eq!(slug("features/settings/pages"), "features-settings-pages");
        assert_eq!(slug(""), "unspecified");
        assert_eq!(slug("///"), "unspecified");
    }

    #[test]
    fn id_is_safe_refuses_traversal() {
        assert!(!id_is_safe("../../etc/passwd"));
        assert!(!id_is_safe(".hidden"));
        assert!(!id_is_safe(""));
        assert!(id_is_safe("a-star.rs"));
        assert!(id_is_safe("phase-0-linux-port-viability"));
    }

    #[test]
    fn merge_under_prefixes_every_key() {
        let mut dest = Tree::new();
        let mut t = Tree::new();
        t.insert("items/a/status".into(), "open\n".into());
        merge_under(&mut dest, "plan", t);
        assert_eq!(dest["plan/items/a/status"], "open\n");
    }

    #[test]
    fn lines_terminates_and_empties_cleanly() {
        assert_eq!(lines(&[]), "");
        assert_eq!(lines(&["a".into(), "b".into()]), "a\nb\n");
    }
}
