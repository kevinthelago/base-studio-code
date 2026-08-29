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

    let out = Command::new("git")
        .arg("merge")
        .arg("--no-ff")
        .arg(r)
        .current_dir(&dir)
        .output()
        .map_err(|e| format!("could not run `git merge --no-ff {r}` in {}: {e}", dir.display()))?;

    if out.status.success() {
        lock.release();
        let sha = git_head_sha(&dir).unwrap_or_default();
        if args.json {
            print_json(&serde_json::json!({"ref": r, "dir": dir.display().to_string(), "sha": sha}), args.pretty);
        } else {
            println!("merged {r} into {} — HEAD is now {sha}", dir.display());
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
}
