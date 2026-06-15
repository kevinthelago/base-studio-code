// Resolve which repos are linked to a project for the planning UI (#833). Pure + testable.
//
// There are two regimes:
// - **Published** project (a GitHub board exists → `activeProjectId`): use the board's repos,
//   falling back to the locally-cloned set if the board hasn't loaded yet.
// - **Unpublished** project (no board yet): use the linked+cloned repos persisted under the
//   title-derived `effectiveProjectId`. Without this the links vanish on restart — the
//   in-session list (`<repo_link>` tags) lives in component state that resets, while the
//   persisted `projectLocalRepos` record was never read back for the no-board case.

export function effectiveProjectRepos(
  activeProjectId: string | null | undefined,
  effectiveProjectId: string,
  activeProjectRepos: string[],
  projectLocalRepos: Record<string, string[]>,
): string[] {
  if (activeProjectId) {
    return activeProjectRepos.length > 0 ? activeProjectRepos : (projectLocalRepos[activeProjectId] ?? []);
  }
  return projectLocalRepos[effectiveProjectId] ?? [];
}
