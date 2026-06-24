// Done-time per-worker audit (#920). Assembles the concrete output of a finished worker —
// what it changed (diff/commits), where it shipped (the PR), and the raw conversation
// (Claude's transcript) — by reading the worktree + GitHub at view time. Every piece is
// tolerant (the backend commands return empty/None on failure), so a partial worktree still
// renders what it can. The durable, structured record (tool/coord/decisions) is already shown
// on the worker page; this is the snapshot it was missing.

import { invoke } from "@tauri-apps/api/core";

export interface WorktreeCommit {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

export interface BranchPr {
  number: number;
  url: string;
  /** OPEN | CLOSED | MERGED */
  state: string;
  merged: boolean;
}

export interface DoneAudit {
  /** Current branch of the worktree. */
  branch: string;
  /** Recent commits on the branch, newest first. */
  commits: WorktreeCommit[];
  /** Uncommitted changed files (vs HEAD + untracked). */
  changedFiles: string[];
  /** The PR opened from the branch, or null when there's none / gh is unavailable. */
  pr: BranchPr | null;
  /** Path to Claude's transcript `.jsonl`, or null when there's no history. */
  transcriptPath: string | null;
}

/**
 * Assemble the done-time audit for a worker's worktree `cwd` (and its `repo`, for the PR
 * lookup). Never rejects — each command failure degrades to an empty value.
 */
export async function loadDoneAudit(cwd: string, repo: string): Promise<DoneAudit> {
  if (!cwd) return { branch: "", commits: [], changedFiles: [], pr: null, transcriptPath: null };
  const [branch, commits, changedFiles, transcriptPath] = await Promise.all([
    invoke<string>("read_worktree_branch", { cwd }).catch(() => ""),
    invoke<WorktreeCommit[]>("read_worktree_commits", { cwd, limit: 20 }).catch(() => [] as WorktreeCommit[]),
    invoke<string[]>("read_worktree_changes", { cwd }).catch(() => [] as string[]),
    invoke<string | null>("claude_transcript_path", { cwd }).catch(() => null),
  ]);
  const pr = branch && repo
    ? await invoke<BranchPr | null>("find_branch_pr", { repo, branch }).catch(() => null)
    : null;
  return { branch, commits, changedFiles, pr, transcriptPath };
}
