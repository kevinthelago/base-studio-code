// The wire shape of `read_worktree_changes_batch` (#3983) — kept SPLIT on purpose.
//
// `tracked` and `untracked` are not the same risk. The warden's lane check governs what enters the
// REPO, so it reads `tracked` only: an untracked scratch file cannot collide at integration, which is
// the harm the lane exists to prevent. The Fleet UI's "uncommitted changes" display wants the union.
// Returning both — rather than making the batch tracked-only — keeps one command with one meaning.
export interface WorktreeChanges {
  /** Paths git tracks that differ from HEAD (staged + unstaged). */
  tracked: string[];
  /** Paths git does not track and `.gitignore` does not cover — scratch, logs, temp output. */
  untracked: string[];
}

/** Every change, tracked or not — what a "does this worktree have uncommitted work?" view wants. */
export function allChanges(c: WorktreeChanges | undefined): string[] {
  return [...(c?.tracked ?? []), ...(c?.untracked ?? [])];
}
