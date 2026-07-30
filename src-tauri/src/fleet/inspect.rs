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
    let c = worktree_changes(&cwd);
    merge_change_lists(c.tracked, c.untracked)
}

/// A worktree's changes, kept SPLIT by whether git is tracking them (#3983).
///
/// The two are not the same risk and must not be merged before the warden sees them. The lane check
/// exists to stop a worker's work COLLIDING AT INTEGRATION — and an untracked file has not entered the
/// repo, is not picked up by the lane's `git add`, and cannot collide with anything. Merging them made
/// a `.agentscratch.txt` indistinguishable from an out-of-lane source edit, and the warden killed four
/// workers that had ZERO tracked changes between them.
#[derive(serde::Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeChanges {
    /// Repo-relative paths git is tracking that differ from HEAD (staged + unstaged).
    pub tracked: Vec<String>,
    /// Paths git does not track and `.gitignore` does not cover — scratch, logs, temp output.
    pub untracked: Vec<String>,
}

/// Collect one worktree's changes, split. Tolerant: any git failure yields empty lists.
fn worktree_changes(cwd: &str) -> WorktreeChanges {
    if cwd.trim().is_empty() {
        return WorktreeChanges::default();
    }
    WorktreeChanges {
        tracked: git_lines(cwd, &["diff", "--name-only", "HEAD"]),
        untracked: git_lines(cwd, &["ls-files", "--others", "--exclude-standard"]),
    }
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
pub(crate) fn read_worktree_changes_batch(cwds: Vec<String>) -> Vec<WorktreeChanges> {
    // #3954: run the probes CONCURRENTLY. This was `cwds.into_iter().map(...)` — serial — and each
    // element spawns TWO git subprocesses. When the resume rebuilt network-monitor's worktrees the
    // input grew to 47 cwds, i.e. ~94 serial spawns (~97ms each) inside ONE synchronous
    // `#[tauri::command]`, which occupies a pool thread the whole time: a measured 9158ms mean, with
    // `pty_write` stuck at 3280ms and `pty_resize` at 8279ms behind it. Batching (#3908) fixed the
    // invoke COUNT but left the work serial, so it scaled straight back up with the fleet.
    //
    // Concurrency is capped: git is process-heavy, and an unbounded fan-out at 47 cwds would trade a
    // queue stall for a spawn storm (#3871). Order is preserved by writing into indexed slots, which
    // the caller's index-aligned zip depends on.
    const MAX_CONCURRENT: usize = 8;
    let mut out: Vec<WorktreeChanges> = (0..cwds.len()).map(|_| WorktreeChanges::default()).collect();
    for (chunk_idx, chunk) in cwds.chunks(MAX_CONCURRENT).enumerate() {
        let base = chunk_idx * MAX_CONCURRENT;
        std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|cwd| scope.spawn(move || worktree_changes(cwd)))
                .collect();
            for (i, h) in handles.into_iter().enumerate() {
                // A panicking probe degrades that ONE pane to "no file signal" — the same tolerance
                // the single-cwd path has — rather than poisoning the whole sweep.
                out[base + i] = h.join().unwrap_or_default();
            }
        });
    }
    out
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
        // #3983: BOTH halves empty — an unreadable cwd degrades to no file signal, never a failed
        // batch, and never a phantom tracked change that would quarantine a worker.
        assert!(
            out.iter().all(|c| c.tracked.is_empty() && c.untracked.is_empty()),
            "an unreadable cwd degrades to no file signal, never a failed batch",
        );
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
/// #3942 — MERGED IS NOT ENOUGH. `--merged HEAD` returns branches that are ancestors of OR EQUAL TO
/// HEAD, and `ensure_worktree` creates every stream's branch AT HEAD. So a branch that has never
/// received a commit came back as "merged", every stream read as finished, and the gate degraded to a
/// no-op that launched all 38 workers (and would have told a genuinely fresh fleet its whole plan was
/// already done). Measured: all 39 `network-monitor` branches pointed at ONE commit, which was HEAD.
///
/// The discriminator is the FIRST-PARENT chain. A branch tip sitting on it is a base commit — where the
/// branch was created, not something the stream produced. A merged feature branch's tip is a
/// side-branch commit, reachable from HEAD but not on its first-parent line.
///
///   · tip on the first-parent chain (incl. tip == HEAD) → pristine or a base commit → NOT landed
///   · merged, tip off the chain                         → real work, now in HEAD    → LANDED
///   · not merged (`ahead > 0`)                          → work in flight            → NOT landed
///
/// A fast-forward merge leaves the tip on the chain and so UNDER-reports. That is the safe direction:
/// under-reporting only delays a launch (and tiers 1/3 still cover it), whereas over-reporting is what
/// broke the gate outright.
///
/// The result also contains the BASE branches (`main`, `develop`) — harmless, since `landedStreams`
/// only ever admits ids that are streams in the fleet (and after this change they are excluded anyway,
/// being on their own first-parent chain).
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
        let repo_str = repo.to_string_lossy().into_owned();
        // The base line: every commit reachable from HEAD by first parents. A branch tip found here was
        // never authored on that branch — it is the base commit the branch was cut from.
        let base_line: std::collections::HashSet<String> =
            git_lines(&repo_str, &["rev-list", "--first-parent", "HEAD"])
                .into_iter()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect();
        // One pass for the merged set WITH each tip's sha, so the filter needs no per-branch spawn.
        for line in git_lines(&repo_str, &["for-each-ref", "--merged", "HEAD", "--format=%(objectname) %(refname:short)", "refs/heads"]) {
            let Some((sha, name)) = line.trim().split_once(' ') else { continue };
            let name = name.trim();
            if name.is_empty() || base_line.contains(sha.trim()) {
                continue; // pristine / base branch — no work of its own
            }
            landed.insert(name.to_string());
        }
    }
    landed.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    fn git(dir: &Path, args: &[&str]) {
        let mut c = std::process::Command::new("git");
        c.args(["-C", &dir.to_string_lossy()]).args(args);
        assert!(no_window(&mut c).status().unwrap().success(), "git {args:?}");
    }

    /// #3942: `--merged HEAD` alone reported branches that never received a commit, because
    /// `ensure_worktree` cuts each stream's branch AT HEAD and a branch at HEAD is trivially its own
    /// ancestor. Every stream then read as finished, the dependency gate became a no-op, and all 38
    /// workers launched. This drives real git through the states that must be told apart.
    #[test]
    fn only_branches_carrying_merged_work_count_as_landed() {
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = crate::testutil::temp_home("landed");
        let repo = crate::project_dir("proj").join("web");
        fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@t.t"]);
        git(&repo, &["config", "user.name", "t"]);
        fs::write(repo.join("README.md"), "x").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        // (a) PRISTINE — cut at HEAD, never committed to. Exactly what every network-monitor stream
        //     looked like, and what the old probe wrongly called landed.
        git(&repo, &["branch", "pristine"]);

        // (b) MERGED — real work, merged with --no-ff so the tip stays off the first-parent line.
        git(&repo, &["checkout", "-q", "-b", "did-work"]);
        fs::write(repo.join("feature.txt"), "y").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "work"]);
        git(&repo, &["checkout", "-q", "main"]);
        git(&repo, &["merge", "-q", "--no-ff", "-m", "merge", "did-work"]);

        // (c) IN FLIGHT — a commit that has NOT been merged.
        git(&repo, &["checkout", "-q", "-b", "in-flight"]);
        fs::write(repo.join("wip.txt"), "z").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "wip"]);
        git(&repo, &["checkout", "-q", "main"]);

        // (d) PRISTINE, CUT LATER — at the post-merge HEAD. Still no work of its own, and its tip is a
        //     base commit rather than HEAD's predecessor, so an `== HEAD` check alone would miss it.
        git(&repo, &["branch", "pristine-late"]);

        let landed = fleet_landed_streams("proj".to_string());
        assert!(landed.contains(&"did-work".to_string()), "merged work is landed: {landed:?}");
        assert!(!landed.contains(&"pristine".to_string()), "a branch cut at HEAD has landed NOTHING: {landed:?}");
        assert!(!landed.contains(&"pristine-late".to_string()), "nor one cut at a later base commit: {landed:?}");
        assert!(!landed.contains(&"in-flight".to_string()), "unmerged work is not landed: {landed:?}");
        assert!(!landed.contains(&"main".to_string()), "the base branch is not a landed stream: {landed:?}");
    }

    /// A project with no hub (or no clone) yields nothing rather than failing — an empty result means
    /// "no evidence", which the gate must treat as NOT satisfied.
    #[test]
    fn a_missing_hub_yields_no_evidence() {
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = crate::testutil::temp_home("nohub");
        assert!(fleet_landed_streams("ghost".to_string()).is_empty());
    }

    /// #3983: the two lists must stay SEPARATE. The warden lane-checks `tracked` only — an untracked
    /// file has not entered the repo, is not picked up by the lane's `git add`, and cannot collide at
    /// integration, which is the only harm the lane exists to prevent. Merging them made a
    /// `.agentscratch.txt` indistinguishable from an out-of-lane source edit, and four workers with
    /// ZERO tracked changes between them had their PTYs killed for scratch.
    #[test]
    fn worktree_changes_keeps_tracked_and_untracked_apart() {
        let _guard = crate::testutil::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let _home = crate::testutil::temp_home("wtchanges");
        let repo = crate::project_dir("proj").join("web");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-q", "-b", "main"]);
        git(&repo, &["config", "user.email", "t@t.t"]);
        git(&repo, &["config", "user.name", "t"]);
        std::fs::write(repo.join("src.txt"), "v1").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "init"]);

        // A TRACKED edit + an UNTRACKED scratch file, the exact live shape.
        std::fs::write(repo.join("src.txt"), "v2").unwrap();
        std::fs::write(repo.join(".agentscratch.txt"), "notes").unwrap();

        let c = super::worktree_changes(&repo.to_string_lossy());
        assert_eq!(c.tracked, vec!["src.txt".to_string()], "only the tracked edit is a lane signal");
        assert_eq!(c.untracked, vec![".agentscratch.txt".to_string()], "scratch stays on the untracked side");

        // Committing the scratch moves it across — the self-correcting property: scratch that stays
        // scratch never trips, scratch that gets committed does, still before integration.
        git(&repo, &["add", ".agentscratch.txt"]);
        let c2 = super::worktree_changes(&repo.to_string_lossy());
        assert!(c2.tracked.contains(&".agentscratch.txt".to_string()), "committed scratch becomes a lane signal");
        assert!(c2.untracked.is_empty());
    }
}
