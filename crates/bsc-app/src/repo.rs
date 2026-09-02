//! Where is the app's tree, and what does git say about it?
//!
//! ## THE ONE SHAPE CHANGE THE PORT FORCED
//!
//! `app-status.mjs` and `promote-app.mjs` both derived the app tree the same way, and their comment
//! explains why the obvious alternative is wrong:
//!
//! ```js
//! const REPO_ROOT = mainWorktree(dirname(dirname(fileURLToPath(import.meta.url))));
//! ```
//!
//! Deriving it from the SCRIPT's own path is the bug they were fixing — `wt-resume/scripts/
//! promote-app.mjs` resolved `wt-resume/wt-app`, reported "no app worktree" and offered to create a
//! nested one. `--git-common-dir` is the shared `.git` every worktree points at, so its parent is the
//! one main checkout wherever you are standing.
//!
//! That reasoning survives the port unchanged and gets STRONGER, because a `bsc` binary is staged at
//! `~/.base-studio-code/bin/bsc` and shared by every worktree, so its own path says nothing at all
//! about which repository the caller means. Asking git from the cwd is now the only answer available,
//! which is fortunate, because it was already the right one.

use std::path::{Path, PathBuf};

/// Run git in `cwd`, returning trimmed stdout, or an error naming what failed.
pub fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("could not run git {}: {e}", args.join(" ")))?;
    if !out.status.success() {
        return Err(format!(
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Git in `cwd`, but a non-zero exit is an ANSWER rather than an error — for the checks whose whole
/// question is "did this command succeed?" (`diff --quiet`, `merge-base --is-ancestor`).
pub fn git_ok(cwd: &Path, args: &[&str]) -> bool {
    std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The MAIN worktree — the app's tree — wherever this is run from.
///
/// `--git-common-dir` is the shared `.git` directory every linked worktree points at, so its parent
/// is the one main checkout. NOT the cwd's worktree, and NOT anything derived from this binary's own
/// location (see the module header for the bug that produced).
pub fn main_worktree(from: &Path) -> Result<PathBuf, String> {
    let common = git(from, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
    PathBuf::from(&common)
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("the git common dir '{common}' has no parent, so there is no main worktree"))
}

/// The app tree to operate on: `--root <dir>` if given, else the main worktree of the cwd's repo.
pub fn app_root(explicit: Option<&str>) -> Result<PathBuf, String> {
    if let Some(dir) = explicit {
        let p = PathBuf::from(dir);
        if !p.is_dir() {
            return Err(format!("--root {dir}: not a directory"));
        }
        return Ok(p);
    }
    let cwd = std::env::current_dir().map_err(|e| format!("cannot resolve the current directory: {e}"))?;
    main_worktree(&cwd).map_err(|e| {
        format!("{e}\n  {} is not inside a git checkout. Pass --root <dir> to name one.", cwd.display())
    })
}

/// Count of commits in `range` (e.g. `main..develop`), or 0 when git cannot say.
pub fn count(root: &Path, range: &str, extra: &[&str]) -> u64 {
    let mut args = vec!["rev-list", "--count"];
    args.extend_from_slice(extra);
    args.push(range);
    git(root, &args).ok().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// HEAD of `tree`, or `None` when it cannot be read — which [`crate::promote::gate_tree_moved`]
/// treats as MOVED.
pub fn head_of(tree: &Path) -> Option<String> {
    git(tree, &["rev-parse", "HEAD"]).ok().filter(|s| !s.is_empty())
}

/// TRACKED modifications only, as `--untracked-files=no` gives them.
///
/// Deliberate: a fast-forward cannot destroy an untracked file — git leaves it alone, and at worst
/// refuses the merge itself with a clearer error than anything this could invent. Counting untracked
/// files made every promote refuse over 0-byte editor/shell dotfiles that a tooling sandbox
/// materialises at the repo root, and a guard that never lets you through is not a guard.
pub fn tracked_dirty(tree: &Path) -> Vec<String> {
    git(tree, &["status", "--porcelain", "--untracked-files=no"])
        .map(|s| s.lines().filter(|l| !l.trim().is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// The current branch, or `None` for a detached HEAD.
pub fn current_branch(tree: &Path) -> Option<String> {
    match git(tree, &["rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(b) if b == "HEAD" || b.is_empty() => None,
        Ok(b) => Some(b),
        Err(_) => None,
    }
}

/// Does `git_ref` add any content beyond where it diverged from `other`?
///
/// Asked of git rather than inferred from the commit graph: "every ahead commit is a merge" says
/// those commits carry no content of their OWN, but a merge can still resolve to a tree the merge
/// base did not have (a conflict resolved by hand, an `--ours`). Reconciling on the weaker signal
/// alone would merge over that resolution and lose it silently.
///
/// AGAINST THE MERGE BASE, not against `other`'s current tree. Comparing the two refs answers "are
/// these identical right now", which stops being true the moment `other` moves ahead — after any
/// integration, i.e. before every real promotion. This asks only what `git_ref` contributed, so it
/// holds however far develop has travelled since.
pub fn adds_nothing_beyond_merge_base(root: &Path, git_ref: &str, other: &str) -> bool {
    let Ok(base) = git(root, &["merge-base", git_ref, other]) else { return false };
    git_ok(root, &["diff", "--quiet", &base, git_ref])
}

/// Where `develop` is checked out — the integration tree — or `None` when no worktree holds it.
///
/// `None` rather than a fallback to the root: the JavaScript fell back, which is harmless for the
/// GATE (it costs a refusal from `gate-tree-guard`) but not for the reconcile merge, which would then
/// run in the APP's tree on the app's branch — the one place this whole surface exists to leave
/// alone. Making the absence explicit moves that distinction into the type instead of a comment.
pub fn integration_tree(root: &Path) -> Option<PathBuf> {
    let out = git(root, &["worktree", "list", "--porcelain"]).ok()?;
    let mut path: Option<&str> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            path = Some(p);
        } else if line == "branch refs/heads/develop" {
            if let Some(p) = path {
                return Some(PathBuf::from(p));
            }
        }
    }
    None
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A scratch git repository. Explicit paths everywhere — nothing here reads or writes an env
    /// var, because env mutation behaves differently under `cargo test` and `cargo nextest`, so a
    /// test written that way passes on the gate and races locally.
    pub(crate) fn scratch_repo(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-app-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        run_git(&dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "one").unwrap();
        run_git(&dir, &["add", "-A"]);
        run_git(&dir, &["commit", "-qm", "one"]);
        dir
    }

    /// Git that FAILS LOUDLY — these build the fixture, so a silent failure would make the test
    /// vacuous rather than red. Identity on the command line, never in a config file, so the test
    /// neither depends on nor disturbs this machine's git identity.
    pub(crate) fn run_git(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(["-c", "user.email=t@example.test", "-c", "user.name=t"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    #[test]
    fn main_worktree_is_the_main_checkout_even_when_asked_from_a_linked_worktree() {
        // THE BUG THE JAVASCRIPT COMMENT RECORDS, pinned. Deriving the root from the caller's own
        // location resolves a NESTED path inside the worktree; `--git-common-dir` does not.
        let root = scratch_repo("mainwt");
        run_git(&root, &["worktree", "add", "-q", "-b", "parked-x", "wt-x"]);
        let wt = root.join("wt-x");
        assert!(wt.is_dir(), "the fixture must actually have a linked worktree");

        let from_root = main_worktree(&root).expect("from root");
        let from_wt = main_worktree(&wt).expect("from the worktree");
        assert_eq!(from_root.canonicalize().unwrap(), root.canonicalize().unwrap());
        assert_eq!(
            from_wt.canonicalize().unwrap(),
            root.canonicalize().unwrap(),
            "asked from a linked worktree, the answer is still the MAIN checkout"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn tracked_dirty_ignores_untracked_files() {
        // The whole fix for the class of noise that made every promote refuse over stray root
        // dotfiles a tooling sandbox materialises.
        let root = scratch_repo("dirty");
        std::fs::write(root.join("untracked.txt"), "scratch").unwrap();
        assert!(tracked_dirty(&root).is_empty(), "an untracked file is NOT dirty");
        std::fs::write(root.join("a.txt"), "modified").unwrap();
        assert_eq!(tracked_dirty(&root).len(), 1, "a tracked modification IS dirty");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn current_branch_reports_none_for_a_detached_head() {
        let root = scratch_repo("detached");
        assert_eq!(current_branch(&root).as_deref(), Some("main"));
        let sha = run_git(&root, &["rev-parse", "HEAD"]);
        run_git(&root, &["checkout", "-q", "--detach", &sha]);
        assert_eq!(current_branch(&root), None, "a detached HEAD has no branch to fast-forward");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn adds_nothing_beyond_merge_base_is_about_the_ref_not_the_other_trees_current_state() {
        // THE REGRESSION THE FIRST IMPLEMENTATION SHIPPED. Comparing the two ref trees answers "are
        // these identical right now", which stops being true the moment `other` moves ahead — that
        // is, after any integration, which is before every real promotion.
        let root = scratch_repo("mergebase");
        run_git(&root, &["checkout", "-q", "-b", "develop"]);
        run_git(&root, &["checkout", "-q", "main"]);
        // main gains a MERGE that adds no content of its own.
        run_git(&root, &["merge", "-q", "--no-ff", "-m", "merge: develop into main", "develop"]);
        assert!(
            adds_nothing_beyond_merge_base(&root, "main", "develop"),
            "a merge adding no content must read as adding nothing"
        );

        // ...now develop moves ahead, which is the normal case and must not change the answer.
        run_git(&root, &["checkout", "-q", "develop"]);
        std::fs::write(root.join("b.txt"), "develop moved on").unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-qm", "develop moves ahead"]);
        assert!(
            adds_nothing_beyond_merge_base(&root, "main", "develop"),
            "develop moving ahead is irrelevant — the question is what MAIN contributed"
        );

        // ...and a real content commit on main must flip it.
        run_git(&root, &["checkout", "-q", "main"]);
        std::fs::write(root.join("c.txt"), "committed straight to main").unwrap();
        run_git(&root, &["add", "-A"]);
        run_git(&root, &["commit", "-qm", "straight to main"]);
        assert!(
            !adds_nothing_beyond_merge_base(&root, "main", "develop"),
            "a content commit on the app ref is the fault the refusal exists for"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn integration_tree_is_none_rather_than_the_root_when_nothing_holds_develop() {
        // `None`, not a fallback to the root: the reconcile merge would otherwise run in the APP's
        // tree on the app's branch, the one place this surface exists to leave alone.
        let root = scratch_repo("integ");
        assert_eq!(integration_tree(&root), None);
        run_git(&root, &["worktree", "add", "-q", "-b", "develop", "wt-integ"]);
        let found = integration_tree(&root).expect("develop is checked out somewhere now");
        assert!(found.ends_with("wt-integ"), "found {found:?}");
        std::fs::remove_dir_all(&root).ok();
    }
}
