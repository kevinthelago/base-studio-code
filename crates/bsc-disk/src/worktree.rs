//! The git-touching driver for `bsc worktree cap`.
//!
//! Ported from `scripts/cap-worktrees.mjs`. The selection lives in the pure [`crate::pool`]; this
//! file measures the trees and removes them.
//!
//! ## DESTRUCTIVE — deliberately NOT wired into `build:plan` or the gate
//!
//! The two janitors ([`crate::sweep`]) run before every dev launch because their worst outcome is a
//! rebuild. This one deletes a working tree and its branch. It is an explicit command, run when you
//! want it, and it never runs on your behalf. It is NOT under the fail-safe contract: a failure is
//! reported and returned.
//!
//! ## What it refuses rather than works around
//!
//!   - **A junction/symlink `node_modules`.** `git worktree remove` FOLLOWS it and wipes the shared
//!     root install. Refused outright, because the cost of being wrong once is every worktree agent
//!     losing its dependencies.
//!   - **Uncommitted work.** `--force` is NEVER passed. If git declines to remove a dirty tree, that
//!     refusal IS the safety feature; the failure is reported and the tree is left alone. The first
//!     real run of the JavaScript kept `wt-swap`, which turned out to hold 7 staged source
//!     modifications on a *parked* branch — `--force` would have destroyed real work.
//!   - **A ref whose work has not landed**, including the main tree — excluded by construction in
//!     [`crate::pool::is_collectable`], not by a check here.
//!   - **A tree touched inside the idle window.** Merged is not idle: a session keeps working in its
//!     tree after merging, so without this the widened rule would delete a working tree out from
//!     under a live agent.
//!
//! A branch delete is attempted after a successful removal and its failure is non-fatal: the tree is
//! already gone, and a lingering `parked-*` ref costs nothing but a line in `git branch`.

use crate::pool::{plan_cap, CapPlan, Tree, INTEGRATION_BRANCHES};
use std::path::{Path, PathBuf};

/// One row of `git worktree list --porcelain`, before any measurement.
#[derive(Debug, PartialEq)]
pub struct Listed {
    pub path: PathBuf,
    /// `None` for a detached HEAD.
    pub branch: Option<String>,
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("could not run git {}: {e}", args.join(" ")))
}

/// Parse `git worktree list --porcelain`.
///
/// THE FIRST ENTRY IS THE MAIN WORKTREE — git documents that ordering, and it is the only source for
/// it that does not depend on where the command was invoked from. See [`crate::root`] for why a path
/// comparison against the resolved root (what the JavaScript did) is WRONG for a shared binary: run
/// from inside `wt-foo`, it would mark `wt-foo` as main and leave the real main tree collectable.
pub fn parse_worktree_list(porcelain: &str) -> Vec<Listed> {
    let mut trees: Vec<Listed> = Vec::new();
    for line in porcelain.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            trees.push(Listed { path: PathBuf::from(path), branch: None });
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(last) = trees.last_mut() {
                last.branch = Some(branch.to_string());
            }
        }
    }
    trees
}

/// The hazard check: a symlinked/junctioned `node_modules` makes removal destructive.
pub fn blocked_reason(path: &Path) -> Option<String> {
    let nm = path.join("node_modules");
    match std::fs::symlink_metadata(&nm) {
        Ok(meta) if meta.file_type().is_symlink() => Some(
            "node_modules is a symlink/junction — `git worktree remove` would follow it and wipe \
             the shared install"
                .to_string(),
        ),
        // Absent — the normal, zero-install case — or a real directory.
        _ => None,
    }
}

fn mtime_ms(path: &Path) -> Option<f64> {
    let meta = std::fs::metadata(path).ok()?;
    let t = meta.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0)
}

/// When this tree was last COMPILED IN — the warm `target/` is the only thing a parked tree is for.
pub fn last_built_ms(path: &Path) -> f64 {
    for probe in ["target/debug", "target"] {
        if let Some(ms) = mtime_ms(&path.join(probe)) {
            return ms;
        }
    }
    0.0 // no target/ yet — i.e. the least valuable tree to keep
}

/// When anyone last WORKED in this tree, as opposed to last compiled in it.
///
/// The worktree's private index is the cheap, reliable signal: every `git status`, `add`, `commit`
/// and `checkout` writes it, and an agent runs those constantly. Walking the tree for the newest
/// source mtime would be more direct and costs a full filesystem scan per tree; `target/` recency is
/// folded in as a floor so a long compile also counts as activity.
pub fn last_active_ms(path: &Path) -> f64 {
    let mut newest = last_built_ms(path);
    // The main tree has a `.git` DIRECTORY, so this read fails and the build time stands alone.
    if let Ok(dotgit) = std::fs::read_to_string(path.join(".git")) {
        if let Some(gitdir) = dotgit.trim().strip_prefix("gitdir:") {
            if let Some(ms) = mtime_ms(&PathBuf::from(gitdir.trim()).join("index")) {
                newest = newest.max(ms);
            }
        }
    }
    newest
}

/// Is `branch` already contained in `develop`? Then its tree holds no unlanded work.
pub fn is_merged(root: &Path, branch: Option<&str>) -> bool {
    // Detached HEAD: we cannot name what it holds, so never collect it.
    let Some(branch) = branch else { return false };
    // `develop` is its own ancestor, so without this the main tree reports as merged. The planner
    // refuses it too; both layers say so, because the cost of either one being wrong is the repo.
    if INTEGRATION_BRANCHES.contains(&branch) {
        return false;
    }
    git(root, &["merge-base", "--is-ancestor", branch, "develop"])
        .is_ok_and(|o| o.status.success())
}

/// Measure every worktree git knows about.
pub fn survey(root: &Path) -> Result<Vec<Tree>, String> {
    let out = git(root, &["worktree", "list", "--porcelain"])?;
    if !out.status.success() {
        return Err(format!("git worktree list failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let listed = parse_worktree_list(&String::from_utf8_lossy(&out.stdout));
    Ok(listed
        .iter()
        .enumerate()
        .map(|(i, t)| Tree {
            name: t.path.to_string_lossy().into_owned(),
            branch: t.branch.clone(),
            blocked: blocked_reason(&t.path),
            last_built_ms: last_built_ms(&t.path),
            last_active_ms: last_active_ms(&t.path),
            merged: is_merged(root, t.branch.as_deref()),
            // git lists the MAIN worktree first. Not a path comparison — see `parse_worktree_list`.
            is_main: i == 0,
        })
        .collect())
}

/// What a cap run did.
#[derive(Debug, Default, PartialEq)]
pub struct CapReport {
    pub removed: Vec<String>,
    /// A tree git declined to remove — a dirty tree's refusal IS the safety feature.
    pub kept_back: Vec<(String, String)>,
    pub refused: Vec<(String, String)>,
}

/// Remove the trees `plan` names. `dry_run` reports and removes nothing.
pub fn apply(root: &Path, trees: &[Tree], plan: &CapPlan, dry_run: bool) -> CapReport {
    let by_name: std::collections::HashMap<&str, &Tree> =
        trees.iter().map(|t| (t.name.as_str(), t)).collect();
    let mut report = CapReport { refused: plan.refused.clone(), ..CapReport::default() };

    for path in &plan.remove {
        let branch = by_name.get(path.as_str()).and_then(|t| t.branch.clone());
        if dry_run {
            report.removed.push(path.clone());
            continue;
        }
        // NO --force: a dirty tree's refusal is the safety feature.
        match git(root, &["worktree", "remove", path]) {
            Ok(out) if out.status.success() => report.removed.push(path.clone()),
            Ok(out) => {
                let why = String::from_utf8_lossy(&out.stderr).trim().lines().next().unwrap_or("").to_string();
                report.kept_back.push((path.clone(), why));
                continue;
            }
            Err(e) => {
                report.kept_back.push((path.clone(), e));
                continue;
            }
        }
        // The tree is already gone; a lingering ref costs nothing but a line in `git branch`.
        if let Some(branch) = branch {
            let _ = git(root, &["branch", "-D", &branch]);
        }
    }
    report
}

/// Survey, plan and apply in one go.
pub fn run_cap(root: &Path, keep: usize, min_idle_ms: f64, dry_run: bool, now_ms: f64) -> Result<CapReport, String> {
    let trees = survey(root)?;
    let plan = plan_cap(&trees, keep, min_idle_ms, now_ms);
    Ok(apply(root, &trees, &plan, dry_run))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bsc-disk-wt-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    /// Real `git worktree list --porcelain` output, main tree first.
    const PORCELAIN: &str = "\
worktree /repo
HEAD c264c54ee0000000000000000000000000000000
branch refs/heads/main

worktree /repo/wt-a
HEAD 0950e72a80000000000000000000000000000000
branch refs/heads/parked-a

worktree /repo/.promote-gate
HEAD c264c54ee0000000000000000000000000000000
detached
";

    #[test]
    fn parses_paths_branches_and_a_detached_head() {
        let got = parse_worktree_list(PORCELAIN);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], Listed { path: PathBuf::from("/repo"), branch: Some("main".into()) });
        assert_eq!(got[1], Listed { path: PathBuf::from("/repo/wt-a"), branch: Some("parked-a".into()) });
        // A detached HEAD has no `branch` line, so its branch stays None and it is never collectable.
        assert_eq!(got[2], Listed { path: PathBuf::from("/repo/.promote-gate"), branch: None });
    }

    #[test]
    fn the_main_worktree_is_the_first_entry_not_a_path_comparison() {
        // THE HAZARD THE PORT CREATED, pinned. The JavaScript decided this with
        // `t.path === REPO_ROOT`, where REPO_ROOT was the script's OWN tree. A shared `bsc` binary
        // resolves its root from the cwd, so running this from inside `wt-a` would have marked
        // `wt-a` as main and left `/repo` — the repository itself — collectable.
        let listed = parse_worktree_list(PORCELAIN);
        let from_wt_a = PathBuf::from("/repo/wt-a");
        assert_ne!(listed[0].path, from_wt_a, "the cwd must not decide which tree is main");
        assert_eq!(listed[0].path, PathBuf::from("/repo"));
    }

    #[test]
    fn a_junctioned_node_modules_is_a_hazard_and_a_real_directory_is_not() {
        let root = scratch("junction");
        let plain = root.join("plain");
        let junction = root.join("junction");
        std::fs::create_dir_all(plain.join("node_modules")).unwrap();
        std::fs::create_dir_all(&junction).unwrap();
        std::fs::create_dir_all(root.join("shared-install")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("shared-install"), junction.join("node_modules")).unwrap();

        assert_eq!(blocked_reason(&plain), None, "a real node_modules is the zero-install case");
        assert_eq!(blocked_reason(&root.join("absent")), None, "no node_modules at all is normal");
        #[cfg(unix)]
        assert!(
            blocked_reason(&junction).is_some_and(|w| w.contains("wipe the shared install")),
            "a symlinked node_modules MUST be refused"
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn last_built_prefers_target_debug_then_target_then_reports_the_least_valuable_tree() {
        let root = scratch("built");
        assert_eq!(last_built_ms(&root), 0.0, "no target/ ⇒ the least valuable tree to keep");
        std::fs::create_dir_all(root.join("target")).unwrap();
        assert!(last_built_ms(&root) > 0.0);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn last_active_folds_in_the_worktrees_private_index() {
        // Every `git status`/`add`/`commit`/`checkout` writes that index, and an agent runs those
        // constantly — so it catches a tree being WORKED in that has not been COMPILED in.
        let root = scratch("active");
        let tree = root.join("wt-a");
        let gitdir = root.join(".git").join("worktrees").join("wt-a");
        std::fs::create_dir_all(&gitdir).unwrap();
        std::fs::create_dir_all(&tree).unwrap();
        std::fs::write(tree.join(".git"), format!("gitdir: {}\n", gitdir.display())).unwrap();
        std::fs::write(gitdir.join("index"), b"x").unwrap();

        assert_eq!(last_built_ms(&tree), 0.0, "nothing was ever compiled here");
        assert!(last_active_ms(&tree) > 0.0, "but the index says someone worked here");
        std::fs::remove_dir_all(&root).ok();
    }

    /// Run git in `dir`, failing loudly — these set up the fixture, so a silent failure would make
    /// the test below vacuous rather than red.
    fn git_ok(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            // Identity on the command line, never in a config file: the test must not depend on,
            // or disturb, whatever git identity this machine has. `-c` is a GIT option and must
            // precede the subcommand — appended after it, git rejects the whole invocation.
            .args(["-c", "user.email=t@t", "-c", "user.name=t"])
            .args(args)
            .current_dir(dir)
            .output()
            .expect("git runs");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn survey_names_the_main_tree_even_when_run_from_inside_a_worktree() {
        // THE HAZARD THE PORT CREATED, AND THE ONE A UNIT TEST COULD NOT SEE. A bite probe flipping
        // `is_main: i == 0` to `false` broke NOTHING, because the test above only exercises
        // `parse_worktree_list` — the parser, not the flag. That is this repo's signature failure
        // (a guard that covers less than its name claims) in the middle of the most destructive
        // verb here, so this drives the REAL `survey` against a REAL repository with a REAL linked
        // worktree, invoked from INSIDE that worktree, which is exactly the arrangement the
        // JavaScript's `t.path === REPO_ROOT` got wrong.
        let root = scratch("survey-main");
        let main = root.join("main");
        std::fs::create_dir_all(&main).unwrap();
        git_ok(&main, &["init", "-q", "-b", "develop"]);
        std::fs::write(main.join("f"), b"x").unwrap();
        git_ok(&main, &["add", "."]);
        git_ok(&main, &["commit", "-qm", "one"]);
        git_ok(&main, &["worktree", "add", "-q", "-b", "parked-a", "../wt-a"]);
        let wt = root.join("wt-a");
        assert!(wt.is_dir(), "the fixture must actually have a linked worktree");

        // Surveyed FROM THE WORKTREE — the case that inverts a path comparison.
        let trees = survey(&wt).expect("survey");
        let by = |suffix: &str| {
            trees.iter().find(|t| t.name.ends_with(suffix)).unwrap_or_else(|| panic!("no tree {suffix}"))
        };
        assert_eq!(trees.len(), 2);
        assert!(by("/main").is_main, "the MAIN tree must be flagged main, whatever the cwd is");
        assert!(!by("/wt-a").is_main, "the worktree we ran from must NOT be flagged main");

        // And the consequence that actually matters: with the guards fully off, the main tree is
        // still not collectable and the parked worktree is.
        let plan = plan_cap(&trees, 0, 0.0, f64::MAX);
        assert!(!plan.remove.iter().any(|n| n.ends_with("/main")), "the repository itself was proposed for removal");
        assert_eq!(plan.remove.len(), 1);
        assert!(plan.remove[0].ends_with("/wt-a"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_dry_run_reports_the_plan_and_removes_nothing() {
        let root = scratch("dry");
        let trees = vec![Tree {
            name: "/repo/wt-a".into(),
            branch: Some("parked-a".into()),
            last_built_ms: 1.0,
            last_active_ms: 1.0,
            ..Tree::default()
        }];
        let plan = plan_cap(&trees, 0, 0.0, f64::MAX);
        let report = apply(&root, &trees, &plan, true);
        assert_eq!(report.removed, vec!["/repo/wt-a"]);
        assert!(report.kept_back.is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_refusal_is_carried_into_the_report_rather_than_dropped() {
        // A caller that cannot tell "nothing to do" from "I declined to touch this" will assume the
        // pool is capped when it is not.
        let root = scratch("refused");
        let trees = vec![Tree {
            name: "/repo/wt-junction".into(),
            branch: Some("parked-junction".into()),
            blocked: Some("node_modules is a symlink/junction".into()),
            last_built_ms: 1.0,
            last_active_ms: 1.0,
            ..Tree::default()
        }];
        let plan = plan_cap(&trees, 0, 0.0, f64::MAX);
        let report = apply(&root, &trees, &plan, true);
        assert!(report.removed.is_empty());
        assert_eq!(report.refused.len(), 1);
        assert_eq!(report.refused[0].0, "/repo/wt-junction");
        std::fs::remove_dir_all(&root).ok();
    }
}
