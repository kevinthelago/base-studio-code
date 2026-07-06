// Local published inventory (#2445, epic #2444) — the offline entry point for published projects.
//
// Published projects used to exist in the UI only as live `projectsV2` query results: logged out of
// GitHub, `fetchProjects` never runs and `buildDrafts` drops published hubs, so a published project
// appeared in NEITHER Projects column (and a restored fleet ran with no reachable surface). The
// on-disk hubs already carry everything the column needs — the `.published` marker and the `.title`
// display name — so the published column renders from THIS local selection first, and the GitHub
// records OVERLAY it when the query returns: a hub matched by a fetched board drops out of the local
// list (the board's `ProjectRow` — status/progress/url/counts — is the richer rendering of the same
// project).
//
// Matching mirrors the `mark_published` reconcile in ProjectsList (#922/#2409): a board covers a hub
// when the hub's folder key equals the board's name-derived `projectSlug(title)` (today's keys) or
// the legacy `sanitizeProjectKey(title)` (grandfathered title-keyed hubs), or when the titles match
// case-insensitively.

import { projectSlug, sanitizeProjectKey } from "@/shared/lib/core/projectPaths";
import type { LocalProjectLite } from "./drafts";

/** A published hub rendered from the local inventory — key is the identity (the hub folder key). */
export interface LocalPublishedRow { key: string; title: string; updatedAt: number }

/**
 * Select the local published hubs NOT covered by a fetched GitHub board.
 *
 * @param localProjects on-disk hubs from `list_local_projects` (carry `.published` + `.title`).
 * @param ghProjects    the fetched (visible) GitHub boards — empty while logged out / before the
 *                      query lands, so every published hub renders locally until the overlay arrives.
 * @returns local-only published rows, unsorted (caller sorts).
 */
export function buildLocalPublished(
  localProjects: LocalProjectLite[],
  ghProjects: Array<{ title: string }>,
): LocalPublishedRow[] {
  const safeLocals = Array.isArray(localProjects) ? localProjects : [];
  const ghTitles = new Set(ghProjects.map((p) => p.title.toLowerCase()));
  const ghKeys = new Set(ghProjects.flatMap((p) => [projectSlug(p.title), sanitizeProjectKey(p.title)]));
  return safeLocals
    .filter((lp) => lp?.published && !ghKeys.has(lp.key) && !ghTitles.has(lp.title.toLowerCase()))
    .map((lp) => ({ key: lp.key, title: lp.title, updatedAt: lp.updatedAt }));
}
