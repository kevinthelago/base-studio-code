import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { githubGraphql } from "@/shared/lib/github/github";
import { Trash2 } from "lucide-react";
import { useAppStore } from "@/store";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { sanitizeProjectKey, projectSlug } from "@/shared/lib/core/projectPaths";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { AUTHORING_BLUEPRINT_ID, type Blueprint } from "../stages/blueprints";
import { buildDrafts, type DraftRow } from "./drafts";
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
    localDraftProjects, removeDraftProject, projectBlueprintId,
    planAuthoredBlueprint, blueprints, setPlanningContext, setPlanningTitle, setPlanningSession,
    setActiveProjectMeta,
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
  // On-disk local projects (#…) — the durable source of truth for unpublished work, since the
  // store's draft map drifts out of sync with the `projects/` dir.
  const [localProjects, setLocalProjects] = useState<{ key: string; title: string; hasPlan: boolean; updatedAt: number; published: boolean }[]>([]);
  // Live fleet (for the per-project "agents running" pill).
  const { workers } = useFleetLive();

  // Routed through `githubGraphql` so the read hits the backend TTL cache (#2447): re-opening the
  // tab within the window serves the cached board list with no network call. The manual "↻ sync"
  // button passes `force: true` so an explicit refresh always re-POSTs.
  const fetchProjects = useCallback((opts?: { force?: boolean }) => {
    if (!githubToken) return;
    setLoading(true);
    setError(null);
    githubGraphql<{ viewer: { projectsV2: { nodes: GhProject[] } } }>(PROJECTS_QUERY, null, { force: opts?.force })
      .then(data => {
        setProjects(data.viewer?.projectsV2?.nodes ?? []);
        setLastSync(new Date());
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken]);

  // Re-fetch whenever the Projects tab becomes active (the screen stays mounted
  // across navigation, so a plain mount effect wouldn't refresh on re-open) as
  // well as on token change, so newly created/renamed projects appear.
  useEffect(() => {
    if (activeWorkspace === "projects") fetchProjects();
  }, [activeWorkspace, fetchProjects]);

  // Enumerate on-disk local projects whenever the tab opens, so unpublished local work always
  // shows even when it isn't in the store's draft map or on GitHub (#…).
  const refreshLocalProjects = useCallback(() => {
    return invoke<{ key: string; title: string; hasPlan: boolean; updatedAt: number; published: boolean }[]>("list_local_projects")
      // Coerce to an array: a null/garbage return would make `for (const lp of localProjects)`
      // non-iterable and throw during render (#874).
      .then((list) => { const arr = Array.isArray(list) ? list : []; setLocalProjects(arr); return arr; })
      .catch(() => { setLocalProjects([]); return []; });
  }, []);
  useEffect(() => {
    if (activeWorkspace !== "projects") return;
    void refreshLocalProjects();
  }, [activeWorkspace, refreshLocalProjects]);

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
    if (toMark.length === 0) return;
    (async () => {
      for (const lp of toMark) {
        await safeInvoke("mark_published", { projectKey: lp.key }, undefined,
          (e) => console.warn(`mark_published ${lp.key} failed:`, e));
      }
      await refreshLocalProjects();
    })();
  }, [activeWorkspace, lastSync, localProjects, projects, refreshLocalProjects]);

  // The GitHub list is re-fetched on every sync, so a project removed in-app is
  // filtered out here (persisted) rather than only spliced from local state.
  const visibleProjects = projects.filter(p => !hiddenProjectIds.includes(p.id));

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
  const allDrafts = useMemo<DraftRow[]>(
    () => buildDrafts(
      localProjects,
      localDraftProjects,
      visibleProjects.flatMap(p => [projectSlug(p.title), sanitizeProjectKey(p.title)]),
    ),
    [localProjects, localDraftProjects, visibleProjects],
  );

  // A draft bound to the blueprint-author lifecycle is an in-progress BLUEPRINT — it belongs in the
  // Blueprints section, not the normal Drafts list (#923 / Projects-tab redesign).
  const isAuthoringKey = useCallback((key: string) => projectBlueprintId[key] === AUTHORING_BLUEPRINT_ID, [projectBlueprintId]);
  const normalDrafts = useMemo(() => allDrafts.filter(d => !isAuthoringKey(d.key)), [allDrafts, isAuthoringKey]);
  const authoringDrafts = useMemo(() => allDrafts.filter(d => isAuthoringKey(d.key)), [allDrafts, isAuthoringKey]);

  // ── Blueprints surfaced here: ALL blueprints — the built-in app templates AND the user's saved
  // library — plus any in-progress authoring drafts not yet saved.
  const blueprintItems = useMemo<BpItem[]>(
    () => buildBlueprintItems(blueprints, authoringDrafts, planAuthoredBlueprint as Record<string, Blueprint>),
    [blueprints, authoringDrafts, planAuthoredBlueprint],
  );

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
    const arr = normalDrafts.filter(matchD);
    arr.sort((a, b) => sort === "name" ? a.title.toLowerCase().localeCompare(b.title.toLowerCase()) : b.sort - a.sort);
    return arr;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalDrafts, sort, q]);

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

  const totalSummary = `${visibleProjects.length} published · ${normalDrafts.length} draft${normalDrafts.length !== 1 ? "s" : ""} · ${blueprintItems.length} blueprint${blueprintItems.length !== 1 ? "s" : ""} · ${repos.size} repo${repos.size !== 1 ? "s" : ""}`;

  return (
    <Box as="section" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", overflow: "hidden" }}>
      <PublishedProjects
        visibleProjects={visibleProjects}
        grouped={grouped}
        fDrafts={fDrafts}
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
      />

      <BlueprintLibrary
        fBlueprints={fBlueprints}
        query={query}
        menuOpenId={menuOpenId}
        setMenuOpenId={setMenuOpenId}
        reopenDraft={reopenDraft}
        setDraftDeleteTarget={setDraftDeleteTarget}
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
    </Box>
  );
}
