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
//      the async fetch (variable latency) landed. The PERSISTED last-known board state (#2446 — the
//      `githubState` store field, which also survives an app restart) seeds the merge on a revisit, so
//      it renders the last-known network immediately, then refreshes.
//   2. DEDUP GAP. Drafts were keyed by their stable id but published by a different derivation; when
//      the two keys differed the SAME project became TWO nodes. The merge resolves a published project
//      onto its matching draft via a slug(title)→draftKey map, so legacy-keyed drafts collapse too.
// #2409: the plan key IS the name-derived slug (`projectSlug(title)`) — the node-id alias is retired.
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { githubGraphql } from "@/shared/lib/github/github";
import { useGithubQuery } from "@/shared/lib/github/useGithubQuery";
import { toMinimalGhProjects, minimalToGhProject, filterRecordsToLocal } from "@/shared/lib/github/githubState";
import { fetchProjectsWithProbe } from "@/shared/lib/github/githubProbe";
import { PROJECTS_QUERY, type GhProject } from "@/features/planner/list/published/publishedModel";
import { projectSlug } from "@/shared/lib/core/projectPaths";
import { usePoll } from "@/shared/hooks/usePoll";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import type { GRole, GHealth, GActivity } from "./glanceGraph";
import type { ProjectLite } from "./glanceData";
import type { GlanceFault } from "./useGlanceFaults";

// #2541 — GitHub board status NO LONGER drives a Glance node's status. The old `ghStatus` (open ⇒
// planning, shipped ⇒ done) is gone; health + activity are derived from runtime signals only.

/** Store shapes the merge reads — mirrored structurally so the pure fn stays decoupled from the slices.
 *  A draft MAY declare curated axes (#2284/#2541) — a demo/tagged project keeps its authored colouring. */
type DraftMap = Record<string, { title: string; pitch: string; createdAt: number; role?: GRole; health?: GHealth; activity?: GActivity; reason?: string }>;
type FleetMap = Record<string, { streams: unknown[] } | undefined>;

/** Stable empty published set — a fresh `[]` each render would needlessly re-run the merge memo. */
const NO_PUBLISHED: GhProject[] = [];

/** A published hub from the LOCAL inventory (#2445): `key` is the hub FOLDER key — the same key the
 *  drill / `planFleet` / `fleetPaneStreams` resolve against — with the `.title` display name. */
export interface LocalPublishedLite { key: string; title: string }

/** The `list_local_projects` fields the seed reads (camelCase wire format, #789). */
interface LocalProjectWire { key: string; title: string; published: boolean }

// The last-fetched local published inventory (#2445) — module-level so it survives the Glance
// workspace unmount/remount the Rail does on every leave/return: a revisit renders the published
// nodes immediately, then refreshes. (The GitHub-side equivalent is the PERSISTED `githubState`
// store field, #2446.)
let localPublishedCache: LocalPublishedLite[] | null = null;

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
  localPublished: LocalPublishedLite[] = [],
): ProjectLite[] {
  const byKey = new Map<string, ProjectLite>();
  // slug(title) → draft key, so a published project collapses onto a legacy-keyed draft.
  const draftKeyByTitle = new Map<string, string>();
  // Drafts first; a published project on the same plan key overrides it below.
  for (const [id, d] of Object.entries(drafts)) {
    // A draft may DECLARE its Glance axes (#2284/#2541 — health + activity + reason); else derive: role
    // in buildGlanceData, activity from whether it has a planned fleet, health resting at idle (the
    // runtime overlays — liveness #2263, faults #2541 — light it up). A declared value wins so a
    // demo/tagged project keeps its curated colouring.
    byKey.set(id, {
      id, name: d.title, role: d.role,
      health: d.health ?? "idle",
      activity: d.activity ?? ((planFleet[id]?.streams.length ?? 0) > 0 ? "building" : "planning"),
      reason: d.reason,
    });
    draftKeyByTitle.set(projectSlug(d.title), id);
  }
  // Local published hubs (#2445) — the OFFLINE seed: a published project always has a node, keyed by
  // its hub folder key (what the drill resolves), even when the GitHub set is absent (logged out /
  // fetch not landed). A GitHub record below OVERLAYS it. GitHub board status NO LONGER sets the node
  // status (#2541) — a published hub is a working project, so its default activity is `building`; a
  // draft-declared axis still wins for curated colouring.
  for (const lp of localPublished) {
    const prior = byKey.get(lp.key);
    const d = drafts[lp.key];
    byKey.set(lp.key, { id: lp.key, name: lp.title, role: prior?.role, health: d?.health ?? "idle", activity: d?.activity ?? "building", reason: d?.reason });
    draftKeyByTitle.set(projectSlug(lp.title), lp.key);
  }
  for (const p of published) {
    // The plan key derives from the name (#2409): a matching draft's key (covers grandfathered
    // legacy-keyed drafts) else `projectSlug(title)` — the key `planFleet` + the drill resolve
    // against (NEVER the node id). Preserve any axis already set by a collapsed draft/local hub; the
    // GitHub record contributes only name (+ dedup), never status (#2541).
    const titleKey = projectSlug(p.title);
    const key = draftKeyByTitle.get(titleKey) ?? titleKey;
    const prior = byKey.get(key);
    byKey.set(key, { id: key, name: p.title, role: prior?.role, health: prior?.health ?? "idle", activity: prior?.activity ?? "building", reason: prior?.reason });
  }
  return [...byKey.values()];
}

/** One project's liveness as the `project_liveness` Tauri command reports it (#2263, camelCase). */
interface ProjectLiveness { projectKey: string; live: boolean }

/** How often to poll backend liveness (ms). Comfortably below the backend's 45s window so a project
 *  going silent surfaces (and its "app down" alert records) within ~one interval. */
const LIVENESS_POLL_MS = 10_000;

/**
 * Overlay backend liveness onto the merged node set (#2263/#2541): a project whose key is in `liveKeys`
 * is detected RUNNING → activity `"live"` and health `"healthy"` (a running app is active & fine — the
 * fault overlay below can still escalate it to warning/error). Every other project keeps its merged
 * axes, so liveness lapsing naturally RESETS on the next poll. Additive + pure.
 */
export function applyLiveness(projects: ProjectLite[], liveKeys: ReadonlySet<string>): ProjectLite[] {
  if (liveKeys.size === 0) return projects;
  return projects.map((p) => (liveKeys.has(p.id) ? { ...p, activity: "live", health: p.health === "idle" ? "healthy" : p.health } : p));
}

/**
 * Overlay the fault summary onto the node set (#2541) — the HEALTH axis. A project with an open fault
 * escalates to `warning` (warn) or `error` (error/fatal), carrying the worst fault's title as the
 * `reason` (shown bottom-right in place of the activity word) and its count. Applied LAST so a fault
 * beats a healthy/live resting state — a live app that's throwing errors still reads red. Pure.
 */
export function applyFaultHealth(projects: ProjectLite[], faults: Record<string, GlanceFault>): ProjectLite[] {
  return projects.map((p) => {
    const f = faults[p.id];
    if (!f) return p;
    const health: GHealth = f.level === "warn" ? "warning" : "error";
    return { ...p, health, reason: f.title, faults: f.count };
  });
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

/**
 * Keep only TRIAGED projects (#2541) — the drafted→triaged gate. A project appears on the Glance
 * network ONLY once its triage/fleet has been launched (its key is in `triaged`), so a mere draft or a
 * published-but-never-worked hub is filtered out. "Once the nodes are here, it's because they're
 * working." Pure + exported for direct testing.
 */
export function filterTriaged(projects: ProjectLite[], triaged: Record<string, number>): ProjectLite[] {
  return projects.filter((p) => triaged[p.id] !== undefined);
}

export function useGlanceProjects(enabled = true): ProjectLite[] {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const planFleet = useAppStore((s) => s.planFleet);
  const triagedProjects = useAppStore((s) => s.triagedProjects);
  const githubState = useAppStore((s) => s.githubState);
  const setGithubState = useAppStore((s) => s.setGithubState);
  const liveKeys = useProjectLiveness(enabled);

  // The local published inventory (#2445): the on-disk hubs carrying `.published`, so a published
  // project has a Glance node even with no GitHub connection. Seeded from the module cache on a
  // revisit (no flash), refreshed once per mount.
  const [localPublished, setLocalPublished] = useState<LocalPublishedLite[]>(() => localPublishedCache ?? []);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void safeInvoke<LocalProjectWire[]>("list_local_projects", undefined, []).then((list) => {
      if (cancelled) return;
      const pub = (Array.isArray(list) ? list : [])
        .filter((lp) => lp?.published)
        .map((lp) => ({ key: lp.key, title: lp.title }));
      localPublishedCache = pub;
      setLocalPublished(pub);
    });
    return () => { cancelled = true; };
  }, [enabled]);

  // githubGraphql (not a raw invoke) so the read goes through the backend TTL cache (#2447):
  // a Glance revisit within the window is served with no network call. Past the window, the
  // light updatedAt probe (#2448) diffs against the persisted records first — when no board
  // moved, the heavy `items(first:100)` re-POST is skipped and the records are re-served (the
  // persist effect below re-stamps fetchedAt).
  const published = useGithubQuery<GhProject[]>(
    () => fetchProjectsWithProbe({
      fetchHeavy: () =>
        githubGraphql<{ viewer?: { projectsV2?: { nodes: GhProject[] } } }>(PROJECTS_QUERY, null)
          .then((d) => d.viewer?.projectsV2?.nodes ?? []),
      records: useAppStore.getState().githubState?.records,
    }),
    [], enabled,
  );

  // Persist the freshest published set (#2446, superseding the module-level #2339 cache): a fresh fetch
  // overwrites the store's `githubState` records+fetchedAt (and mirrors into the bsc-project store), so
  // the last-known board state survives the Glance remount AND an app restart. Written in an effect (not
  // during render) so it stays a clean side effect; the merge below reads it synchronously as a fallback.
  useEffect(() => { if (published.data) setGithubState(toMinimalGhProjects(published.data)); }, [published.data, setGithubState]);

  // Precedence (#2446): live fetch > persisted records > local-inventory-only. The persisted fallback
  // renders the last-known set immediately (no drafts-only flash), then refreshes when the fetch lands —
  // FILTERED to projects that still exist locally (a draft or a published hub): a record whose hub was
  // deleted must not resurrect a node. That matches how the merge treats GitHub-only projects — they
  // render only while the LIVE fetch vouches for them.
  const effectivePublished = useMemo<GhProject[]>(() => {
    if (published.data) return published.data;
    if (!githubState?.records.length) return NO_PUBLISHED;
    const locals = [
      ...Object.entries(drafts).map(([key, d]) => ({ key, title: d.title })),
      ...localPublished,
    ];
    return filterRecordsToLocal(githubState.records, locals).map(minimalToGhProject);
  }, [published.data, githubState, drafts, localPublished]);

  return useMemo(
    // Merge first (drafts + local published + GitHub published), FILTER to triaged/working projects
    // (#2541 — a draft/plan never shows), then overlay live heartbeats as the `"live"` activity (#2263).
    () => applyLiveness(
      filterTriaged(mergeGlanceProjects(drafts, planFleet, effectivePublished, localPublished), triagedProjects),
      liveKeys,
    ),
    [drafts, planFleet, effectivePublished, localPublished, triagedProjects, liveKeys],
  );
}
