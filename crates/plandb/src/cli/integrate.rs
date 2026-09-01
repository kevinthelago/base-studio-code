//! `bsc plan integrate <ref>` — merge `<ref>` into the current directory's checked-out branch,
//! serialized against every other `bsc plan integrate` call on the SAME directory (request #185: two
//! sessions running `git merge --no-ff` directly in the same `wt-integrate` working tree at once raced
//! each other's git state — one session's in-progress conflict resolution was visible, mid-resolution,
//! to a `git status` run by the other, and a file briefly held live `<<<<<<< HEAD` markers before the
//! OTHER session's own commit resolved it).
//!
//! This wraps the exact manual step the workflow doc already describes
//! (`cd wt-integrate && git merge --no-ff <ref>`) with a lock, so a second caller waits its turn
//! instead of touching the same working tree mid-merge. It does not read or write plan.db — it lives
//! under `bsc plan` because it is step 7 of the plan workflow, not because it needs the store.
//!
//! The lock is [`bsc_util::filelock`] — see that module's doc for why staleness there is time-only
//! rather than pid-liveness: a real conflict is resolved by a human across several separate commands
//! (edit, `git add`, `git commit`), long after THIS process has exited, so the lock must outlive it.
//!
//! ## Two outcomes on a non-zero `git merge`
//! - **No `MERGE_HEAD`** — git refused outright (a dirty tree, unrelated histories, a bad ref).
//!   Nothing for a human to resolve, so the lock is released immediately and the error is git's own
//!   stderr.
//! - **`MERGE_HEAD` present** — a real conflict. The lock is LEAKED (left held past this process
//!   exiting) and the error names the exact `--release` command; the caller resolves by hand and then
//!   runs it to free the directory for the next session.

use super::Args;
use bsc_sqlite_util::print_json;
use bsc_util::filelock;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

const LOCK_PREFIX: &str = "integrate";

/// Generous on purpose (module doc): a conflict is resolved by a human across several separate
/// commands, potentially with a break in the middle. Long enough that a real work session never trips
/// it; short enough that a session that genuinely forgot `--release` cannot wedge the directory for
/// every future caller forever.
const MAX_AGE_MS: i64 = 6 * 60 * 60 * 1000;
const POLL: Duration = Duration::from_millis(500);

pub(crate) fn cmd_integrate(args: &Args) -> Result<(), String> {
    if args.release {
        return cmd_release(args);
    }
    let r = args
        .positional
        .get(1)
        .ok_or("usage: bsc plan integrate <ref> [--dir <path>]\n       bsc plan integrate --release [--dir <path>]")?;
    let dir = integrate_dir(args)?;
    let name = filelock::lock_name(LOCK_PREFIX, &dir);

    let lock = filelock::acquire_blocking(&name, MAX_AGE_MS, POLL, |held| {
        eprintln!(
            "waiting for the wt-integrate lock on {} (held by pid {} since {})...",
            dir.display(),
            held.pid,
            bsc_util::epoch_ms_to_iso8601(held.at_ms),
        );
    })
    .map_err(|e| format!("could not acquire the integrate lock on {}: {e}", dir.display()))?;

    // HEAD BEFORE the merge, so "did anything actually land" is answerable afterwards rather than
    // inferred from an exit code.
    let before = git_head_sha(&dir);

    let out = Command::new("git")
        .arg("merge")
        .arg("--no-ff")
        .arg(r)
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("could not run `git merge --no-ff {r}` in {}: {e}", dir.display()))?;

    if out.status.success() {
        // A ZERO EXIT IS NOT A MERGE. `git merge` exits 0 for `Already up to date` without creating a
        // commit, so the old success branch could not tell a merge from a no-op — and the sha it
        // printed was simply whatever HEAD was, INCLUDING a merge another session had just made in
        // this shared tree. That is what reported a merge that never happened
        // (`bsc-plan-integrate-reports-a-merge-it-did-not-perform`), and the workflow deletes the
        // branch on the strength of this line.
        let after = git_head_sha(&dir);
        let outcome = merge_outcome(is_ancestor(&dir, r), before.as_deref(), after.as_deref());
        lock.release();
        let merged = outcome_to_result(outcome, r, &dir)?;
        let sha = after.clone().unwrap_or_default();
        if args.json {
            print_json(
                &serde_json::json!({
                    "ref": r,
                    "dir": dir.display().to_string(),
                    "sha": sha,
                    // The distinction a scripted caller needs: it is what decides whether this run is
                    // the one that landed the work.
                    "merged": merged,
                    "alreadyUpToDate": !merged,
                }),
                args.pretty,
            );
        } else if merged {
            println!("merged {r} into {} — merge commit {sha}", dir.display());
        } else {
            // Still Ok: the ref IS in, so deleting the branch is safe. It just was not this run that
            // put it there, and saying "merged" would be a lie a re-run tells every time.
            println!("{r} was ALREADY merged into {} — nothing to do, HEAD stays {sha}", dir.display());
        }
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if merge_head_present(&dir) {
        // A real conflict: leave the lock held so no other `bsc plan integrate` touches this tree
        // while it sits half-resolved. `leak` is the deliberate "still working on it, outside this
        // process" path filelock's module doc describes.
        lock.leak();
        return Err(format!(
            "merge of {r} into {} left conflicts — resolve them (edit, `git add`, `git commit`), \
             then run `bsc plan integrate --release --dir {}` to free the lock for the next session.\n\n{stderr}",
            dir.display(),
            dir.display(),
        ));
    }

    lock.release();
    Err(format!("git merge --no-ff {r} in {} failed:\n{stderr}", dir.display()))
}

/// `bsc plan integrate --release [--dir <path>]` — free a lock a prior `integrate` call LEAKED after
/// hitting a conflict. Only touches the lock file; the caller is responsible for the git state itself
/// (a completed merge commit, or `git merge --abort`) before calling this.
fn cmd_release(args: &Args) -> Result<(), String> {
    let dir = integrate_dir(args)?;
    let name = filelock::lock_name(LOCK_PREFIX, &dir);
    let freed = filelock::release_named(&name).map_err(|e| e.to_string())?;
    if args.json {
        print_json(&serde_json::json!({"dir": dir.display().to_string(), "released": freed}), args.pretty);
    } else if freed {
        println!("released the integrate lock on {}", dir.display());
    } else {
        println!("no integrate lock was held on {}", dir.display());
    }
    Ok(())
}

fn integrate_dir(args: &Args) -> Result<PathBuf, String> {
    match &args.dir {
        Some(d) => Ok(PathBuf::from(d)),
        None => std::env::current_dir().map_err(|e| format!("could not resolve the current directory: {e}")),
    }
}

fn merge_head_present(dir: &Path) -> bool {
    Command::new("git")
        .args(["rev-parse", "-q", "--verify", "MERGE_HEAD"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// What a zero-exit `git merge` ACTUALLY did.
///
/// The whole bug this type exists for: `git merge` exits 0 both when it creates a merge commit and
/// when it has nothing to do, and the old code could not tell those apart — so a no-op printed the
/// same sentence a real merge printed, with whatever sha HEAD happened to be. Keeping the decision
/// as a value (rather than as a branch inside a println) is what makes it testable at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MergeOutcome {
    /// HEAD moved and the ref is in: this run landed it.
    Merged,
    /// The ref was already in and HEAD did not move. Safe — but this run did not land it, and
    /// saying "merged" would be a lie every idempotent re-run tells.
    AlreadyUpToDate,
    /// A zero exit that left the ref OUT. The dangerous one: the workflow deletes the branch on the
    /// strength of the success line, and the commits are only on that branch.
    NotMerged,
}

/// Classify the merge from what git can be asked afterwards, never from the exit status alone.
pub(crate) fn merge_outcome(is_ancestor: bool, before: Option<&str>, after: Option<&str>) -> MergeOutcome {
    if !is_ancestor {
        return MergeOutcome::NotMerged;
    }
    if before == after {
        MergeOutcome::AlreadyUpToDate
    } else {
        MergeOutcome::Merged
    }
}

/// Turn the classification into the caller's result: `Ok(true)` landed it, `Ok(false)` found it
/// already in, `Err` means nothing was merged.
///
/// Split out so the ERROR PATH is testable. `git merge` will not produce a zero exit with the ref
/// left out on demand, so [`MergeOutcome::NotMerged`] cannot be driven end to end through a real
/// repo — which is exactly why the branch that acts on it is a function with its own test rather
/// than an `if` nothing can reach.
pub(crate) fn outcome_to_result(outcome: MergeOutcome, r: &str, dir: &Path) -> Result<bool, String> {
    match outcome {
        MergeOutcome::Merged => Ok(true),
        MergeOutcome::AlreadyUpToDate => Ok(false),
        MergeOutcome::NotMerged => Err(format!(
            "`git merge --no-ff {r}` exited 0 in {}, but {r} is NOT an ancestor of HEAD — nothing \
             was merged. DO NOT DELETE THE BRANCH: its commits are only on it. Re-run the \
             integrate, and if it reports this again, merge by hand and read git's own output.",
            dir.display()
        )),
    }
}

/// Is `r` an ancestor of `HEAD` in `dir`? The question "did this ref actually get in", asked of git
/// rather than inferred from an exit status.
fn is_ancestor(dir: &Path, r: &str) -> bool {
    Command::new("git")
        .args(["merge-base", "--is-ancestor", r, "HEAD"])
        .current_dir(dir)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn git_head_sha(dir: &Path) -> Option<String> {
    let out = Command::new("git").args(["rev-parse", "HEAD"]).current_dir(dir).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // `filelock` keys off `$HOME`/`$USERPROFILE`, process-global env state — tests here must not
    // interleave with each other or with `bsc-util`'s own filelock tests (they run in a different
    // process/binary, but within THIS crate's test binary they'd race on the same var).
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct HomeGuard {
        _guard: std::sync::MutexGuard<'static, ()>,
        prior: Option<String>,
        var: &'static str,
    }
    impl HomeGuard {
        fn set(dir: &Path) -> Self {
            let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
            let prior = std::env::var(var).ok();
            std::env::set_var(var, dir);
            Self { _guard: guard, prior, var }
        }
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            match &self.prior {
                Some(v) => std::env::set_var(self.var, v),
                None => std::env::remove_var(self.var),
            }
        }
    }

    fn tmp_dir(label: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!(
            "bsc-plan-integrate-test-{label}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").args(args).current_dir(dir).output().expect("git runs");
        assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn write(dir: &Path, name: &str, contents: &str) {
        std::fs::write(dir.join(name), contents).unwrap();
    }

    /// A repo with `develop` at one commit and a feature branch `feat` one commit ahead, both touching
    /// DIFFERENT files — a clean, no-conflict merge.
    fn clean_merge_repo(home: &Path) -> PathBuf {
        let dir = home.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "develop"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "user.name", "test"]);
        write(&dir, "base.txt", "base\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "base"]);
        git(&dir, &["checkout", "-q", "-b", "feat"]);
        write(&dir, "feat.txt", "feature\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "feat"]);
        git(&dir, &["checkout", "-q", "develop"]);
        dir
    }

    fn args_for(dir: &Path, r: &str) -> Args {
        let mut a = super::super::parse_args(vec!["integrate".into(), r.into(), "--dir".into(), dir.display().to_string()])
            .expect("args parse");
        a.prog = "bsc plan".into();
        a
    }

    #[test]
    fn a_clean_merge_integrates_and_releases_the_lock() {
        let home = tmp_dir("clean");
        let _g = HomeGuard::set(&home);
        let repo = clean_merge_repo(&home);

        let args = args_for(&repo, "feat");
        cmd_integrate(&args).expect("clean merge succeeds");

        assert!(repo.join("feat.txt").exists(), "the merged branch's file is present");
        let name = filelock::lock_name(LOCK_PREFIX, &repo);
        assert!(!filelock::is_held(&name, MAX_AGE_MS), "a successful merge releases the lock");
    }

    #[test]
    fn a_conflicting_merge_leaks_the_lock_instead_of_releasing_it() {
        let home = tmp_dir("conflict");
        let _g = HomeGuard::set(&home);
        let dir = home.join("repo");
        std::fs::create_dir_all(&dir).unwrap();
        git(&dir, &["init", "-q", "-b", "develop"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "user.name", "test"]);
        write(&dir, "same.txt", "base\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "base"]);
        git(&dir, &["checkout", "-q", "-b", "feat"]);
        write(&dir, "same.txt", "from feat\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "feat"]);
        git(&dir, &["checkout", "-q", "develop"]);
        write(&dir, "same.txt", "from develop\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "develop-edit"]);

        let args = args_for(&dir, "feat");
        let err = cmd_integrate(&args).expect_err("a real conflict is reported as an error");
        assert!(err.contains("--release"), "the error names the release command: {err}");

        let name = filelock::lock_name(LOCK_PREFIX, &dir);
        assert!(filelock::is_held(&name, MAX_AGE_MS), "the lock is LEAKED, not released, on a real conflict");

        // Resolve the conflict by hand, exactly as the error instructs.
        write(&dir, "same.txt", "resolved\n");
        git(&dir, &["add", "."]);
        git(&dir, &["commit", "-q", "-m", "resolve"]);

        let mut release_args =
            super::super::parse_args(vec!["integrate".into(), "--release".into(), "--dir".into(), dir.display().to_string()])
                .expect("args parse");
        release_args.prog = "bsc plan".into();
        cmd_release(&release_args).expect("release succeeds");
        assert!(!filelock::is_held(&name, MAX_AGE_MS), "--release frees the lock");
    }

    #[test]
    fn a_second_call_waits_for_the_first_instead_of_racing_it() {
        let home = tmp_dir("serialize");
        let _g = HomeGuard::set(&home);
        let repo = clean_merge_repo(&home);
        let name = filelock::lock_name(LOCK_PREFIX, &repo);

        // Simulate another session mid-merge, exactly like the leaked-lock path above: the lock is
        // held and nobody is coming back to release it on a timer.
        let held = filelock::try_claim(&name, MAX_AGE_MS).unwrap().unwrap();
        held.leak();
        assert!(filelock::is_held(&name, MAX_AGE_MS));

        // Free it shortly after from another thread — standing in for the other session finishing its
        // own merge and running `--release`.
        let release_name = name.clone();
        let releaser = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(200));
            filelock::release_named(&release_name).unwrap();
        });

        let args = args_for(&repo, "feat");
        cmd_integrate(&args).expect("blocks until the lock frees, then proceeds instead of racing it");
        releaser.join().unwrap();

        assert!(repo.join("feat.txt").exists());
        assert!(!filelock::is_held(&name, MAX_AGE_MS), "the second call releases the lock on its own success");
    }

    #[test]
    fn a_refused_merge_with_no_merge_head_releases_the_lock() {
        let home = tmp_dir("refused");
        let _g = HomeGuard::set(&home);
        let repo = clean_merge_repo(&home);
        // Dirty a file the INCOMING merge would itself touch (`feat.txt`, untracked here since
        // `feat` added it) so git refuses to even start the merge — an unrelated dirty file (e.g.
        // `base.txt`, which neither side's commit touches) does not block a merge at all, so this
        // has to collide with the merge's own changes to reproduce "no MERGE_HEAD is ever created".
        write(&repo, "feat.txt", "dirty, uncommitted, untracked\n");

        let args = args_for(&repo, "feat");
        let err = cmd_integrate(&args).expect_err("git refuses on a dirty tree");
        assert!(!err.contains("--release"), "a refusal with no conflict is not a leaked-lock error: {err}");

        let name = filelock::lock_name(LOCK_PREFIX, &repo);
        assert!(!filelock::is_held(&name, MAX_AGE_MS), "a plain refusal releases the lock rather than leaking it");
    }
    /// A REAL MERGE MOVES HEAD, and the reported sha is the merge commit it created.
    #[test]
    fn a_real_merge_reports_the_commit_it_created() {
        let home = tmp_dir("real-merge");
        let _h = HomeGuard::set(&home);
        let dir = clean_merge_repo(&home);
        let before = git_head_sha(&dir).unwrap();

        cmd_integrate(&args_for(&dir, "feat")).expect("a clean merge succeeds");

        let after = git_head_sha(&dir).unwrap();
        assert_ne!(before, after, "a real merge must move HEAD");
        assert!(is_ancestor(&dir, "feat"), "and the ref must be in");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// AN `ALREADY UP TO DATE` NO-OP IS NOT A MERGE. This is the bug that was shipping: `git merge`
    /// exits 0 without creating a commit, and the old code printed `merged … HEAD is now <sha>` —
    /// the same sentence a real merge prints, with whatever sha HEAD happened to be.
    ///
    /// It stays Ok, deliberately: the ref IS in, so deleting the branch is safe. What must not
    /// happen is claiming this run landed it.
    #[test]
    fn an_already_merged_ref_is_reported_as_a_no_op_not_as_a_merge() {
        let home = tmp_dir("noop-merge");
        let _h = HomeGuard::set(&home);
        let dir = clean_merge_repo(&home);

        cmd_integrate(&args_for(&dir, "feat")).expect("the first merge lands");
        let after_first = git_head_sha(&dir).unwrap();

        // Second call: git says `Already up to date` and exits 0.
        cmd_integrate(&args_for(&dir, "feat")).expect("a no-op is still Ok — the ref is in");
        let after_second = git_head_sha(&dir).unwrap();

        assert_eq!(after_first, after_second, "the second call must not create a commit");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// THE DANGEROUS CASE, and the reason this item exists: a zero exit that leaves the ref UNMERGED
    /// must be an error, because the workflow deletes the branch on the strength of the success line.
    ///
    /// Driven through the predicate rather than by faking a git failure: `is_ancestor` is the check
    /// the success path now makes, and a ref that was never merged must answer false. If it ever
    /// answers true for an unmerged ref, the guard is decorative.
    #[test]
    fn an_unmerged_ref_is_not_an_ancestor_so_the_guard_can_fire() {
        let home = tmp_dir("unmerged");
        let _h = HomeGuard::set(&home);
        let dir = clean_merge_repo(&home);

        assert!(!is_ancestor(&dir, "feat"), "feat is NOT merged yet — the guard's precondition");
        cmd_integrate(&args_for(&dir, "feat")).expect("merge");
        assert!(is_ancestor(&dir, "feat"), "and true once it is");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// THE DECISION ITSELF, asserted as a value rather than through git's side effects.
    ///
    /// My first pass at these tests only checked that HEAD did or did not move — which is git's
    /// behaviour, true whatever this code reports, so reverting the distinction would not have
    /// failed them. This is the assertion that bites.
    #[test]
    fn the_outcome_distinguishes_a_merge_a_no_op_and_an_unmerged_ref() {
        // HEAD moved and the ref is in.
        assert_eq!(merge_outcome(true, Some("aaa"), Some("bbb")), MergeOutcome::Merged);
        // The ref is in but nothing moved — a re-run, not a landing.
        assert_eq!(merge_outcome(true, Some("aaa"), Some("aaa")), MergeOutcome::AlreadyUpToDate);
        // THE DANGEROUS ONE: a zero exit that left the ref out. It must not read as either success.
        assert_eq!(merge_outcome(false, Some("aaa"), Some("bbb")), MergeOutcome::NotMerged);
        assert_eq!(merge_outcome(false, Some("aaa"), Some("aaa")), MergeOutcome::NotMerged);
        // An unreadable HEAD must not silently become "merged" — not an ancestor still wins.
        assert_eq!(merge_outcome(false, None, None), MergeOutcome::NotMerged);
        // And an ancestor with an unreadable HEAD on both sides is a no-op, never a claimed merge.
        assert_eq!(merge_outcome(true, None, None), MergeOutcome::AlreadyUpToDate);
    }

    /// THE ERROR PATH, which no real repo can drive: git will not exit 0 with the ref left out.
    /// So the branch that acts on that classification is tested directly, and the message is part of
    /// the contract — it is read by whoever is about to delete a branch.
    #[test]
    fn an_unmerged_outcome_is_an_error_that_says_not_to_delete_the_branch() {
        let dir = Path::new("/tmp/wt-integrate");
        assert_eq!(outcome_to_result(MergeOutcome::Merged, "feat", dir), Ok(true));
        assert_eq!(outcome_to_result(MergeOutcome::AlreadyUpToDate, "feat", dir), Ok(false));

        let err = outcome_to_result(MergeOutcome::NotMerged, "feat", dir).expect_err("must be an error");
        assert!(err.contains("DO NOT DELETE THE BRANCH"), "the message must stop the next step: {err}");
        assert!(err.contains("feat"), "and name the ref: {err}");
        assert!(err.contains("NOT an ancestor"), "and say what was checked: {err}");
    }

    /// End to end: the same call twice must classify differently, which is what a caller branches on.
    #[test]
    fn the_second_integrate_of_one_ref_classifies_as_already_up_to_date() {
        let home = tmp_dir("classify-twice");
        let _h = HomeGuard::set(&home);
        let dir = clean_merge_repo(&home);

        let before = git_head_sha(&dir);
        cmd_integrate(&args_for(&dir, "feat")).expect("first");
        let after = git_head_sha(&dir);
        assert_eq!(
            merge_outcome(is_ancestor(&dir, "feat"), before.as_deref(), after.as_deref()),
            MergeOutcome::Merged,
            "the first call lands it"
        );

        let before2 = git_head_sha(&dir);
        cmd_integrate(&args_for(&dir, "feat")).expect("second");
        let after2 = git_head_sha(&dir);
        assert_eq!(
            merge_outcome(is_ancestor(&dir, "feat"), before2.as_deref(), after2.as_deref()),
            MergeOutcome::AlreadyUpToDate,
            "the second call must NOT claim to have merged it"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

}
