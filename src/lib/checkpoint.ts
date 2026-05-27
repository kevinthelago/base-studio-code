// Triage session continuity ("begin where we left off").
//
// A triage session writes a short "where we left off" note via the `bsc-checkpoint`
// shell helper, which overwrites a per-repo *checkpoint document* in the unified
// store (plain file — no Tauri IPC). At the next triage launch the checkpoint is
// composed onto the triage prompt so the agent resumes with that context.
//
// Pure logic only; the wiring lives in the store (assigns the per-pane checkpoint
// doc), TerminalView (composes at launch), and pty_create (env + helper injection).

/** Heading the previous session's checkpoint is appended under, in the next prompt. */
export const CHECKPOINT_HEADING = "# Where we left off (from your previous session)";

/**
 * Compose the prompt baked into a triage launch: the base triage prompt, plus —
 * when a prior session left a non-empty checkpoint — that checkpoint under a clear
 * heading so the agent resumes with it. Returns `base` unchanged when there's no
 * checkpoint (first run, or it was never written).
 *
 * @param base the triage prompt (verbatim TRIAGE_PROMPT or a resolved doc).
 * @param checkpoint the prior session's checkpoint text, or null/undefined/empty.
 */
export function composeStartupPrompt(base: string, checkpoint: string | null | undefined): string {
  const note = (checkpoint ?? "").trim();
  if (!note) return base;
  return `${base}\n\n${CHECKPOINT_HEADING}\n\n${note}`;
}

/**
 * Unified-store relpath for a repo's triage checkpoint document. `sanitizedKey` is
 * the on-disk project folder (sanitize_project_key); `repo` is the full name
 * (owner/name) — only the name segment is used, slugged to a filesystem-safe stem.
 * Mirrors {@link scriptDocRelpath}'s `projects/{key}/prompts/…` layout so it lands
 * beside the planner-authored startup scripts.
 */
export function checkpointDocRelpath(sanitizedKey: string, repo: string): string {
  const name = (repo.split("/").pop() || repo).trim();
  const slug = (name.replace(/[^A-Za-z0-9._-]/g, "-") || "repo").toLowerCase();
  return `projects/${sanitizedKey}/prompts/${slug}-checkpoint.md`;
}
