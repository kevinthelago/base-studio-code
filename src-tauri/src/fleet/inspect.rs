//! Per-worker worktree audit (#920 / #1102): the git/PR signals the Fleet UI shows for each worker
//! — uncommitted changes, current branch, recent commits, the branch's PR, and the raw Claude
//! transcript path. Fleet owns worktrees, so this audit lives next to the rest of the fleet.

use crate::prelude::*;

/// Repo-relative paths a worktree session has touched but not yet committed: tracked changes
/// vs HEAD (staged + unstaged) plus untracked files. The warden's conformance check (#1102)
/// uses this as the trusted "what did this worker actually change" signal. Tolerant: returns
/// empty on any git failure (no repo, git absent) so the warden simply has no file signal
/// rather than crashing. `cwd` is the session's worktree.
#[tauri::command]
pub(crate) fn read_worktree_changes(cwd: String) -> Vec<String> {
    if cwd.trim().is_empty() {
        return Vec::new();
    }
    let tracked = git_lines(&cwd, &["diff", "--name-only", "HEAD"]);
    let untracked = git_lines(&cwd, &["ls-files", "--others", "--exclude-standard"]);
    merge_change_lists(tracked, untracked)
}
/// One commit in a worker's done-time audit (#920).
#[derive(serde::Serialize)]
pub(crate) struct WorktreeCommit {
    pub(crate) hash: String,
    pub(crate) subject: String,
    pub(crate) author: String,
    /// Committer date, ISO-8601 (`%cI`).
    pub(crate) date: String,
}
/// The current branch name of a worktree (`git rev-parse --abbrev-ref HEAD`); empty on any
/// failure. Part of the per-worker audit snapshot (#920).
#[tauri::command]
pub(crate) fn read_worktree_branch(cwd: String) -> String {
    if cwd.trim().is_empty() {
        return String::new();
    }
    git_lines(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .into_iter()
        .next()
        .unwrap_or_default()
}
/// The most recent commits on a worktree branch (newest first), for the per-worker audit
/// snapshot (#920). Tolerant: empty on any git failure. `limit` is clamped to 1..=200.
#[tauri::command]
pub(crate) fn read_worktree_commits(cwd: String, limit: usize) -> Vec<WorktreeCommit> {
    if cwd.trim().is_empty() {
        return Vec::new();
    }
    let n = limit.clamp(1, 200).to_string();
    // Tab-separated so subjects with spaces survive: %h \t %s \t %an \t %cI.
    git_lines(&cwd, &["log", "-n", &n, "--format=%h%x09%s%x09%an%x09%cI"])
        .into_iter()
        .filter_map(|l| {
            let mut p = l.splitn(4, '\t');
            let hash = p.next()?.to_string();
            if hash.is_empty() {
                return None;
            }
            Some(WorktreeCommit {
                hash,
                subject: p.next().unwrap_or("").to_string(),
                author: p.next().unwrap_or("").to_string(),
                date: p.next().unwrap_or("").to_string(),
            })
        })
        .collect()
}
/// A pull request found for a worker's branch (#920) — the concrete "did the work ship" link.
#[derive(serde::Serialize)]
pub(crate) struct BranchPr {
    pub(crate) number: u64,
    pub(crate) url: String,
    /// OPEN | CLOSED | MERGED (GitHub's `state`).
    pub(crate) state: String,
    pub(crate) merged: bool,
}
/// Find the PR opened from `branch` on `repo` (`owner/name`), via `gh pr list`. `None` when gh
/// is absent / unauthenticated / there's no PR — the audit simply shows "no PR yet". (#920)
#[tauri::command]
pub(crate) fn find_branch_pr(repo: String, branch: String) -> Option<BranchPr> {
    if repo.trim().is_empty() || branch.trim().is_empty() {
        return None;
    }
    let out = std::process::Command::new("gh")
        .args([
            "pr", "list", "--repo", &repo, "--head", &branch, "--state", "all",
            "--json", "number,url,state,mergedAt", "--limit", "1",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let first = v.as_array()?.first()?;
    Some(BranchPr {
        number: first.get("number")?.as_u64()?,
        url: first.get("url")?.as_str()?.to_string(),
        state: first.get("state").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        merged: first.get("mergedAt").map(|m| !m.is_null()).unwrap_or(false),
    })
}
/// The newest Claude transcript `.jsonl` for a worker's cwd, so the audit can surface the raw
/// conversation without re-capturing it (#920). `None` when there's no history. Reuses the same
/// per-cwd projects-dir slug Claude Code itself uses (`claude_project_dir_name`).
#[tauri::command]
pub(crate) fn claude_transcript_path(cwd: String) -> Option<String> {
    if cwd.trim().is_empty() {
        return None;
    }
    let dir = home_dir()
        .join(".claude")
        .join("projects")
        .join(claude_project_dir_name(&cwd));
    let mut newest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(&dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if let Ok(modified) = entry.metadata().and_then(|m| m.modified()) {
            if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
                newest = Some((modified, p));
            }
        }
    }
    newest.map(|(_, p)| p.to_string_lossy().into_owned())
}
/// Merge two path lists into one sorted, de-duplicated set (pure; unit-tested). A file that is
/// both modified and listed elsewhere appears once.
pub(crate) fn merge_change_lists(a: Vec<String>, b: Vec<String>) -> Vec<String> {
    let mut set: std::collections::BTreeSet<String> = a.into_iter().collect();
    set.extend(b);
    set.into_iter().collect()
}
