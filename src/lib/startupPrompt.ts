// Resolves which unified-store document supplies a session's startup prompt.
//
// A console/triage session can be seeded with an initial prompt (the plan is
// already in Claude's memory; this is the kickoff message). Which document
// supplies it is assignable at three levels with an override chain:
//
//   per-repo  →  per-project  →  global default  →  (built-in fallback)
//
// Values are document relpaths from the unified store, or null = "inherit".

export interface StartupPromptAssignments {
  /** Global default document relpath, or null for the built-in prompt. */
  defaultStartupPromptDoc: string | null;
  /** Per-project overrides, keyed by project id. */
  projectStartupPromptDoc: Record<string, string | null>;
  /** Per-repo overrides, keyed by {@link repoPromptKey}. */
  repoStartupPromptDoc: Record<string, string | null>;
}

/** Composite key for a per-repo override scoped to a project. */
export function repoPromptKey(projectId: string, repo: string): string {
  return `${projectId}::${repo}`;
}

/**
 * Resolves the document relpath for a (project, repo) session's startup prompt,
 * following repo → project → global default. A `null`/absent value at a level
 * means "inherit" and falls through. Returns `null` when nothing is assigned at
 * any level, in which case the caller uses the built-in default prompt.
 */
export function resolveStartupPromptDoc(
  a: StartupPromptAssignments,
  projectId: string,
  repo: string,
): string | null {
  const repoVal = a.repoStartupPromptDoc[repoPromptKey(projectId, repo)];
  if (repoVal) return repoVal;
  const projVal = a.projectStartupPromptDoc[projectId];
  if (projVal) return projVal;
  return a.defaultStartupPromptDoc ?? null;
}
