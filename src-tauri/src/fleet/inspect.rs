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

/// BATCHED [`read_worktree_changes`] (#3908) — one invoke for the WHOLE fleet instead of one per
/// worker. Results are index-aligned to `cwds`, so the caller zips them back onto its panes.
///
/// The warden re-checks every live worker on each sweep. At ~39 panes the per-pane call meant ~78 git
/// subprocesses fired through `Promise.all` in one burst, and because this is a SYNCHRONOUS
/// `#[tauri::command]` they saturated the command pool — measured 11s queue stalls that everything
/// else (including `pty_create`, normally ~100ms) then waited behind. Batching keeps the same git
/// work but pays the command-queue cost ONCE. Same tolerance as the single version: a cwd that fails
/// yields an empty list rather than failing the batch.
#[tauri::command]
pub(crate) fn read_worktree_changes_batch(cwds: Vec<String>) -> Vec<Vec<String>> {
    cwds.into_iter().map(read_worktree_changes).collect()
}

/// #3614: does `path` exist as a host directory? Normalizes a git-bash cwd first (like `pty_create`),
/// so the frontend can pass a persisted `paneCwds[...]` value verbatim. The boot reconciliation uses
/// this to detect a fleet worker whose worktree was reclaimed by the boot-GC — a vanished worktree means
/// the work landed (the GC only reclaims merged + clean), so that worker is marked ENDED instead of
/// relaunched into a deleted directory (the split-brain that jammed the backend on every boot).
#[tauri::command]
pub(crate) fn dir_exists(path: String) -> bool {
    !path.trim().is_empty() && std::path::Path::new(&to_native_path(&path)).is_dir()
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
    let dir = claude_project_transcripts_dir(&cwd);
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

#[cfg(test)]
mod relocated_tests {
    #![allow(unused_imports)]
    use super::*;
    use crate::testutil::prelude::*;

    #[test]
    fn worktree_audit_commands_tolerate_empty_cwd() {
        // The per-worker audit snapshot (#920) must never panic on a missing/blank cwd —
        // it just yields nothing so the UI shows "no data" rather than crashing.
        assert!(read_worktree_branch(String::new()).is_empty());
        assert!(read_worktree_branch("   ".into()).is_empty());
        assert!(read_worktree_commits(String::new(), 10).is_empty());
        assert!(read_worktree_commits("   ".into(), 10).is_empty());
        assert!(claude_transcript_path(String::new()).is_none());
        assert!(find_branch_pr(String::new(), "branch".into()).is_none());
        assert!(find_branch_pr("owner/repo".into(), String::new()).is_none());
    }
    #[test]
    fn merge_change_lists_dedupes_and_sorts() {
        let merged = merge_change_lists(
            vec!["src/b.ts".into(), "src/a.ts".into(), "src/b.ts".into()],
            vec!["new.ts".into(), "src/a.ts".into()],
        );
        assert_eq!(merged, vec!["new.ts", "src/a.ts", "src/b.ts"]);
        // Empty inputs yield an empty set.
        assert!(merge_change_lists(vec![], vec![]).is_empty());
    }
    #[test]
    fn read_worktree_changes_empty_cwd_is_empty() {
        assert!(read_worktree_changes(String::new()).is_empty());
        assert!(read_worktree_changes("   ".into()).is_empty());
    }

    #[test]
    fn batch_is_index_aligned_and_tolerates_bad_cwds() {
        // #3908: the warden zips results back onto its panes BY INDEX, so the batch must return
        // exactly one entry per input, in order — including for cwds that yield nothing. A short
        // or reordered result would silently attribute one worker's changes to another.
        let out = super::read_worktree_changes_batch(vec![
            String::new(),
            "   ".into(),
            format!("{}/definitely--not--here--3908", env!("CARGO_MANIFEST_DIR")),
        ]);
        assert_eq!(out.len(), 3, "one entry per input cwd, in order");
        assert!(out.iter().all(|v| v.is_empty()), "an unreadable cwd degrades to no file signal, never a failed batch");
        // An empty fleet is a no-op, not an error.
        assert!(super::read_worktree_changes_batch(vec![]).is_empty());
    }

    #[test]
    fn dir_exists_true_for_a_real_dir_false_otherwise() {
        // The crate manifest dir is a guaranteed-real directory.
        let real = env!("CARGO_MANIFEST_DIR").to_string();
        assert!(super::dir_exists(real), "an existing directory reports true");
        assert!(!super::dir_exists(String::new()), "empty path is false (no silent home)");
        assert!(!super::dir_exists("   ".into()), "blank path is false");
        assert!(
            !super::dir_exists(format!("{}/definitely--not--here--3614", env!("CARGO_MANIFEST_DIR"))),
            "a missing worktree-shaped path is false (→ worker marked done, not relaunched)",
        );
    }
}

/// Stream ids whose work has **LANDED** — their branch is an ancestor of its repo clone's HEAD (#3931).
///
/// This is the durable floor of the dependency gate. The readiness model (#199) speaks latches fed by
/// `bsc-landed`/`merged`/`closed` coord events, but measurement on both live fleets found that floor
/// empty: `network-monitor` has **zero** coord events and **zero** plan.db issues, so an issue-keyed or
/// session-keyed latch would never satisfy and every dependent would stay dark permanently — strictly
/// worse than launching everything. Branch-merge state is the one signal that actually exists: it is
/// written by the act of merging, survives log rotation and app restarts, needs no agent to remember an
/// emitter, and is the SAME evidence `worktree_is_disposable` already trusts to reclaim a worktree.
///
/// Branch names are stream ids by convention (`ensure_worktree` creates `<streamId>`), so the returned
/// set is directly comparable to `dependsOn` entries. Cost is ONE `git branch --merged HEAD` per repo —
/// a set intersection — not one `merge-base` per stream: 1 subprocess for a 38-stream fleet.
///
/// The result also contains the BASE branches (`main`, `develop`) — they are trivially their own
/// ancestors. That is harmless: `landedStreams` only ever admits ids that are streams in the fleet, so a
/// base-branch name can't satisfy a dep unless a stream is literally named `main`. Filtering here would
/// need this command to know the base branch per repo for no gain.
///
/// Tolerant by design: a hub that doesn't exist, a subdir that isn't a clone, or a git failure
/// contributes nothing rather than failing the call. An empty result therefore means "no evidence of
/// landing", which the caller must treat as *not satisfied* — never as "everything is done".
#[tauri::command]
pub(crate) fn fleet_landed_streams(project_key: String) -> Vec<String> {
    let hub = crate::project_dir(&project_key);
    let Ok(rd) = std::fs::read_dir(&hub) else { return Vec::new() };
    let mut landed: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for entry in rd.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let repo = entry.path();
        if !repo.join(".git").exists() {
            continue;
        }
        // `--merged HEAD` asks git for the whole ancestor set in one pass. `--format` keeps the output
        // bare (no `*` current-branch marker, no leading whitespace to trim).
        for name in git_lines(&repo.to_string_lossy(), &["branch", "--merged", "HEAD", "--format=%(refname:short)"]) {
            let n = name.trim();
            if !n.is_empty() {
                landed.insert(n.to_string());
            }
        }
    }
    landed.into_iter().collect()
}
