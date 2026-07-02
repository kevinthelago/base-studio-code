//! Git command execution (#1300) — the small family of helpers that shell out to `git` and parse
//! its output: line lists, trimmed stdout, worktree-aware path resolution, and `info/exclude`
//! maintenance. Extracted verbatim from `lib.rs`.

use crate::prelude::{run_capture, run_ok, run_output};

/// Run `git -C <cwd> <args…>` and return its stdout as trimmed, non-empty lines; empty on any
/// failure (non-zero exit, git missing).
pub(crate) fn git_lines(cwd: &str, args: &[&str]) -> Vec<String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    match run_output(&mut cmd) {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Run a git command (args verbatim — the caller supplies any `-C`), returning its trimmed stdout
/// on success, else "".
pub(crate) fn git_output(args: &[&str]) -> String {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    run_capture(&mut cmd).unwrap_or_default()
}

/// Run `git -C <cwd> <args…>` for its exit status only (stdout/stderr discarded): `true` iff git
/// ran and exited cleanly. The status-only counterpart to [`git_lines`] — folds the repeated
/// `Command::new("git") + no_window + .status().map(success).unwrap_or(false)` git-write/probe dance
/// into one worktree-aware call (#1867).
pub(crate) fn git_ok(cwd: &str, args: &[&str]) -> bool {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    run_ok(&mut cmd)
}

/// Run `git -C <cwd> <args…>` capturing output: `Ok(trimmed stdout)` on success, else `Err`
/// carrying git's trimmed stderr (non-zero exit) or the io error (git missing). The capture
/// counterpart to [`git_ok`], for the sites that need git's own failure message surfaced (#1867).
pub(crate) fn git_run(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(cwd).args(args);
    run_capture(&mut cmd)
}

/// Resolve a git-managed path (e.g. `info/exclude`) through git so it's correct for both layouts:
/// in a normal clone `.git` is a directory, but in a linked **worktree** `.git` is a FILE pointing
/// at `…/.git/worktrees/<id>`, and shared paths resolve to the common dir — so
/// `repo_root/.git/info/exclude` is simply wrong there. Returns None when git is unavailable or
/// `repo_root` is not a repo.
pub(crate) fn git_path(repo_root: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    let mut cmd = std::process::Command::new("git");
    cmd.arg("-C").arg(repo_root).args(["rev-parse", "--git-path", rel]);
    let out = run_output(&mut cmd).ok()?;
    if !out.status.success() { return None; }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { return None; }
    // git prints the path relative to the cwd (= repo_root) for a normal clone, or absolute for a
    // worktree's common dir. Resolve relatives against repo_root; keep absolutes as-is.
    let pb = std::path::PathBuf::from(&p);
    Some(if pb.is_absolute() { pb } else { repo_root.join(pb) })
}

/// Append `entry` to a repo's `info/exclude` (idempotent) so app-managed files (`.mcp.json`,
/// `.claude/`) stay out of `git status` — and therefore out of the warden's worktree-change signal,
/// which would otherwise quarantine every fleet worker for an "out-of-lane" edit it never made
/// (#1102). No-op when `repo_root` is not a git repo.
///
/// Resolves the exclude file through git rather than assuming `repo_root/.git/info/exclude`: in a
/// linked worktree `.git` is a file, so the assumed path doesn't exist and the write silently
/// fails — the bug that let `.mcp.json` leak into every worker's diff.
pub(crate) fn git_exclude(repo_root: &std::path::Path, entry: &str) {
    if !repo_root.join(".git").exists() { return; }
    // Fall back to the literal path only if git can't resolve it (e.g. git absent) AND `.git` is a
    // real directory — never write through a worktree's `.git` file.
    let exclude = git_path(repo_root, "info/exclude").unwrap_or_else(|| {
        repo_root.join(".git").join("info").join("exclude")
    });
    if exclude.parent().map(|p| !p.is_dir()).unwrap_or(false) {
        // Parent isn't a directory (e.g. unresolved worktree `.git` file) — bail rather than fail.
        return;
    }
    if let Some(parent) = exclude.parent() { let _ = std::fs::create_dir_all(parent); }
    // Idempotent line-append via the shared helper: the whole-line presence check (an entry counts
    // as present only as its own trimmed line, never as a substring of another) is preserved as the
    // predicate, and the entry — with its own trailing newline — is joined after a single newline.
    let _ = crate::platform::fsx::append_block_once(
        &exclude,
        |existing| existing.lines().any(|l| l.trim() == entry),
        "\n",
        &format!("{entry}\n"),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway initialized git repo (one commit on `main`), driven entirely through `git_ok`.
    fn temp_repo(tag: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("bsc-git-{tag}-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        assert!(git_ok(&cwd, &["init", "-q", "-b", "main"]), "git init");
        assert!(git_ok(&cwd, &["config", "user.email", "t@t.t"]));
        assert!(git_ok(&cwd, &["config", "user.name", "t"]));
        std::fs::write(dir.join("README.md"), "x").unwrap();
        assert!(git_ok(&cwd, &["add", "."]));
        assert!(git_ok(&cwd, &["commit", "-q", "-m", "init"]));
        dir
    }

    /// `git_ok` reports a clean exit as `true` and a non-zero exit (missing ref) as `false`.
    #[test]
    fn git_ok_reports_success_and_failure() {
        let dir = temp_repo("ok");
        let cwd = dir.to_string_lossy().into_owned();
        assert!(git_ok(&cwd, &["rev-parse", "--verify", "--quiet", "refs/heads/main"]), "main exists");
        assert!(!git_ok(&cwd, &["rev-parse", "--verify", "--quiet", "refs/heads/nope"]), "missing branch ⇒ false");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `git_run` captures trimmed stdout on success and surfaces git's stderr on failure.
    #[test]
    fn git_run_captures_stdout_and_surfaces_stderr() {
        let dir = temp_repo("run");
        let cwd = dir.to_string_lossy().into_owned();
        let branch = git_run(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).expect("rev-parse ok");
        assert_eq!(branch, "main", "captured + trimmed stdout");
        let err = git_run(&cwd, &["rev-parse", "--verify", "definitely-no-such-ref"]).unwrap_err();
        assert!(!err.is_empty(), "git's stderr surfaced on failure: {err:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
