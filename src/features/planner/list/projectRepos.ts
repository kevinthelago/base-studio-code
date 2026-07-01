// Resolve which repos are linked to a project for the planning UI (#833). Pure + testable.
//
// There are two regimes:
// - **Published** project (a GitHub board exists → `activeProjectId`): use the board's repos,
//   falling back to the locally-linked set if the board hasn't loaded yet.
// - **Unpublished** project (no board yet): use the linked+cloned repos persisted under the
//   title-derived `effectiveProjectId`. The linked set is DB-owned (`bsc plan repo add` → plan.db,
//   reflected into `projectLocalRepos` by the section poll), so it survives a restart.
//
// KEY MISMATCH (#881): linked repos are written under TWO keys — the title-derived
// `effectiveProjectId` (the planning link + auto-clone path) and the GitHub node id
// `activeProjectId` (the published-project + header path). Once a repo is cloned,
// `projectKeyAlias` maps the node id → title key, so the two diverge. Reading only one key
// dropped links written under the other, so they vanished on restart → relink. We now read
// the local set from BOTH keys (deduped) so a link survives regardless of which key wrote it.

/** Deduped union of the persisted local links under every given key. Exported so the planning
 *  page reads the cloned/linked set under the same dual keys (avoids the #881 mismatch). */
export function localReposFor(projectLocalRepos: Record<string, string[]>, ...keys: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    if (!key) continue;
    for (const r of projectLocalRepos[key] ?? []) if (!seen.has(r)) { seen.add(r); out.push(r); }
  }
  return out;
}

export function effectiveProjectRepos(
  activeProjectId: string | null | undefined,
  effectiveProjectId: string,
  activeProjectRepos: string[],
  projectLocalRepos: Record<string, string[]>,
): string[] {
  // Links may be stored under either the node id or the title key — read both.
  const local = localReposFor(projectLocalRepos, effectiveProjectId, activeProjectId);
  if (activeProjectId) {
    // Published: the board's repos are authoritative once loaded; until then, the persisted
    // local links (under either key) stand in so they don't vanish during the load gap.
    return activeProjectRepos.length > 0 ? activeProjectRepos : local;
  }
  return local;
}
