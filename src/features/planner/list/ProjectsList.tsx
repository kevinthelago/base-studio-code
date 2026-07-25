import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { githubGraphql } from "@/shared/lib/github/github";
import { Trash2 } from "lucide-react";
import { useAppStore } from "@/store";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { sanitizeProjectKey, projectSlug } from "@/shared/lib/core/projectPaths";
import { toMinimalGhProjects, minimalToGhProject, filterRecordsToLocal } from "@/shared/lib/github/githubState";
import { fetchProjectsWithProbe } from "@/shared/lib/github/githubProbe";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { buildDrafts, mergeDbDrafts, isOrphanScaffold, type DraftRow, type LocalProjectLite } from "./drafts";
import { listDbProjects, removeDbProject, type DbProject } from "./projectsDbBridge";
import { buildLocalPublished, type LocalPublishedRow } from "./localPublished";
import { PublishedProjects, ProjectRow, projStatus, type GhProject, type ProjStatus, PROJECTS_QUERY } from "./PublishedProjects";
import { BlueprintLibrary, buildBlueprintItems, type BpItem } from "./BlueprintLibrary";

// `ProjectRow` stays exported from this module for existing importers/tests (it now lives in
// PublishedProjects.tsx).
export { ProjectRow };

/**
 * The Projects page = the composer over two focused sections (#1641): the published-projects column
 * (`PublishedProjects`) and the blueprint library rail (`BlueprintLibrary`). This component owns the
 * cross-cutting state both share — the GitHub + on-disk project scan, the derived/filtered lists, the
 * shared search/sort + ⋯-menu state, and the shared draft-delete flow — and distributes it; each
 * section owns its own local UI (the new-project / delete-everything forms, the blueprint author /
 * import surfaces).
 */
export function ProjectsList() {
  const {
    githubToken, activeWorkspace, setProjectsView, hiddenProjectIds, deleteLocalProject,
    localDraftProjects, removeDraftProject,
    blueprints, setPlanningContext, setPlanningTitle, setPlanningSession,
    setActiveProjectMeta, githubState, setGithubState,
  } = useAppStore();
  const [projects, setProjects]   = useState<GhProject[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSync, setLastSync]   = useState<Date | null>(null);
  const [query, setQuery]         = useState("");
  const [sort, setSort]           = useState<"recency" | "name">("recency");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // Draft-delete now requires a confirmation (#1216) — an accidental ✕ click must not destroy the
  // draft + its folder. Holds the draft pending confirmation. Shared by the Drafts chips and the
  // Blueprints rail (an authoring draft is a folder on disk too).
  const [draftDeleteTarget, setDraftDeleteTarget] = useState<DraftRow | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Orphaned-scaffold cleanup (#2998): a confirm-gated bulk delete of bare on-disk hubs (no
  // plan/title/publish) — invisible in the lists yet cluttering `projects/`. Holds the modal's open flag.
  const [showOrphanCleanup, setShowOrphanCleanup] = useState(false);
  // On-disk local projects (#…) — the durable source of truth for unpublished work, since the
  // store's draft map drifts out of sync with the `projects/` dir.
  const [localProjects, setLocalProjects] = useState<LocalProjectLite[]>([]);
  // Durable draft rows from the projects DB (#2995): reached through the generic `bsc` bridge, unioned
  // into the drafts list so a draft survives a restart even when the `localDraftProjects` cache misses.
  // Additive over the two existing sources; degrades to [] when the bridge is unreachable.
  const [dbProjects, setDbProjects] = useState<DbProject[]>([]);
  // Live fleet (for the per-project "agents running" pill).
  const { workers } = useFleetLive();

  // Routed through `githubGraphql` so the read hits the backend TTL cache (#2447): re-opening the
  // tab within the window serves the cached board list with no network call. Past the window, the
  // light updatedAt probe (#2448) diffs against the persisted records — when no board moved, the
  // heavy `items(first:100)` re-POST is skipped and the records are re-served (setGithubState below
  // re-stamps fetchedAt). The manual "↻ sync" button passes `force: true` so an explicit refresh
  // skips the probe and always re-POSTs.
  const fetchProjects = useCallback((opts?: { force?: boolean }) => {
    if (!githubToken) return;
    setLoading(true);
    setError(null);
    fetchProjectsWithProbe({
      fetchHeavy: () =>
        githubGraphql<{ viewer: { projectsV2: { nodes: GhProject[] } } }>(PROJECTS_QUERY, null, { force: opts?.force })
          .then(data => data.viewer?.projectsV2?.nodes ?? []),
      records: useAppStore.getState().githubState?.records,
      force: opts?.force,
    })
      .then(nodes => {
        setProjects(nodes);
        setLastSync(new Date());
        // Persist the last-known board state (#2446): a fresh fetch overwrites records + fetchedAt
        // (and mirrors the durable copy into the bsc-project store).
        setGithubState(toMinimalGhProjects(nodes));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, setGithubState]);

  // Re-fetch whenever the Projects tab becomes active (the screen stays mounted
  // across navigation, so a plain mount effect wouldn't refresh on re-open) as
  // well as on token change, so newly created/renamed projects appear.
  useEffect(() => {
    if (activeWorkspace === "projects") fetchProjects();
  }, [activeWorkspace, fetchProjects]);

  // Enumerate on-disk local projects whenever the tab opens, so unpublished local work always
  // shows even when it isn't in the store's draft map or on GitHub (#…).
  const refreshLocalProjects = useCallback(() => {
    return invoke<LocalProjectLite[]>("list_local_projects")
      // Coerce to an array: a null/garbage return would make `for (const lp of localProjects)`
      // non-iterable and throw during render (#874).
      .then((list) => { const arr = Array.isArray(list) ? list : []; setLocalProjects(arr); return arr; })
      .catch(() => { setLocalProjects([]); return []; });
  }, []);
  useEffect(() => {
    if (activeWorkspace !== "projects") return;
    void refreshLocalProjects();
  }, [activeWorkspace, refreshLocalProjects]);

  // Load the durable DB draft rows whenever the tab opens (#2995). A null return (bridge unreachable /
  // old `bsc`) degrades to [] so the two existing sources render exactly as before.
  useEffect(() => {
    if (activeWorkspace !== "projects") return;
    let cancelled = false;
    void listDbProjects().then((rows) => { if (!cancelled) setDbProjects(rows ?? []); });
    return () => { cancelled = true; };
  }, [activeWorkspace]);

  // Reconcile published markers (#922): a local hub that matches a GitHub board — by title, or by
  // the board's name-derived key (`projectSlug(title)`, #2409) — but isn't yet flagged published
  // gets its in-place `.published` marker stamped. This is what promotes a hub that couldn't be
  // flagged at publish time — e.g. a project published under the old #904 location split, or one
  // whose publish-time write lost a race — and it catches the hub the startup migration moved out
  // of draft/ as soon as its board is known. Runs whenever the list or boards change (NOT
  // one-time): marking flips `lp.published`, so the set drains and it converges. The hub never
  // moves and the marker is written in place, so this can't fail on a cwd lock. Gated on a
  // completed GitHub sync (`lastSync`) so an unloaded board list can't look like "no boards".
  useEffect(() => {
    if (activeWorkspace !== "projects" || lastSync === null) return;
    const publishedTitles = new Set(projects.map(p => p.title.toLowerCase()));
    const publishedKeys   = new Set(projects.map(p => projectSlug(p.title)));
    const toMark = localProjects.filter(lp =>
      !lp.published &&
      (publishedTitles.has(lp.title.toLowerCase()) || publishedKeys.has(lp.key)),
    );
    // Title backfill (#2467): a hub matched to a board but with NO `.title` sidecar (its listed
    // title is derived — de-slugged key or placeholder) gets the board's real title persisted, so
    // the offline inventory shows true names after one connected session. `titled` guards a user's
    // own rename from ever being stomped by the board. Match by key (slug or legacy sanitize) —
    // title-matching is useless here, the local title is the wrong one being fixed.
    const boardByKey = new Map<string, string>();
    for (const p of projects) {
      boardByKey.set(projectSlug(p.title), p.title);
      boardByKey.set(sanitizeProjectKey(p.title), p.title);
    }
    const toTitle = localProjects
      .filter((lp) => !lp.titled && boardByKey.has(lp.key))
      .map((lp) => ({ key: lp.key, title: boardByKey.get(lp.key)! }));
    if (toMark.length === 0 && toTitle.length === 0) return;
    (async () => {
      for (const lp of toMark) {
        await safeInvoke("mark_published", { projectKey: lp.key }, undefined,
          (e) => console.warn(`mark_published ${lp.key} failed:`, e));
      }
      for (const t of toTitle) {
        await safeInvoke("set_project_title", { projectKey: t.key, title: t.title }, undefined,
          (e) => console.warn(`set_project_title ${t.key} failed:`, e));
      }
      await refreshLocalProjects();
    })();
  }, [activeWorkspace, lastSync, localProjects, projects, refreshLocalProjects]);

  // ── Persisted GitHub-state overlay (#2446): until a LIVE fetch lands this mount (`lastSync`),
  // the last-known records render as stale board rows — but only for projects that still exist on
  // disk (a deleted hub is NOT resurrected; consistent with #2445's merge, where a GitHub-only
  // project renders only while the live fetch vouches for it). Precedence: live fetch > persisted
  // records > local-inventory-only rows.
  const staleProjects = useMemo<GhProject[]>(() => {
    if (lastSync !== null || !githubState?.records.length) return [];
    return filterRecordsToLocal(githubState.records, localProjects).map(minimalToGhProject);
  }, [lastSync, githubState, localProjects]);
  const effectiveProjects = lastSync !== null ? projects : staleProjects;
  // When the persisted overlay is what's rendering, surface its age ("last synced 2h ago").
  const staleFetchedAt = lastSync === null && staleProjects.length > 0 ? githubState!.fetchedAt : null;

  // The GitHub list is re-fetched on every sync, so a project removed in-app is
  // filtered out here (persisted) rather than only spliced from local state.
  const visibleProjects = effectiveProjects.filter(p => !hiddenProjectIds.includes(p.id));

  function reopenDraft(d: { key: string; title: string; pitch: string }) {
    setPlanningTitle(d.title);
    setPlanningContext(d.pitch, "");
    setActiveProjectMeta(null, "", "", 0);
    setPlanningSession(d.key);
    setProjectsView("planning");
  }

  // Delete a local/draft project: remove its on-disk folder FIRST (awaited, so a failure —
  // e.g. the folder is open in a console session — surfaces instead of silently leaving it to
  // reappear on the next scan), then clear the store entries AND prune it from `localProjects`
  // so the card disappears immediately (it isn't in the draft map, so removeDraftProject alone
  // never removed it).
  async function deleteDraft(key: string) {
    setDraftError(null);
    try {
      await invoke("delete_project_dir", { projectKey: key });
    } catch (e) {
      setDraftError(`Couldn't delete the folder for "${key}": ${e}. It may be open in a console session — close it and retry.`);
      return;
    }
    // The folder is gone; clear the store + on-disk list. Guard the store mutations too —
    // a throw here would otherwise become an unhandled rejection (and the card would linger)
    // rather than a surfaced error (#874).
    try {
      removeDraftProject(key);
      // Mirror the store removal into the durable DB (#2995), and prune the local DB-row cache so the
      // card drops immediately (the async remove hasn't re-read yet). Fire-and-forget; degrades silently.
      void removeDbProject(key);
      setDbProjects(prev => (Array.isArray(prev) ? prev : []).filter(r => r.key !== key));
      deleteLocalProject([key]);
      setLocalProjects(prev => (Array.isArray(prev) ? prev : []).filter(lp => lp.key !== key));
    } catch (e) {
      setDraftError(`Removed the folder for "${key}" but couldn't update the project list: ${e}.`);
    }
  }

  // Confirmed draft delete (#1216): run the destructive delete, then dismiss the confirmation modal.
  // On a folder-locked failure deleteDraft surfaces the inline draftError and leaves the card; close
  // the modal regardless so the error (rendered in the list) is visible.
  async function confirmDeleteDraft() {
    if (!draftDeleteTarget) return;
    const key = draftDeleteTarget.key;
    setDraftDeleteTarget(null);
    await deleteDraft(key);
  }

  // Confirmed orphan cleanup (#2998): delete every orphaned scaffold folder — reusing deleteDraft,
  // which already surfaces errors + prunes the store/local/DB caches — then re-scan and close the modal.
  async function cleanupOrphans() {
    for (const o of orphans) { await deleteDraft(o.key); }
    await refreshLocalProjects();
    setShowOrphanCleanup(false);
  }

  // Memoized: only the distinct-repo count feeds the summary line, so don't rebuild the Set every render.
  const repos = useMemo(() => new Set(visibleProjects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? [])), [visibleProjects]);

  // Per-project live fleet counts: a worker belongs to a project when its repo is
  // one of the project's repos (running vs parked = asking/waiting/blocked).
  const fleetByProject = useMemo(() => {
    const m: Record<string, { running: number; paused: number }> = {};
    for (const p of visibleProjects) {
      const projRepos = new Set((p.repositories?.nodes ?? []).map(r => r.nameWithOwner));
      let running = 0, paused = 0;
      for (const w of workers) {
        if (!projRepos.has(w.repo)) continue;
        if (w.status === "running") running++;
        else if (w.status !== "idle") paused++;
      }
      m[p.id] = { running, paused };
    }
    return m;
  }, [visibleProjects, workers]);

  // ── Local drafts (durable on-disk truth ∪ store draft map), dropping anything already published.
  // Dedup keys off the authoritative `.published` marker (#922 / #1449), so a hub whose folder key
  // differs in case from its GitHub board title can't leak into BOTH lists. Both key forms of each
  // board title are passed (#2409): the name-derived slug (today's keys) and the legacy
  // case-preserving sanitize (grandfathered title-keyed hubs). See `buildDrafts`.
  // …then union in the durable DB draft rows (#2995) so a draft the local cache lost still surfaces.
  const allDrafts = useMemo<DraftRow[]>(
    () => mergeDbDrafts(
      buildDrafts(
        localProjects,
        localDraftProjects,
        visibleProjects.flatMap(p => [projectSlug(p.title), sanitizeProjectKey(p.title)]),
      ),
      dbProjects,
    ),
    [localProjects, localDraftProjects, visibleProjects, dbProjects],
  );

  // Orphaned scaffolds (#2998): bare on-disk hubs with no plan, no user title, and not published —
  // filtered out of the Drafts list (`buildDrafts` skips untitled/planless hubs) so they're invisible,
  // yet they clutter `projects/`. The last clause is belt-and-suspenders: never surface here anything
  // already shown as a draft elsewhere. A plain derived const — React Compiler memoizes it (a manual
  // useMemo here trips its preserve-manual-memoization check).
  const orphans = localProjects.filter(lp => isOrphanScaffold(lp) && !allDrafts.some(d => d.key === lp.key));

  // ── Blueprints surfaced here: ALL blueprints — the built-in app templates AND the user's saved library.
  const blueprintItems = useMemo<BpItem[]>(() => buildBlueprintItems(blueprints), [blueprints]);

  // ── Search + sort over every list (#… redesign). ───────────────────────────────────────────────
  const q = query.trim().toLowerCase();
  const matchP = (p: GhProject) => !q || (p.title + " " + (p.shortDescription ?? "")).toLowerCase().includes(q);
  const matchD = (d: DraftRow) => !q || (d.title + " " + d.pitch).toLowerCase().includes(q);
  const matchB = (b: BpItem) => !q || (b.name + " " + b.pitch).toLowerCase().includes(q);

  // Group the published projects by lifecycle, filtered + sorted (#499 + redesign).
  const grouped = useMemo(() => {
    const cmpP = (a: GhProject, b: GhProject) =>
      sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase())
                      : new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    const by: Record<ProjStatus, GhProject[]> = { active: [], shipped: [] };
    for (const p of visibleProjects) { if (matchP(p)) by[projStatus(p)].push(p); }
    (Object.keys(by) as ProjStatus[]).forEach(s => by[s].sort(cmpP));
    return by;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleProjects, sort, q]);

  const fDrafts = useMemo(() => {
    const arr = allDrafts.filter(matchD);
    arr.sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : b.sort - a.sort);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allDrafts, sort, q]);

  // ── Local published inventory (#2445): published hubs not (yet) covered by a fetched GitHub
  // board — the whole published set while logged out, and the not-yet-overlaid remainder once the
  // query returns. Rendered in the published column so a restored fleet's project is always reachable.
  const localPublished = useMemo<LocalPublishedRow[]>(() => {
    const needle = query.trim().toLowerCase();
    return buildLocalPublished(localProjects, visibleProjects)
      .filter(r => !needle || (r.title + " " + r.key).toLowerCase().includes(needle))
      .sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : b.updatedAt - a.updatedAt);
  }, [localProjects, visibleProjects, sort, query]);

  const fBlueprints = useMemo(() => {
    const arr = blueprintItems.filter(matchB);
    arr.sort((a, b) => sort === "name" ? a.name.toLowerCase().localeCompare(b.name.toLowerCase()) : b.sort - a.sort);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blueprintItems, sort, q]);

  const publishedCount = grouped.active.length + grouped.shipped.length;
  const grandTotal = publishedCount + fDrafts.length + fBlueprints.length;

  // key → durable lifecycle state from projects.db (#2998) — lets the draft chips distinguish a bare
  // DRAFTED idea from a CREATED/in-progress project (whose hub + plan already exist).
  const dbStateByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of dbProjects) m[p.key] = p.state;
    return m;
  }, [dbProjects]);

  const totalSummary = `${visibleProjects.length} published · ${allDrafts.length} draft${allDrafts.length !== 1 ? "s" : ""} · ${blueprintItems.length} blueprint${blueprintItems.length !== 1 ? "s" : ""} · ${repos.size} repo${repos.size !== 1 ? "s" : ""}`;

  return (
    <Box as="section" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <PublishedProjects
        visibleProjects={visibleProjects}
        grouped={grouped}
        fDrafts={fDrafts}
        dbStateByKey={dbStateByKey}
        fleetByProject={fleetByProject}
        loading={loading}
        error={error}
        lastSync={lastSync}
        draftError={draftError}
        query={query}
        setQuery={setQuery}
        sort={sort}
        setSort={setSort}
        totalSummary={totalSummary}
        grandTotal={grandTotal}
        publishedCount={publishedCount}
        fetchProjects={fetchProjects}
        setProjects={setProjects}
        menuOpenId={menuOpenId}
        setMenuOpenId={setMenuOpenId}
        reopenDraft={reopenDraft}
        setDraftDeleteTarget={setDraftDeleteTarget}
        localProjects={localProjects}
        refreshLocalProjects={refreshLocalProjects}
        localPublished={localPublished}
        staleFetchedAt={staleFetchedAt}
        orphans={orphans}
        onCleanupOrphans={() => setShowOrphanCleanup(true)}
      />

      <BlueprintLibrary
        fBlueprints={fBlueprints}
        query={query}
        menuOpenId={menuOpenId}
        setMenuOpenId={setMenuOpenId}
      />

      {/* Draft delete confirmation (#1216) — drafts destroy an on-disk folder, so an accidental ✕
          must not delete instantly. Shared by the Drafts chips and the Blueprints rail. */}
      {draftDeleteTarget && (
        <ModalScrim onDismiss={() => setDraftDeleteTarget(null)}>
          <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 420, maxWidth: "90vw",
          }}>
            <h3 className="mono" style={{ margin: "0 0 8px", fontSize: 14, color: "var(--fg)" }}>
              Delete draft?
            </h3>
            <Text as="p" size={12} tone="muted" style={{ margin: "0 0 20px", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg)" }}>{draftDeleteTarget.title}</b> and its local planning folder
              will be permanently deleted. This draft was never published to GitHub, so there's nothing on
              GitHub to remove.
            </Text>
            <Row gap={8} align="stretch" justify="end">
              <Button variant="ghost" onClick={() => setDraftDeleteTarget(null)}>cancel</Button>
              <Button
                danger
                onClick={confirmDeleteDraft}
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Trash2 size={12} /> delete draft
              </Button>
            </Row>
          </Box>
        </ModalScrim>
      )}

      {/* Orphaned-scaffold cleanup confirmation (#2998) — a confirm-gated bulk delete of bare on-disk
          hubs. Lists exactly which folders will be removed, mirroring the draft-delete modal pattern. */}
      {showOrphanCleanup && (
        <ModalScrim onDismiss={() => setShowOrphanCleanup(false)}>
          <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 460, maxWidth: "90vw" }}>
            <h3 className="mono" style={{ margin: "0 0 8px", fontSize: 14, color: "var(--fg)" }}>
              Clean up orphaned scaffolds?
            </h3>
            <Text as="p" size={12} tone="muted" style={{ margin: "0 0 16px", lineHeight: 1.6 }}>
              These bare hubs have no plan, no title, and were never published. Their local folders will be
              permanently deleted — there's nothing on GitHub to remove.
            </Text>
            <Text as="div" mono size={11} tone="muted" style={{ marginBottom: 20, lineHeight: 1.7 }}>
              {orphans.map(o => <Box key={o.key}>· {o.key}</Box>)}
            </Text>
            <Row gap={8} align="stretch" justify="end">
              <Button variant="ghost" onClick={() => setShowOrphanCleanup(false)}>cancel</Button>
              <Button danger onClick={cleanupOrphans} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Trash2 size={12} /> delete {orphans.length} scaffold{orphans.length !== 1 ? "s" : ""}
              </Button>
            </Row>
          </Box>
        </ModalScrim>
      )}
    </Box>
  );
}
