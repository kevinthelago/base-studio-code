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
import type { GRole, GCategory, GHealth, GActivity } from "./glanceGraph";
import type { ProjectLite } from "./glanceData";
import type { GlanceFault } from "./useGlanceFaults";
import { projectKeyOfSession } from "./agentStall";
// #3966: the SAME durable-projects bridge the Projects page reads, so the two surfaces cannot
// disagree about which local projects exist. Type-only + the reader; the bridge already degrades to
// `null` when it is unreachable, which we treat as "keep the cache".
import { listDbProjects, type DbProject } from "@/features/planner";

// #2541 — GitHub board status NO LONGER drives a Glance node's status. The old `ghStatus` (open ⇒
// planning, shipped ⇒ done) is gone; health + activity are derived from runtime signals only.

/** Store shapes the merge reads — mirrored structurally so the pure fn stays decoupled from the slices.
 *  A draft MAY declare curated axes (#2284/#2541) — a demo/tagged project keeps its authored colouring. */
type DraftMap = Record<string, { title: string; pitch: string; createdAt: number; role?: GRole; category?: GCategory; health?: GHealth; activity?: GActivity; reason?: string }>;

/** Stable empty published set — a fresh `[]` each render would needlessly re-run the merge memo. */
const NO_PUBLISHED: GhProject[] = [];

/** Stable empty DB set — same memo-stability reason as {@link NO_PUBLISHED}. */
const NO_DB_PROJECTS: DbProject[] = [];

/**
 * Union the durable projects DB into the store's draft map (#3966).
 *
 * `localDraftProjects` is a persisted CACHE, written by `addDraftProject` at creation time — and it is
 * reset wholesale by `resetProjectData` and delete/rekey-scoped by `projectScopedMaps`. So a project
 * that predates the map, survives a reset, or is created by a path that never calls `addDraftProject`
 * is absent from it FOREVER, while `projects.db` still has the row and every other surface still shows
 * it. That is how a triaged, openable project had no Glance node at all.
 *
 * The CACHE wins on fields it has — it carries the curated axes the DB row has no column for — and the
 * DB fills what the cache is missing, including whole rows.
 *
 * STATE FILTER — deliberately WIDER than `mergeDbDrafts` (the Projects page's equivalent), and the
 * first cut of this function got that wrong. That helper feeds a DRAFTS-ONLY list, where `created` and
 * `published` projects are excluded because they render in other sections of the same page. Glance has
 * no other section: its node set is drafts ∪ local-published ∪ GitHub-published, so a `created` project
 * — one that has been scaffolded but never published — belongs to NO source and silently vanishes from
 * the graph. That is what happened to a triaged project whose state had advanced `drafted` → `created`.
 *
 * `published` stays out on purpose, for two reasons: `mergeGlanceProjects` already overrides a draft
 * with the published entry on a key collision (so admitting it buys nothing), and the drafts map IS the
 * `isDraft` signal for {@link resolveProjectCategory} — a published project in here would default to
 * `greenfield` instead of `maintain`.
 *
 * Pure + exported for direct unit testing, like {@link mergeGlanceProjects}.
 */
export function mergeDbIntoDrafts(drafts: DraftMap, dbRows: DbProject[]): DraftMap {
  const out: DraftMap = { ...drafts };
  for (const r of Array.isArray(dbRows) ? dbRows : []) {
    if (r.state === "published") continue;
    const ex = out[r.key];
    out[r.key] = ex
      // Keep every curated axis (role/category/health/activity/reason) — the DB row has none of them,
      // so a spread-with-DB-second would silently strip a demo project's authored colouring.
      ? { ...ex, title: ex.title || r.title, pitch: ex.pitch || r.pitch, createdAt: ex.createdAt || r.createdAt }
      : { title: r.title, pitch: r.pitch, createdAt: r.createdAt || r.updatedAt || 0 };
  }
  return out;
}

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

// The last-fetched durable projects DB rows (#3966) — module-level for the same reason as
// `localPublishedCache`: the Rail unmounts/remounts the Glance workspace on every leave/return, and a
// revisit should render the full node set immediately rather than flashing a cache-only graph first.
let dbProjectsCache: DbProject[] | null = null;

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
  published: GhProject[],
  localPublished: LocalPublishedLite[] = [],
): ProjectLite[] {
  const byKey = new Map<string, ProjectLite>();
  // slug(title) → draft key, so a published project collapses onto a legacy-keyed draft.
  const draftKeyByTitle = new Map<string, string>();
  // Drafts first; a published project on the same plan key overrides it below.
  for (const [id, d] of Object.entries(drafts)) {
    // A draft may DECLARE its Glance axes (#2284/#2541 — health + activity + reason); else both axes
    // REST at idle (#2551) and the runtime overlays light them up: liveness → live (#2263), running
    // agents → building (#2551), bsc-wait → waiting, faults → warning/error (#2541). A declared value
    // wins so a demo/tagged project keeps its curated colouring.
    byKey.set(id, {
      id, name: d.title, role: d.role, category: d.category,
      health: d.health ?? "idle",
      activity: d.activity ?? "idle",
      reason: d.reason,
    });
    draftKeyByTitle.set(projectSlug(d.title), id);
  }
  // Local published hubs (#2445) — the OFFLINE seed: a published project always has a node, keyed by
  // its hub folder key (what the drill resolves), even when the GitHub set is absent (logged out /
  // fetch not landed). A GitHub record below OVERLAYS it. GitHub board status NO LONGER sets the node
  // status (#2541) and a published hub RESTS at idle (#2551) until a runtime overlay lights it up; a
  // draft-declared axis still wins for curated colouring.
  // Collapse the LEGACY + name-slug hub FOLDERS of the SAME project into ONE node (#2409 grandfathering
  // leaves both on disk with the same title — e.g. `Beautiful_Emails` + `beautiful-emails`): group by the
  // canonical `projectSlug(title)`, preferring the folder whose key already IS that slug (what planFleet +
  // the drill resolve against), so a project isn't DUPLICATED on the network.
  const localByTitleKey = new Map<string, LocalPublishedLite>();
  for (const lp of localPublished) {
    const tk = projectSlug(lp.title);
    const cur = localByTitleKey.get(tk);
    if (!cur || (lp.key === tk && cur.key !== tk)) localByTitleKey.set(tk, lp);
  }
  for (const [tk, lp] of localByTitleKey) {
    // Collapse onto a matching draft (a legacy-keyed draft) if one exists; else key by the chosen folder.
    const key = draftKeyByTitle.get(tk) ?? lp.key;
    const prior = byKey.get(key);
    const d = drafts[key];
    byKey.set(key, { id: key, name: lp.title, role: prior?.role, category: prior?.category ?? d?.category, health: d?.health ?? "idle", activity: d?.activity ?? "idle", reason: d?.reason });
    draftKeyByTitle.set(tk, key);
  }
  for (const p of published) {
    // The plan key derives from the name (#2409): a matching draft's key (covers grandfathered
    // legacy-keyed drafts) else `projectSlug(title)` — the key `planFleet` + the drill resolve
    // against (NEVER the node id). Preserve any axis already set by a collapsed draft/local hub; the
    // GitHub record contributes only name (+ dedup), never status (#2541).
    const titleKey = projectSlug(p.title);
    const key = draftKeyByTitle.get(titleKey) ?? titleKey;
    const prior = byKey.get(key);
    byKey.set(key, { id: key, name: p.title, role: prior?.role, category: prior?.category, health: prior?.health ?? "idle", activity: prior?.activity ?? "idle", reason: prior?.reason });
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
 * Overlay RUNNING-AGENT activity onto the node set (#2551) — the `building` state. A project with a live
 * agent PTY reads activity `building` + health `healthy` (active & fine). This is what makes `building`
 * mean agents are ACTUALLY running — NOT a resting default — so a triaged project with nothing running
 * stays `idle`. Applied after liveness so active agent work (the more current signal) wins over a bare
 * `live` app. The fault overlay still escalates health to warning/error on top. Pure.
 */
export function applyRunningActivity(projects: ProjectLite[], buildingKeys: ReadonlySet<string>): ProjectLite[] {
  if (buildingKeys.size === 0) return projects;
  return projects.map((p) => (buildingKeys.has(p.id) ? { ...p, activity: "building", health: p.health === "idle" ? "healthy" : p.health } : p));
}

/** The set of project keys with a LIVE agent session (#2551): any launched pane that is still a live CELL
 *  of an open tab, or any pane with an authoritative `run`/`on` status (covers the director, a session not
 *  a stream). The project key is the pane id's prefix (before the first ':'). Pure.
 *
 *  `livePaneIds` — NOT `fleetPaneStreams` (#3429). The roster map is only cleared by `closeTab`; `killPane`
 *  leaves it populated, so a fleet ended via "End sessions" kept reading `building`/`healthy` here until the
 *  tab itself was closed. `livePaneIds` is the same pruned set the L1 overlay reads (tab membership minus
 *  `endedPanes`/`disabledPanes`), so both layers answer "does a session exist?" from one signal. */
export function deriveBuildingKeys(
  livePaneIds: ReadonlySet<string>,
  paneStatus: Record<string, string | undefined>,
): Set<string> {
  const keys = new Set<string>();
  for (const paneId of livePaneIds) keys.add(projectKeyOfSession(paneId));
  for (const [paneId, st] of Object.entries(paneStatus)) if (st === "run" || st === "on") keys.add(projectKeyOfSession(paneId));
  return keys;
}

/**
 * Overlay DORMANCY onto the node set (#3429) — the L0 half of the #3415 existence rule, and the first
 * question the stack asks rather than the last. A project with no live agent session AND no detected app
 * liveness has nothing running at all: it reads `off · idle`.
 *
 * Until this existed, L0 could only ESCALATE. Every overlay lifted a project off the merge default
 * (`health: "idle"`), and nothing ever established that there was nothing to lift — so "dormant" and
 * "has a session, currently quiet" both rendered `idle`, exactly the ambiguity #3415 removed at L1:
 *
 *   no session exists → `off` · a session exists but is quiet → `idle` · working → `healthy`
 *
 * (`off` at L0 previously meant ONLY the user's manual toggle, #3239. That still wins outright — it is
 * applied outermost — this just makes the derived resting state honest about the same word.)
 *
 * Applied BEFORE `applyFaultHealth`: a dormant project with an unresolved fault still reads warning/error,
 * because an unfixed error does not stop being real just because nobody is currently working on it.
 *
 * `curated` nodes survive dormancy for exactly the same reason (#2284/#2541 — "curated colouring wins";
 * fixed in #3513): a draft that DECLARES its own health/activity is making a statement, and greying it
 * out the moment nothing happens to be running discards that in favour of a resting state nobody asked
 * about. Curated-ness is passed IN rather than inferred from the value, because by this point in the
 * pipeline a non-default `health` is equally likely to be a declaration or something an earlier overlay
 * derived — the two are indistinguishable here, and only the merge knows which. Pure.
 */
export function applyDormantHealth(
  projects: ProjectLite[],
  activeKeys: ReadonlySet<string>,
  curatedKeys: ReadonlySet<string> = new Set(),
): ProjectLite[] {
  return projects.map((p) =>
    activeKeys.has(p.id) || curatedKeys.has(p.id) ? p : { ...p, health: "off", activity: "idle" },
  );
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

/**
 * Overlay the user's manual OFF toggle onto the node set (#3239) — the one caller-driven HEALTH value.
 * A project the user has deactivated (its id is truthy in `off`) reads health `off` and drops its fault
 * `reason`, so the node greys and reads "off" regardless of what it was doing. Applied OUTERMOST (after
 * liveness/running/stall/fault) so the deliberate mute WINS over every derived status — "if it's not idle
 * then it should be off". Sparse map (absent ⇒ on); pure. Keyed by the project id (== the node id).
 */
export function applyOffHealth(projects: ProjectLite[], off: Record<string, boolean>): ProjectLite[] {
  return projects.map((p) => (off[p.id] ? { ...p, health: "off", reason: undefined } : p));
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

/**
 * Resolve a project's LIFECYCLE category (#2583) — what KIND of work it is, the app's real project
 * vocabulary that REPLACES the meaningless hash-per-id microservices tier. Priority: a curated/declared
 * category (a demo/tagged project) wins, else the lifecycle the PLANNER DISCOVERED for the project
 * (`ClassifyConfig.lifecycle`), else a status heuristic — a draft is being CREATED (greenfield), a
 * published / already-worked project is in upkeep (maintain). Always yields a category so no L0 node
 * falls back to the old tier colouring. Pure.
 *
 * The middle term used to be the SEEDING BLUEPRINT's category, which #3785 removed from the blueprint
 * model — and which had degenerated to the same "greenfield" on every packaged blueprint, so it
 * coloured every node identically. Lifecycle is discovered per project now (#3784).
 */
export function resolveProjectCategory(
  declared: GCategory | undefined,
  discoveredLifecycle: GCategory | undefined,
  isDraft: boolean,
): GCategory {
  return declared ?? discoveredLifecycle ?? (isDraft ? "greenfield" : "maintain");
}

export function useGlanceProjects(enabled = true): ProjectLite[] {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const triagedProjects = useAppStore((s) => s.triagedProjects);
  // Running-agent signals (#2551): the launched roster + authoritative pane statuses → the `building`
  // activity. A project with a live agent pane reads `building`; nothing running → it rests at `idle`.
  // Launched-tab membership (#3429) — the same pruned "this session exists" signal the L1 overlay reads
  // (`GlanceWorkspace.livePaneIds`): a pane is live only while it is a CELL of an open tab and has not
  // been ended or disabled. Replaces `fleetPaneStreams`, which `killPane` never clears.
  const consoleTabs = useAppStore((s) => s.tabs);
  const endedPanes = useAppStore((s) => s.endedPanes);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const livePaneIds = useMemo(() => {
    const live = new Set<string>();
    for (const t of consoleTabs) for (const pid of t.paneIds ?? []) {
      if (pid && !endedPanes[pid] && !disabledPanes[pid]) live.add(pid);
    }
    return live;
  }, [consoleTabs, endedPanes, disabledPanes]);
  const paneStatus = useAppStore((s) => s.paneStatus);
  const githubState = useAppStore((s) => s.githubState);
  const setGithubState = useAppStore((s) => s.setGithubState);
  // Lifecycle category (#2583/#3785): the lifecycle the planner DISCOVERED for each project, so a
  // project node is coloured by what KIND of work it is (greenfield / transform / harden / maintain).
  // Read off the classification below — lifecycle is no longer a blueprint field.
  // The per-project classification (#3786/#3802): the planner-set `appType` (application architecture) —
  // surfaced on each Glance project node as the contract endpoint-type discriminator. Absent for an
  // unclassified project ⇒ the node renders plain (no type badge).
  const planClassification = useAppStore((s) => s.planClassification);
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

  // #3966: the durable project list, from the same bridge the Projects page uses. `listDbProjects`
  // returns null on ANY failure (bridge absent, old bundled `bsc` without the verb, bad payload) — we
  // keep the previous rows in that case, so a degraded environment falls back to the store cache
  // exactly as before rather than dropping nodes.
  const [dbProjects, setDbProjects] = useState<DbProject[]>(() => dbProjectsCache ?? NO_DB_PROJECTS);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void listDbProjects().then((rows) => {
      if (cancelled || !rows) return;
      dbProjectsCache = rows;
      setDbProjects(rows);
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

  const buildingKeys = useMemo(() => deriveBuildingKeys(livePaneIds, paneStatus), [livePaneIds, paneStatus]);
  // Everything that counts as "this project has something running" (#3429): a live agent session OR a
  // detected running app. Anything outside this set is dormant and reads `off` rather than resting at
  // `idle` — see `applyDormantHealth`.
  const activeKeys = useMemo(() => new Set([...buildingKeys, ...liveKeys]), [buildingKeys, liveKeys]);
  // The CURATED nodes (#2284/#2541) — drafts that declare their own Glance axes. Dormancy leaves these
  // alone (#3513): a declared health/activity is a statement, not a resting state to be overwritten.
  const curatedKeys = useMemo(
    () => new Set(Object.entries(drafts).filter(([, d]) => d.health || d.activity).map(([k]) => k)),
    [drafts],
  );
  // #3966: the draft set the graph is actually built from — the store cache UNIONED with the durable
  // projects DB. Computed once and used for BOTH the merge and the `isDraft` signal below, so a
  // DB-only project is a draft for colouring purposes exactly as a cached one is.
  const effectiveDrafts = useMemo(() => mergeDbIntoDrafts(drafts, dbProjects), [drafts, dbProjects]);
  return useMemo(
    // Merge (drafts + local published + GitHub published), FILTER to triaged/working projects (#2541 —
    // a draft/plan never shows), then overlay activity from real signals: liveness → `live` (#2263),
    // running agents → `building` (#2551); a project with nothing running at all reads `off` (#3429).
    // (Stall → `waiting`/warn and faults → error are overlaid later in the workspace.)
    () => applyDormantHealth(
      applyRunningActivity(
        applyLiveness(
          filterTriaged(
            mergeGlanceProjects(effectiveDrafts, effectivePublished, localPublished).map((p) => ({
              ...p,
              category: resolveProjectCategory(p.category, planClassification[p.id]?.lifecycle, effectiveDrafts[p.id] !== undefined),
              appType: planClassification[p.id]?.appType, // #3786/#3802 — the contract endpoint-type discriminator (absent ⇒ plain)
            })),
            triagedProjects,
          ),
          liveKeys,
        ),
        buildingKeys,
      ),
      activeKeys,
      curatedKeys,
    ),
    [effectiveDrafts, effectivePublished, localPublished, triagedProjects, liveKeys, buildingKeys, activeKeys, curatedKeys, planClassification],
  );
}
