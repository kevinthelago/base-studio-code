// useGlanceProjects (#2206) — the REAL project set for the Glance network: the user's PUBLISHED GitHub
// projects (projectsV2, the same query the Planner list runs) MERGED with local DRAFTS. Everything is
// keyed by the PLAN key (the name-derived slug, #2409 — NOT the GitHub node id) so each project appears
// once and drilling into it resolves its fleet from `planFleet` (which is plan-key-keyed). Published
// projects win on a key collision (they carry the real open/shipped status). Falls back to just drafts
// when there's no token / before the fetch lands, so the page is never blocked on the network.
//
// #2339 — the network showed a DIFFERENT set on every visit. Two causes, both fixed here:
//   1. RACE. `useGithubQuery` re-inits to `{ data: null }` on every mount and the Rail unmounts/remounts
//      Glance on leave/return, so each visit rendered drafts-only → then flipped to drafts+published once
//      the async fetch (variable latency) landed. A tiny module-level cache of the last non-null published
//      set seeds the merge on a revisit, so it renders the last-known network immediately, then refreshes.
//   2. DEDUP GAP. Drafts were keyed by their stable id but published by a different derivation; when
//      the two keys differed the SAME project became TWO nodes. The merge resolves a published project
//      onto its matching draft via a slug(title)→draftKey map, so legacy-keyed drafts collapse too.
// #2409: the plan key IS the name-derived slug (`projectSlug(title)`) — the node-id alias is retired.
import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { useGithubQuery } from "@/shared/lib/github/useGithubQuery";
import { PROJECTS_QUERY, projStatus, type GhProject } from "@/features/planner/list/published/publishedModel";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import { usePoll } from "@/shared/hooks/usePoll";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import type { GRole, GStatus } from "./glanceGraph";
import type { ProjectLite } from "./glanceData";

/** A published project's status → a Glance node status: shipped ⇒ done, open ⇒ planning. */
const ghStatus = (p: GhProject): GStatus => (projStatus(p) === "shipped" ? "done" : "planning");

/** Store shapes the merge reads — mirrored structurally so the pure fn stays decoupled from the slices. */
type DraftMap = Record<string, { title: string; pitch: string; createdAt: number; role?: GRole; status?: GStatus }>;
type FleetMap = Record<string, { streams: unknown[] } | undefined>;

/** Stable empty published set — a fresh `[]` each render would needlessly re-run the merge memo. */
const NO_PUBLISHED: GhProject[] = [];

// The last non-null published set (#2339) — see the file header (cause 1). Module-level so it survives the
// Glance workspace unmount/remount the Rail does on every leave/return; a revisit seeds its merge from this
// instead of resetting to drafts-only and flashing.
let publishedCache: GhProject[] | null = null;

/**
 * Merge local drafts with published GitHub projects into the Glance node set, keyed by the PLAN key so each
 * project is exactly ONE node. Pure + exported for direct unit testing (#2339).
 *
 * Dedup (#2409): a published project's plan key IS `projectSlug(title)` — with one bridge for
 * grandfathered drafts: a draft whose legacy key differs from its title-slug is found via a
 * slug(title)→draftKey map, so the published board collapses onto it rather than spawning a second node.
 */
export function mergeGlanceProjects(
  drafts: DraftMap,
  planFleet: FleetMap,
  published: GhProject[],
): ProjectLite[] {
  const byKey = new Map<string, ProjectLite>();
  // slug(title) → draft key, so a published project collapses onto a legacy-keyed draft.
  const draftKeyByTitle = new Map<string, string>();
  // Drafts first; a published project on the same plan key overrides it below.
  for (const [id, d] of Object.entries(drafts)) {
    // A draft may DECLARE its Glance role/status (#2284); else derive (role in buildGlanceData; status
    // from whether it has a planned fleet). A declared value wins so a demo/tagged project keeps its
    // curated coloring.
    byKey.set(id, {
      id, name: d.title, role: d.role,
      status: d.status ?? ((planFleet[id]?.streams.length ?? 0) > 0 ? "planning" : "idle"),
    });
    draftKeyByTitle.set(projectSlug(d.title), id);
  }
  for (const p of published) {
    // The plan key derives from the name (#2409): a matching draft's key (covers grandfathered
    // legacy-keyed drafts) else `projectSlug(title)` — the key `planFleet` + the drill resolve
    // against (NEVER the node id).
    const titleKey = projectSlug(p.title);
    const key = draftKeyByTitle.get(titleKey) ?? titleKey;
    // Published carries the real open/shipped status; keep any draft-declared role so curated coloring
    // survives the collapse-onto-draft (published projects don't carry a role).
    byKey.set(key, { id: key, name: p.title, role: byKey.get(key)?.role, status: ghStatus(p) });
  }
  return [...byKey.values()];
}

/** One project's liveness as the `project_liveness` Tauri command reports it (#2263, camelCase). */
interface ProjectLiveness { projectKey: string; live: boolean }

/** How often to poll backend liveness (ms). Comfortably below the backend's 45s window so a project
 *  going silent surfaces (and its "app down" alert records) within ~one interval. */
const LIVENESS_POLL_MS = 10_000;

/**
 * Overlay backend liveness onto the merged node set (#2263): a project whose key is in `liveKeys`
 * resolves to the `"live"` (pulsing) status; every other project keeps its merged status (so liveness
 * lapsing naturally RESETS to the prior status on the next poll). Additive + pure — the merge itself is
 * untouched, so a parallel fault-health change (#2265) to `mergeGlanceProjects` merges cleanly.
 */
export function applyLiveness(projects: ProjectLite[], liveKeys: ReadonlySet<string>): ProjectLite[] {
  if (liveKeys.size === 0) return projects;
  return projects.map((p) => (liveKeys.has(p.id) ? { ...p, status: "live" as GStatus } : p));
}

/** Poll the backend for the set of currently-live project keys (#2263). Polling also DRIVES backend
 *  down-detection: the sweep records an "app down" fault for any project that has just gone silent. */
export function useProjectLiveness(enabled = true): ReadonlySet<string> {
  const [liveKeys, setLiveKeys] = useState<ReadonlySet<string>>(() => new Set());
  usePoll(
    async (isCancelled) => {
      if (!enabled) return;
      const rows = await safeInvoke<ProjectLiveness[]>("project_liveness", undefined, []);
      if (isCancelled()) return;
      // Tolerate a null/non-array return (no collector, a stubbed invoke) — no live keys, no throw.
      const list = Array.isArray(rows) ? rows : [];
      const next = new Set(list.filter((r) => r.live).map((r) => r.projectKey));
      // Only replace the set when membership actually changed, so a steady state doesn't churn renders.
      setLiveKeys((prev) => (sameKeys(prev, next) ? prev : next));
    },
    LIVENESS_POLL_MS,
    [enabled],
  );
  return liveKeys;
}

/** Two key sets are equal iff same size and every member shared. */
function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

export function useGlanceProjects(enabled = true): ProjectLite[] {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const planFleet = useAppStore((s) => s.planFleet);
  const liveKeys = useProjectLiveness(enabled);

  const published = useGithubQuery<GhProject[]>(
    (token) => invoke<{ viewer?: { projectsV2?: { nodes: GhProject[] } } }>("github_graphql", { token, query: PROJECTS_QUERY, variables: null })
      .then((d) => d.viewer?.projectsV2?.nodes ?? []),
    [], enabled,
  );

  // Persist the freshest published set across the Glance remount (#2339). Written in an effect (not during
  // render) so it stays a clean side effect; the merge below reads the cache synchronously as a fallback.
  useEffect(() => { if (published.data) publishedCache = published.data; }, [published.data]);

  // Prefer the live fetch; on a revisit (data still null) fall back to the cached set so the network renders
  // immediately instead of flashing drafts-only, then refreshes once the fetch re-lands.
  const effectivePublished = published.data ?? publishedCache ?? NO_PUBLISHED;

  return useMemo(
    // Merge first (drafts + published), then overlay live heartbeats as the `"live"` status (#2263).
    () => applyLiveness(mergeGlanceProjects(drafts, planFleet, effectivePublished), liveKeys),
    [drafts, planFleet, effectivePublished, liveKeys],
  );
}
