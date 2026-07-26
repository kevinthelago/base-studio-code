import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { safeInvoke, fireInvoke } from "@/shared/lib/core/safeInvoke";
import { githubGraphql, rateLimitNote } from "@/shared/lib/github/github";
import { Trash2 } from "lucide-react";
import { useAppStore } from "@/store";
import { useFleetLive } from "@/shared/hooks/useFleetLive";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { sanitizeProjectKey, projectSlug } from "@/shared/lib/core/projectPaths";
import { timeAgoMs } from "@/shared/lib/core/format";
import { toMinimalGhProjects, minimalToGhProject, filterRecordsToLocal } from "@/shared/lib/github/githubState";
import { fetchProjectsWithProbe } from "@/shared/lib/github/githubProbe";
import { FEATURES_KEY } from "@/features/planner/stages/planTopics";
import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Dialog } from "@/shared/ui/overlay/Dialog";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Dropdown } from "@/shared/ui/controls/Dropdown";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { InlineError } from "@/shared/ui/feedback/InlineError";
import { buildDrafts, mergeDbDrafts, isOrphanScaffold, type DraftRow, type LocalProjectLite } from "./drafts";
import { listDbProjects, removeDbProject, addDbProject, type DbProject } from "./projectsDbBridge";
import { buildLocalPublished, type LocalPublishedRow } from "./localPublished";
import { PROJECTS_QUERY, type GhProject } from "./published/publishedModel";
import { useReopenProject } from "./ReopenProjectModal";
import { DeleteProjectModal } from "./published/DeleteProjectModal";
import { ProjectsRail } from "./ProjectsRail";
import { ProjectCard } from "./ProjectCard";
import { ProjectSetupPage } from "./ProjectSetupPage";
import {
  buildProjectItems, statusCounts, typeCounts, filterProjects, SORTS,
  type ProjectItem, type ProjectStatus, type SortKey, type Density, type AppType,
} from "./projectsFilter";
import "../projectsScreen.css";

// `ProjectRow` stays exported from this module for existing importers/tests (it lives in
// published/ProjectRow.tsx). GhProject type re-export mirrors the old PublishedProjects surface.
export { ProjectRow } from "./published/ProjectRow";
export type { GhProject } from "./published/publishedModel";

/**
 * The Projects page (#3802 redesign) — recast in the Skills library's shape: a LEFT drag-resizable
 * `ProjectsRail` (search + Status facets) and a RIGHT main column (a slim header — count · sort ·
 * density · sync · **+ New project** — over a card/list body). It folds the FOUR project sources
 * (GitHub boards, local-published hubs, in-progress drafts, bare drafts) into one unified grid via
 * `buildProjectItems`, so every reachable project still appears and stays openable. This component
 * owns the cross-cutting state — the GitHub + on-disk scan, the derived lists, search/sort/facets,
 * the create → pick-blueprint → bind flow, and the draft-delete / orphan-cleanup / board-delete /
 * reopen modals — that the old `PublishedProjects` + `BlueprintLibrary` two-column layout split.
 */
export function ProjectsList() {
  const {
    githubToken, activeWorkspace, setProjectsView, hiddenProjectIds, deleteLocalProject,
    localDraftProjects, removeDraftProject, blueprints,
    setPlanningContext, setPlanningTitle, setPlanningSession, setActiveProjectMeta,
    githubState, setGithubState, navigate, openGithubBoard,
    addDraftProject, setProjectBlueprintId, setPlanStage,
    planClassification, planDeployConfig,
  } = useAppStore();

  const [projects, setProjects]   = useState<GhProject[]>([]);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const [lastSync, setLastSync]   = useState<Date | null>(null);

  // ── view state (Skills-shaped): search + Status facet + sort + density.
  const [query, setQuery]         = useState("");
  const [sort, setSort]           = useState<SortKey>("recency");
  const [density, setDensity]     = useState<Density>("cards");
  const [statusSel, setStatusSel] = useState<Set<ProjectStatus>>(new Set());
  const [typeSel, setTypeSel]     = useState<Set<AppType>>(new Set());
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  // Drag-resizable left rail (#2816), the same pattern the Skills + graph rails use.
  const railDrag = useDragResize({ initial: 220, min: 190, max: 420, axis: "x" });

  // ── create flow: `+ New project` opens the full-pane ProjectSetupPage (name + blueprint) → bind.
  const [creating, setCreating]   = useState(false);
  const [collision, setCollision] = useState<{ title: string; published?: GhProject; local?: LocalProjectLite } | null>(null);

  // ── destructive modals.
  const [deleteTarget, setDeleteTarget] = useState<GhProject | null>(null);          // published board delete
  const [draftDeleteTarget, setDraftDeleteTarget] = useState<DraftRow | null>(null); // draft delete (#1216)
  const [draftError, setDraftError] = useState<string | null>(null);
  const [showOrphanCleanup, setShowOrphanCleanup] = useState(false);                 // orphan cleanup (#2998)

  const [localProjects, setLocalProjects] = useState<LocalProjectLite[]>([]);
  const [dbProjects, setDbProjects] = useState<DbProject[]>([]);
  const { workers } = useFleetLive();

  // Routed through `githubGraphql` so the read hits the backend TTL cache (#2447). See the original
  // fetch notes: the probe skips the heavy re-POST when no board moved; `force` (the ↻ sync) bypasses it.
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
        setGithubState(toMinimalGhProjects(nodes));
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [githubToken, setGithubState]);

  // Re-fetch whenever the Projects tab becomes active (the screen stays mounted across navigation).
  useEffect(() => {
    if (activeWorkspace === "projects") fetchProjects();
  }, [activeWorkspace, fetchProjects]);

  // Enumerate on-disk local projects whenever the tab opens.
  const refreshLocalProjects = useCallback(() => {
    return invoke<LocalProjectLite[]>("list_local_projects")
      .then((list) => { const arr = Array.isArray(list) ? list : []; setLocalProjects(arr); return arr; })
      .catch(() => { setLocalProjects([]); return []; });
  }, []);
  useEffect(() => {
    if (activeWorkspace !== "projects") return;
    void refreshLocalProjects();
  }, [activeWorkspace, refreshLocalProjects]);

  // Load the durable DB draft rows whenever the tab opens (#2995).
  useEffect(() => {
    if (activeWorkspace !== "projects") return;
    let cancelled = false;
    void listDbProjects().then((rows) => { if (!cancelled) setDbProjects(rows ?? []); });
    return () => { cancelled = true; };
  }, [activeWorkspace]);

  // Reconcile published markers + backfill titles (#922 / #2467) — unchanged from the prior layout.
  useEffect(() => {
    if (activeWorkspace !== "projects" || lastSync === null) return;
    const publishedTitles = new Set(projects.map(p => p.title.toLowerCase()));
    const publishedKeys   = new Set(projects.map(p => projectSlug(p.title)));
    const toMark = localProjects.filter(lp =>
      !lp.published &&
      (publishedTitles.has(lp.title.toLowerCase()) || publishedKeys.has(lp.key)),
    );
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

  // Persisted GitHub-state overlay (#2446): pre-live-fetch, render the last-known records as stale
  // board rows — but only for projects still on disk (don't resurrect a deleted hub).
  const staleProjects = useMemo<GhProject[]>(() => {
    if (lastSync !== null || !githubState?.records.length) return [];
    return filterRecordsToLocal(githubState.records, localProjects).map(minimalToGhProject);
  }, [lastSync, githubState, localProjects]);
  const effectiveProjects = lastSync !== null ? projects : staleProjects;
  const staleFetchedAt = lastSync === null && staleProjects.length > 0 ? githubState!.fetchedAt : null;
  const visibleProjects = effectiveProjects.filter(p => !hiddenProjectIds.includes(p.id));

  // ── open handlers (ported from PublishedProjects) ────────────────────────────────────────────────
  function reopenDraft(d: { key: string; title: string; pitch: string }) {
    setPlanningTitle(d.title);
    setPlanningContext(d.pitch, "");
    setActiveProjectMeta(null, "", "", 0);
    setPlanningSession(d.key);
    setProjectsView("planning");
  }

  function handleOpenGithubBoard(p: GhProject) {
    const repos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    setActiveProjectMeta(p.id, p.title, repos[0] ?? "", p.number, repos);
    navigate({ workspace: "github", page: "projects" });
    openGithubBoard("board");
  }

  // Enter the planning session under the settled key (#2409): key derived from name, node id kept for API.
  function openPlanning(p: GhProject, key: string) {
    const allRepos = p.repositories?.nodes?.map((r) => r.nameWithOwner) ?? [];
    const repo     = allRepos[0] ?? "";
    setActiveProjectMeta(p.id, p.title, repo, p.number, allRepos);
    setPlanningTitle(p.title);
    setPlanningContext(p.shortDescription ?? p.title, repo);
    setPlanningSession(key);
    setProjectsView("planning");
  }
  const reopen = useReopenProject<GhProject>(openPlanning, refreshLocalProjects);
  function handleEditPlan(p: GhProject) { reopen.begin(p, p.title, localProjects); }

  // ── draft delete (#1216) + orphan cleanup (#2998) — unchanged behavior ───────────────────────────
  async function deleteDraft(key: string) {
    setDraftError(null);
    try {
      await invoke("delete_project_dir", { projectKey: key });
    } catch (e) {
      setDraftError(`Couldn't delete the folder for "${key}": ${e}. It may be open in a console session — close it and retry.`);
      return;
    }
    try {
      removeDraftProject(key);
      void removeDbProject(key);
      setDbProjects(prev => (Array.isArray(prev) ? prev : []).filter(r => r.key !== key));
      deleteLocalProject([key]);
      setLocalProjects(prev => (Array.isArray(prev) ? prev : []).filter(lp => lp.key !== key));
    } catch (e) {
      setDraftError(`Removed the folder for "${key}" but couldn't update the project list: ${e}.`);
    }
  }
  async function confirmDeleteDraft() {
    if (!draftDeleteTarget) return;
    const key = draftDeleteTarget.key;
    setDraftDeleteTarget(null);
    await deleteDraft(key);
  }
  async function cleanupOrphans() {
    for (const o of orphans) { await deleteDraft(o.key); }
    await refreshLocalProjects();
    setShowOrphanCleanup(false);
  }

  // ── derived lists ────────────────────────────────────────────────────────────────────────────────
  const repos = useMemo(() => new Set(visibleProjects.flatMap(p => p.repositories?.nodes?.map(r => r.nameWithOwner) ?? [])), [visibleProjects]);

  // Per-project live fleet counts (matched by repo): running vs parked (asking/waiting/blocked).
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

  // Local drafts (on-disk truth ∪ store draft map ∪ DB drafts), minus anything already published.
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

  // Orphaned scaffolds (#2998): bare on-disk hubs invisible in the lists yet cluttering `projects/`.
  const orphans = localProjects.filter(lp => isOrphanScaffold(lp) && !allDrafts.some(d => d.key === lp.key));

  // key → durable lifecycle state — distinguishes a bare DRAFTED idea from a CREATED/in-progress one.
  const dbStateByKey = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of dbProjects) m[p.key] = p.state;
    return m;
  }, [dbProjects]);

  // Local published hubs not covered by a board (#2445) — the offline published set.
  const localPublishedAll = useMemo<LocalPublishedRow[]>(
    () => buildLocalPublished(localProjects, visibleProjects),
    [localProjects, visibleProjects],
  );

  // ── the unified item list + filter/sort (the Skills-shaped core) ─────────────────────────────────
  const items = useMemo(() => buildProjectItems({
    boards: visibleProjects,
    localPublished: localPublishedAll,
    drafts: allDrafts,
    dbStateByKey,
    fleetByProject,
    classificationByKey: planClassification,
    deployByKey: planDeployConfig,
  }), [visibleProjects, localPublishedAll, allDrafts, dbStateByKey, fleetByProject, planClassification, planDeployConfig]);

  const counts = useMemo(() => statusCounts(items), [items]);
  const typeCountsByCat = useMemo(() => typeCounts(items), [items]);
  const filtered = useMemo(() => filterProjects(items, { query, statusSel, typeSel, sort }), [items, query, statusSel, typeSel, sort]);
  const anyFilter = query.trim().length > 0 || statusSel.size > 0 || typeSel.size > 0;
  const isEmpty = filtered.length === 0;

  const toggleStatus = (s: ProjectStatus) => setStatusSel(prev => { const n = new Set(prev); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  const toggleType = (t: AppType) => setTypeSel(prev => { const n = new Set(prev); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const clearStatus = () => setStatusSel(new Set());
  const clearType = () => setTypeSel(new Set());
  const clearFilters = () => { setQuery(""); setStatusSel(new Set()); setTypeSel(new Set()); };

  const totalSummary = `${visibleProjects.length} published · ${allDrafts.length} draft${allDrafts.length !== 1 ? "s" : ""} · ${blueprints.length} blueprint${blueprints.length !== 1 ? "s" : ""} · ${repos.size} repo${repos.size !== 1 ? "s" : ""}`;

  // ── card routers ─────────────────────────────────────────────────────────────────────────────────
  function openItem(item: ProjectItem) {
    if (item.source === "board" && item.gh) handleEditPlan(item.gh);
    else if (item.source === "local") reopenDraft({ key: item.key, title: item.title, pitch: "" });
    else if (item.source === "draft" && item.draft) reopenDraft(item.draft);
  }
  function boardItem(item: ProjectItem) { if (item.gh) handleOpenGithubBoard(item.gh); }
  function deleteItem(item: ProjectItem) {
    if (item.source === "board" && item.gh) setDeleteTarget(item.gh);
    else if (item.source === "draft" && item.draft) setDraftDeleteTarget(item.draft);
  }

  // ── create flow: setup page → collision check → bind ─────────────────────────────────────────────
  // The setup page (which owns the name input) hands back the entered title + chosen blueprint. The
  // project's KEY is a slug of its name (#2409); a name that slugs onto an existing hub is a collision
  // (open the existing project, or pick a new name) rather than a silent fork — so check here first.
  function onStart(t: string, bpId: string) {
    const trimmed = t.trim();
    if (!trimmed) return;
    const draftKey = projectSlug(trimmed);
    const published = visibleProjects.find((p) => projectSlug(p.title) === draftKey);
    const local = (Array.isArray(localProjects) ? localProjects : []).find((lp) => lp.key === draftKey);
    if (published || local) { setCollision({ title: (published?.title ?? local?.title) || trimmed, published, local }); return; }
    handleStartPlanning(trimmed, bpId);
  }

  // Create + bind the CHOSEN blueprint (#3802) — `bpId` comes from the setup page, not the global
  // `activeBlueprintId`. Everything else (collision already checked, draft dual-write, title sidecar,
  // feature-seed, blueprint lock) is preserved from PublishedHeader.
  function handleStartPlanning(t: string, bpId: string) {
    const trimmed = t.trim();
    if (!trimmed) return;
    const draftKey = projectSlug(trimmed);
    setPlanningTitle(trimmed);
    setPlanningContext("", "");
    setActiveProjectMeta(null, "", "", 0);
    addDraftProject(draftKey, { title: trimmed, pitch: "", createdAt: Date.now() });
    // No `category` at creation (#3785): the row used to copy the seeding blueprint's lifecycle
    // category, but lifecycle left the blueprint model — the planner DISCOVERS it, so it isn't
    // known yet here. Glance reads the discovered `ClassifyConfig.lifecycle` instead.
    void addDbProject({ key: draftKey, title: trimmed, pitch: "", blueprint: bpId, state: "drafted" });
    fireInvoke("set_project_title", { projectKey: draftKey, title: trimmed });
    setProjectBlueprintId(draftKey, bpId);
    // #3785: seed the blueprint's curated feature list into the new project's Features stage.
    const bpFeatures = blueprints.find((b) => b.id === bpId)?.features;
    if (bpFeatures) setPlanStage(draftKey, FEATURES_KEY, bpFeatures);
    setPlanningSession(draftKey);
    setCreating(false);
    setProjectsView("planning");
  }

  return (
    <Box as="section" style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", overflow: "hidden" }}>
      {/* The create flow is a full pane BETWEEN the list and the planner: `+ New project` → setup
          page (name + blueprint) → planning. When creating, the list is hidden. */}
      {creating ? (
        <ProjectSetupPage onBack={() => setCreating(false)} onStart={onStart} />
      ) : (
      <Row align="stretch" className="projects-main" style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {/* LEFT rail — drag-resizable (a sized wrapper + a `.resize-x` splitter), the Skills pattern. */}
        <Box style={{ flex: `0 0 ${railDrag.size}px`, width: railDrag.size, minWidth: 0, display: "flex", overflow: "hidden" }}>
          <ProjectsRail
            query={query}
            setQuery={setQuery}
            statusSel={statusSel}
            toggleStatus={toggleStatus}
            typeSel={typeSel}
            toggleType={toggleType}
            counts={counts}
            typeCountsByCat={typeCountsByCat}
            total={items.length}
            onClearStatus={clearStatus}
            onClearType={clearType}
            onClearFilters={clearFilters}
          />
        </Box>
        <Box className="resize-x" {...railDrag.handleProps} title="Drag to resize" />

        {/* RIGHT main column — slim header over the card/list body. */}
        <Stack className="projects-listcol" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <Row className="projects-listhead" gap={14} align="center" style={{ height: 52, flex: "none", padding: "0 16px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
            <Box className="projects-listhead-summary" style={{ minWidth: 0, overflow: "hidden" }}>
              <Row className="mono" gap={8} align="center" style={{ fontSize: 11, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
                {githubToken ? <Text as="span" tone="success">● github connected</Text> : <Text as="span" tone="dim">○ github offline</Text>}
                <Text as="span" tone="dim">·</Text>
                <Box as="span" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{totalSummary}</Box>
              </Row>
            </Box>
            <Spacer />
            <Text as="span" mono size={11} tone="muted" style={{ flex: "none" }}>{filtered.length} <Text as="span" tone="dim">of {items.length}</Text></Text>
            <Button variant="ghost" onClick={() => fetchProjects({ force: true })} disabled={loading} style={{ flex: "none", fontSize: 11.5 }}>
              {loading ? "syncing…" : "↻ sync"}
            </Button>
            <Row gap={6} align="center" style={{ flex: "none" }}>
              <Text as="span" mono size={10} tone="dim" style={{ textTransform: "uppercase" }}>Sort</Text>
              <Dropdown<SortKey> value={sort} onChange={setSort} options={SORTS} size="sm" aria-label="Sort projects" />
            </Row>
            <SegmentedControl
              variant="joined"
              options={[
                { label: "▦ Cards", on: density === "cards", onClick: () => setDensity("cards") },
                { label: "☰ List", on: density === "list", onClick: () => setDensity("list") },
              ]}
            />
            <Button variant="primary" onClick={() => setCreating(true)} style={{ flex: "none", fontSize: 11.5 }}>+ New project</Button>
          </Row>

          {/* scroll body: errors · staleness hint · cards/list · orphan cleanup */}
          <Box style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: "auto", padding: "0 0 60px" }}>
            <Box style={{ padding: "14px 18px 0" }}>
              {error && (
                rateLimitNote(error) ? (
                  <Text as="div" mono size={11} tone="dim" style={{ marginBottom: 12 }}>{rateLimitNote(error)}</Text>
                ) : (
                  <InlineError pad={[12, 16]} radius={6} style={{ marginBottom: 12 }}>
                    {error.includes("read:project")
                      ? 'This token lacks the "read:project" scope. Re-authenticate in Settings → GitHub with project access.'
                      : error}
                  </InlineError>
                )
              )}
              {draftError && <InlineError radius="md" borderFade={60} style={{ marginBottom: 12 }}>{draftError}</InlineError>}
              {loading && items.length === 0 && (
                <Text as="div" mono size={12} tone="dim" style={{ textAlign: "center", padding: "40px 0" }}>Loading projects…</Text>
              )}
              {/* Staleness hint (#2446): a persisted overlay carries its age. The logged-out local-copies
                  hint was dropped (#3818) — the header's `○ github offline` already states the connection. */}
              {staleFetchedAt != null && (
                <Text className="hint" as="div" mono size={10} style={{ margin: "0 0 8px", paddingLeft: 2 }}>last synced {timeAgoMs(staleFetchedAt)}</Text>
              )}
            </Box>

            {isEmpty ? (
              <EmptyState
                icon="◇"
                iconVariant="dashed"
                title={anyFilter ? "No projects match" : "No projects yet"}
                description={anyFilter
                  ? "Nothing matches the active search + filters. Clear them, or start a new plan."
                  : "Start a plan — pick a blueprint and the planner turns your pitch into an executable project."}
                style={{ padding: "70px 20px" }}
                actions={<>
                  {anyFilter && <Button onClick={clearFilters}>Clear filters</Button>}
                  <Button variant="primary" onClick={() => setCreating(true)}>+ New project</Button>
                </>}
              />
            ) : density === "cards" ? (
              <Grid cols={2} gap={12} style={{ padding: "6px 18px 0" }}>
                {filtered.map(item => (
                  <ProjectCard key={item.id} item={item} variant="card"
                    onOpen={openItem} onBoard={boardItem} onDelete={deleteItem}
                    menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} />
                ))}
              </Grid>
            ) : (
              <Stack gap={8} style={{ padding: "6px 18px 0" }}>
                {filtered.map(item => (
                  <ProjectCard key={item.id} item={item} variant="row"
                    onOpen={openItem} onBoard={boardItem} onDelete={deleteItem}
                    menuOpenId={menuOpenId} setMenuOpenId={setMenuOpenId} />
                ))}
              </Stack>
            )}

            {/* Orphaned scaffolds (#2998): a quiet, confirm-gated cleanup affordance. */}
            {orphans.length > 0 && (
              <Row gap={8} align="center" style={{ margin: "14px 18px 0", paddingTop: 4 }}>
                <Text as="span" mono size={10} tone="dim">{orphans.length} orphaned scaffold{orphans.length !== 1 ? "s" : ""} · no plan</Text>
                <Box as="button" onClick={() => setShowOrphanCleanup(true)} className="mono"
                  style={{ background: "none", border: "none", padding: 0, color: "var(--fg-muted)", cursor: "pointer", fontSize: 10, textDecoration: "underline" }}>
                  Clean up
                </Box>
              </Row>
            )}
          </Box>
        </Stack>
      </Row>
      )}

      {/* ── modals ───────────────────────────────────────────────────────────────────────────────── */}

      {/* Name-collision modal (#2409). */}
      {collision && (
        <Dialog
          title="That name's already taken"
          onDismiss={() => setCollision(null)}
          actions={<>
            <Button variant="ghost" onClick={() => {
              const c = collision;
              setCollision(null);
              setCreating(false);
              if (c.published) handleEditPlan(c.published);
              else if (c.local) reopenDraft({ key: c.local.key, title: c.local.title, pitch: "" });
            }}>Open the existing project</Button>
            {/* Dismiss to the setup page (still mounted behind this modal) — the typed name is
                preserved there so the user can edit it. */}
            <Button variant="primary" onClick={() => setCollision(null)}>Choose a different name</Button>
          </>}
        >
          A project named <Text as="span" mono style={{ color: "var(--fg)" }}>“{collision.title}”</Text> already
          exists — the name IS the project (it names its files, sessions, and GitHub project), so two can't share it.
          Open it, or pick a different name to continue.
        </Dialog>
      )}

      {/* Reopen-mismatch modal (#2409): link an existing local hub onto the name key, or start fresh. */}
      {reopen.modal}

      {/* Published-project Keep-vs-Delete (#1216). */}
      {deleteTarget && (
        <DeleteProjectModal target={deleteTarget} onClose={() => setDeleteTarget(null)} setProjects={setProjects} />
      )}

      {/* Draft-delete confirmation (#1216). */}
      {draftDeleteTarget && (
        <ModalScrim onDismiss={() => setDraftDeleteTarget(null)}>
          <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 420, maxWidth: "90vw" }}>
            <h3 className="mono" style={{ margin: "0 0 8px", fontSize: 14, color: "var(--fg)" }}>Delete draft?</h3>
            <Text as="p" size={12} tone="muted" style={{ margin: "0 0 20px", lineHeight: 1.6 }}>
              <b style={{ color: "var(--fg)" }}>{draftDeleteTarget.title}</b> and its local planning folder
              will be permanently deleted. This draft was never published to GitHub, so there's nothing on
              GitHub to remove.
            </Text>
            <Row gap={8} align="stretch" justify="end">
              <Button variant="ghost" onClick={() => setDraftDeleteTarget(null)}>cancel</Button>
              <Button danger onClick={confirmDeleteDraft} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <Trash2 size={12} /> delete draft
              </Button>
            </Row>
          </Box>
        </ModalScrim>
      )}

      {/* Orphaned-scaffold cleanup confirmation (#2998). */}
      {showOrphanCleanup && (
        <ModalScrim onDismiss={() => setShowOrphanCleanup(false)}>
          <Box pad={[24, 28]} bg="var(--bg-elev)" border="soft" radius="lg" style={{ width: 460, maxWidth: "90vw" }}>
            <h3 className="mono" style={{ margin: "0 0 8px", fontSize: 14, color: "var(--fg)" }}>Clean up orphaned scaffolds?</h3>
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
