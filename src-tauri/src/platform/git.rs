//! Git command execution (#1300) — the small family of helpers that shell out to `git` and parse
//! its output: line lists, trimmed stdout, worktree-aware path resolution, and `info/exclude`
//! maintenance. Extracted verbatim from `lib.rs`.

use crate::platform::process::no_window;

/// Run `git -C <cwd> <args…>` and return its stdout as trimmed, non-empty lines; empty on any
/// failure (non-zero exit, git missing).
pub(crate) fn git_lines(cwd: &str, args: &[&str]) -> Vec<String> {
    match std::process::Command::new("git").arg("-C").arg(cwd).args(args).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

/// Run a git command, returning its trimmed stdout on success, else "".
pub(crate) fn git_output(args: &[&str]) -> String {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args);
    match no_window(&mut cmd).output() {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Resolve a git-managed path (e.g. `info/exclude`) through git so it's correct for both layouts:
/// in a normal clone `.git` is a directory, but in a linked **worktree** `.git` is a FILE pointing
/// at `…/.git/worktrees/<id>`, and shared paths resolve to the common dir — so
/// `repo_root/.git/info/exclude` is simply wrong there. Returns None when git is unavailable or
/// `repo_root` is not a repo.
pub(crate) fn git_path(repo_root: &std::path::Path, rel: &str) -> Option<std::path::PathBuf> {
    let out = std::process::Command::new("git")
        .arg("-C").arg(repo_root)
        .args(["rev-parse", "--git-path", rel])
        .output()
        .ok()?;
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
    let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == entry) { return; }
    let next = if existing.trim().is_empty() {
        format!("{}\n", entry)
    } else {
        format!("{}\n{}\n", existing.trim_end(), entry)
    };
    let _ = std::fs::write(&exclude, next);
}
