//! Which checkout am I operating on?
//!
//! ## THE ONE SHAPE CHANGE THE PORT FORCED, stated where it happens
//!
//! Every script this crate replaces derived its root the same way:
//!
//! ```js
//! const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
//! ```
//!
//! A script lives IN the tree it sweeps, so its own path is the answer. A `bsc` binary does not: it
//! is staged at `~/.base-studio-code/bin/bsc` and shared by every worktree, so its path says nothing
//! about which tree the caller means. The root therefore comes from the CALLER — an explicit
//! `--root`, else the git repository containing the current directory.
//!
//! ## The hazard this creates, and why `cap` does not use this function for `isMain`
//!
//! `cap-worktrees.mjs` decides the main tree by `t.path === REPO_ROOT`. Under the old derivation
//! that was the main checkout whenever the script ran, because the script only existed there. Under
//! this one, running `bsc worktree cap` from inside `wt-foo` would make `wt-foo` compare equal and
//! the REAL main tree compare unequal — so the main tree would become a deletion candidate, which is
//! precisely the regression `pool::is_collectable`'s `is_main` guard was added to stop.
//!
//! So [`crate::worktree`] does NOT ask this module which tree is main. It takes the FIRST entry of
//! `git worktree list --porcelain`, which git documents as the main worktree, and which is true no
//! matter where the command was invoked from.

use std::path::{Path, PathBuf};

/// The checkout to operate on: `--root <dir>` if given, else the git tree containing the cwd.
///
/// Walks up looking for `.git` as EITHER a directory (the main checkout) or a FILE (a linked
/// worktree's `gitdir:` pointer) — a worktree is the common case here, and testing only for a
/// directory would silently walk past it to the main tree and sweep the wrong `target/`.
pub fn repo_root(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = explicit {
        let p = PathBuf::from(dir);
        if !p.is_dir() {
            return Err(format!("--root {dir}: not a directory"));
        }
        return Ok(p);
    }
    let cwd = std::env::current_dir().map_err(|e| format!("cannot resolve the current directory: {e}"))?;
    from_dir(&cwd).ok_or_else(|| {
        format!(
            "{} is not inside a git checkout, so there is no build tree to operate on. \
             Pass --root <dir> to name one.",
            cwd.display()
        )
    })
}

/// The nearest ancestor of `start` (inclusive) holding a `.git` entry, or `None`.
pub fn from_dir(start: &Path) -> Option<PathBuf> {
    let mut dir = start;
    loop {
        if dir.join(".git").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique scratch directory under the OS temp dir. Explicit paths everywhere — nothing here
    /// reads or writes an env var, because env mutation behaves differently under `cargo test` and
    /// `cargo nextest` and a test written that way passes on the gate and races locally.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-disk-root-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn finds_a_main_checkout_by_its_dot_git_directory() {
        let root = scratch("maindir");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        let deep = root.join("crates").join("bsc-disk").join("src");
        std::fs::create_dir_all(&deep).unwrap();
        assert_eq!(from_dir(&deep), Some(root.clone()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn finds_a_linked_worktree_by_its_dot_git_file_not_a_directory() {
        // THE CASE A DIRECTORY-ONLY TEST WOULD MISS. A linked worktree's `.git` is a file holding a
        // `gitdir:` pointer. Walking past it lands on the main checkout and sweeps the wrong
        // `target/` — silently, since both are real trees with real build output.
        let root = scratch("wtfile");
        let tree = root.join("wt-foo");
        std::fs::create_dir_all(tree.join("src")).unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap(); // the main checkout above it
        std::fs::write(tree.join(".git"), "gitdir: /elsewhere/.git/worktrees/wt-foo\n").unwrap();
        assert_eq!(from_dir(&tree.join("src")), Some(tree.clone()), "must stop at the worktree");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn returns_none_outside_any_checkout() {
        let root = scratch("bare");
        assert_eq!(from_dir(&root), None);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_explicit_root_that_is_not_a_directory_is_refused_rather_than_guessed() {
        let err = repo_root(Some("/definitely/not/here")).unwrap_err();
        assert!(err.contains("not a directory"), "{err}");
    }
}
