// Persisted GitHub board state (#2446, epic #2444) — the pure model behind the last-known-projects
// cache. A successful `PROJECTS_QUERY` fetch is boiled down to one MINIMAL record per board
// (identity + lifecycle + progress counts + repos — enough for the Projects column, the Glance
// nodes, and the progress meters offline) and stored as `{ records, fetchedAt }`:
//   - in the zustand store (persisted; the fast-paint CACHE — golden rule: cache, not source of truth),
//   - mirrored into the bsc-project store (`~/.base-studio-code/github-state.json`, via
//     `bsc project github-state set`) so the durable copy is `bsc`-reachable (golden rule #2).
//
// Precedence at the consumers (useGlanceProjects + ProjectsList): live fetch > persisted records >
// local-inventory-only (#2445). The persisted fallback is always FILTERED to projects that still
// exist locally ({@link filterRecordsToLocal}) — a record whose hub was deleted must not resurrect
// the project; only the LIVE fetch can vouch for a GitHub-only board.
//
// Board/Issues/Insights detail (fieldValues, labels, comments) deliberately stays refetch-on-view —
// only this entry-point set persists.

import { projectSlug, sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

/** One `projectsV2` item as the wire carries it (structural twin of publishedModel's GhProjectItem). */
interface GhItemShape { content: { __typename?: string; state?: string } | null }

/**
 * The `projectsV2` node shape this module reads/synthesizes — a structural twin of the planner's
 * `GhProject` (publishedModel.ts), declared here so `shared/` stays feature-agnostic. Anything
 * matching this shape (including `GhProject` itself) interoperates both ways.
 */
export interface GhProjectShape {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  updatedAt: string;
  items: { totalCount: number; nodes: GhItemShape[] };
  repositories: { nodes: Array<{ nameWithOwner: string }> };
}

/** The minimal per-board record that persists (#2446) — identity + lifecycle + progress + repos. */
export interface MinimalGhProject {
  id: string;
  number: number;
  title: string;
  shortDescription: string | null;
  url: string;
  closed: boolean;
  updatedAt: string;
  /** True item count (the fetched item page is capped at 100; this is the headline number). */
  itemsTotalCount: number;
  /** Open issues/PRs among the fetched items (mirrors publishedModel's `projectProgress`). */
  openCount: number;
  /** Closed/merged issues/PRs among the fetched items. */
  closedCount: number;
  /** `nameWithOwner` per linked repository. */
  repos: string[];
}

/** The persisted state: the last successful fetch's records + when it landed (epoch ms). */
export interface GithubState {
  records: MinimalGhProject[];
  fetchedAt: number;
}

/**
 * Boil a fetched `projectsV2` set down to the minimal persisted records. Open/closed counts derive
 * from the fetched item states exactly like `projectProgress` (MERGED counts as closed; a draft
 * item — `content: null` — counts as neither).
 */
export function toMinimalGhProjects(projects: GhProjectShape[]): MinimalGhProject[] {
  return projects.map((p) => {
    let openCount = 0, closedCount = 0;
    for (const n of p.items?.nodes ?? []) {
      const s = n.content?.state;
      if (s === "OPEN") openCount++;
      else if (s === "CLOSED" || s === "MERGED") closedCount++;
    }
    return {
      id: p.id, number: p.number, title: p.title, shortDescription: p.shortDescription,
      url: p.url, closed: p.closed, updatedAt: p.updatedAt,
      itemsTotalCount: p.items?.totalCount ?? 0, openCount, closedCount,
      repos: (p.repositories?.nodes ?? []).map((r) => r.nameWithOwner),
    };
  });
}

/**
 * Expand a persisted record back into the `GhProject` shape the existing published rendering
 * consumes, synthesizing `openCount`/`closedCount` item stubs so `projectProgress` computes the
 * exact same open count + closed fraction the record was derived from. This is what lets the stale
 * overlay reuse the live `ProjectRow`/merge paths untouched.
 */
export function minimalToGhProject(r: MinimalGhProject): GhProjectShape {
  const nodes: GhItemShape[] = [
    ...Array.from({ length: r.openCount }, () => ({ content: { state: "OPEN" } })),
    ...Array.from({ length: r.closedCount }, () => ({ content: { state: "CLOSED" } })),
  ];
  return {
    id: r.id, number: r.number, title: r.title, shortDescription: r.shortDescription,
    url: r.url, closed: r.closed, updatedAt: r.updatedAt,
    items: { totalCount: r.itemsTotalCount, nodes },
    repositories: { nodes: r.repos.map((nameWithOwner) => ({ nameWithOwner })) },
  };
}

/**
 * Keep only the records that still correspond to a LOCAL project — the don't-resurrect rule (#2446).
 * Matching mirrors the #2445 overlay (`buildLocalPublished` / the `mark_published` reconcile): a
 * record covers a local entry when the entry's key equals the record's name-derived
 * `projectSlug(title)` (today's keys) or the legacy `sanitizeProjectKey(title)` (grandfathered
 * title-keyed hubs), or when the titles match case-insensitively.
 *
 * @param records the persisted records (the last-known board state).
 * @param locals  the projects that exist locally — on-disk hubs and/or store drafts (`key` + `title`).
 */
export function filterRecordsToLocal(
  records: MinimalGhProject[],
  locals: Array<{ key: string; title: string }>,
): MinimalGhProject[] {
  if (records.length === 0 || locals.length === 0) return [];
  const keys = new Set(locals.map((l) => l.key));
  const titles = new Set(locals.map((l) => l.title.toLowerCase()));
  return records.filter((r) =>
    keys.has(projectSlug(r.title)) || keys.has(sanitizeProjectKey(r.title)) || titles.has(r.title.toLowerCase()),
  );
}
