// Glance workspace (#2206, epic #2205) — the workspace-level mission control. A tabbed Screen (#2223):
// NETWORK (the project-network map: every project a node, dependencies as edges, cross-project CYCLES as
// coordination hazards) paired with FLEET (the live orchestration analytics for the active project's
// fleet). Network toolbar (search · cycle pill · zoom/fit) · sidebar (projects + hazards) · transform
// graph canvas · project/contract inspector. Nodes are the user's REAL projects; the topology is
// clearly-marked SAMPLE until a real cross-project dependency model lands (epic slice 4). Clicking a
// project will drill to its live agent network (L2, later slice) — for now it opens the inspector. The
// pan/zoom shell is the shared GraphCanvas template + useGraphViewport (#2208, epic #2197 slice 2).
import { useCallback, useEffect, useMemo, useState } from "react";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { demoSnapshot } from "@/store/demoSnapshot";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { useConfirmDialog } from "@/shared/ui/overlay/promptDialog";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Screen } from "@/shared/ui/layouts/Screen";
import { type TabItem } from "@/shared/ui/layouts/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { useCrumbEntity } from "@/shared/hooks/useCrumbEntity";
import { usePoll } from "@/shared/hooks/usePoll";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { SearchField } from "@/shared/ui/controls/SearchField";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { Fleet } from "@/features/planner/fleet/Fleet";
import { teamRoleStreams } from "@/features/planner/fleet/teamFleet";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { fleetPaneId } from "@/app/console/lib/paneIdentity";
import { buildGraph, focusSets, isLibraryNode, HEALTH_META, ROLE_COLOR, NW, NH } from "./lib/glanceGraph";
import { buildGlanceData } from "./lib/glanceData";
import { buildFleetData, buildRealFleetData, nodeHasLiveSession, livePanesForProject, withPreviewNode, PREVIEW_NODE_ID } from "./lib/glanceFleet";
import { useProjectComplete } from "./lib/useProjectComplete";
import { usePreviewReview } from "./usePreviewReview";
import type { PreviewSource } from "@/shared/lib/preview/previewSource";
import { useGlanceProjects, applyFaultHealth } from "./lib/useGlanceProjects";
import { useGlanceFaults } from "./lib/useGlanceFaults";
import { applyStallHealth, applyFleetLiveStatus } from "./lib/agentStall";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { useProjectFleet } from "./lib/useProjectFleet";
import "./glance.css";

// The agent-health watchdog (#2541) polls the coord log on a slow cadence — a stall is a minutes-scale
// event, so per-second rebuilds aren't worth it.
const STALL_POLL_MS = 15_000;

const GLANCE_TABS: TabItem[] = [
  { id: "network", label: "Network", hint: "projects · dependencies" },
  { id: "fleet", label: "Fleet", hint: "agents · throughput" },
];

export function GlanceWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const planFleet = useAppStore((s) => s.planFleet);
  const personas = useAppStore((s) => s.personas);
  // The blueprint LIBRARY + the drilled project's blueprint id (#2572) — so the fleet drill can overlay
  // the project blueprint's authored TEAM relationships (an Org) onto the derived coordination.
  const blueprints = useAppStore((s) => s.blueprints);
  const projectBlueprintId = useAppStore((s) => s.projectBlueprintId);
  // Launched-fleet panes (#2542): the set of pane ids that are live CELLS of an open tab — a durable,
  // symmetric "this agent has a terminal in the fleet" signal for BOTH workers AND the DIRECTOR. The
  // earlier per-pane runtime signals (roster / status / paneClaudeActive) covered workers but never the
  // director — it isn't a stream (so it's off the roster) and sits idle between prompts. Every fleet
  // node is a cell in the build tab, so tab membership opens them all. Ended/disabled cells drop out.
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
  // The REAL project set: published GitHub projects merged with local drafts (keyed by the plan key so the
  // drill resolves each project's fleet). A "planning" status marks a planned project; "live" (app running)
  // is the detection follow-up.
  const projectsBase = useGlanceProjects();
  const loadDemoState = useAppStore((s) => s.loadDemoState);
  const projectLinks = useAppStore((s) => s.projectLinks);
  const removeProjectLink = useAppStore((s) => s.removeProjectLink);
  // The UI-kit consumer index + kit library (#2571): drives the kit NODES on the L0 network (one per
  // distinct kit in use, edged to every consuming project — showing which projects share a kit).
  const kitUsage = useAppStore((s) => s.kitUsage);
  const kits = useAppStore((s) => s.kits);
  // Per-project auto-triage toggle (#2265) — gates the fault→fix loop; surfaced in the node inspector.
  const autoTriage = useAppStore((s) => s.autoTriage);
  const setAutoTriage = useAppStore((s) => s.setAutoTriage);
  // Ending a stuck agent's session (#3049): disabling the cell drops it from livePaneIds (so the node
  // stops reading as live) and setPaneStatus clears a stale "run" dot. fleetStartProject re-enables the
  // cell on the next launch, so this is self-reversing — "Relaunch fleet" respawns it fresh.
  const setPaneDisabled = useAppStore((s) => s.setPaneDisabled);
  const setPaneStatus = useAppStore((s) => s.setPaneStatus);
  // The per-pane run status — drives the fleet-drill agent nodes' live activity (#3252, `applyFleetLiveStatus`).
  const paneStatus = useAppStore((s) => s.paneStatus);
  // Confirm before the BULK "End sessions" (#3052) — stopping a whole fleet at once warrants a guard.
  const { confirm, dialog: endAllDialog } = useConfirmDialog();
  // HEALTH axis (#2541, was #2265): the worst unresolved fault per project (from `bsc errors`) overlaid
  // onto each node — escalating health to warning/error and carrying the fault title as the reason.
  const faults = useGlanceFaults(useMemo(() => projectsBase.map((p) => p.id), [projectsBase]));
  // Agent-health watchdog (#2541): `coord.state.waiting` carries each parked `bsc-wait` + its epoch; a
  // wait overstaying the threshold escalates its project to a warning. `now` ticks on the same slow
  // cadence (kept out of render — `Date.now()` is impure) so a threshold crossing surfaces without a
  // coord change.
  const coord = useCoordLog({ ms: STALL_POLL_MS });
  const [now, setNow] = useState(0);
  usePoll(async (isCancelled) => { if (!isCancelled()) setNow(Date.now()); }, STALL_POLL_MS, []);
  // Overlay order: base (merge+liveness) → STALL (waiting/warn) → FAULT (error) last, so a real error
  // beats a stall and both beat the resting state.
  const projects = useMemo(
    () => applyFaultHealth(applyStallHealth(projectsBase, coord.state.waiting, now), faults),
    [projectsBase, coord.state.waiting, faults, now],
  );
  // L0 — the project-network graph (nodes = real projects + UI-kit nodes #2571, edges = the user-drawn
  // relationships #2253 + one kit→project edge per consumer #2571).
  const projectData = useMemo(() => buildGlanceData(projects, projectLinks, kitUsage, kits), [projects, projectLinks, kitUsage, kits]);
  const projectModel = useMemo(() => buildGraph(projectData.rawNodes, projectData.rawEdges), [projectData]);

  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("glance", GLANCE_TABS);
  const page = pageOverride ?? activeId;

  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  // The drilled agent whose live PTY stream is open in the bottom dock (#2369). Null = closed.
  const [chatNode, setChatNode] = useState<string | null>(null);
  // The PREVIEW node morphed open (#2623) — the finished app rendered in the graph. Closed by default.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [showCycle, setShowCycle] = useState(false);
  const [search, setSearch] = useState("");
  // Drill (#…): clicking a project on the Network graph animates INTO that project's fleet-relationship
  // graph — the SAME canvas, a different graph (L0 project network → L1 agent fleet). `drill` is the
  // drilled project node id, held in the STORE so the app-wide nav history (mouse back/forward) can
  // drive it (see useNavHistory).
  const drill = useAppStore((s) => s.glanceDrill);
  const setDrill = useAppStore((s) => s.setGlanceDrill);
  // The drilled project's fleet, translated from plan.db. The store's `planFleet` only mirrors the ACTIVE
  // project, so for any OTHER project we load its fleet straight from its own plan.db (useProjectFleet).
  // Prefer the live store copy when it has streams so the active project never flashes sample → real.
  const loadedFleet = useProjectFleet(drill);
  const storeFleet = drill ? planFleet[drill] : undefined;
  const effectiveFleet = storeFleet && storeFleet.streams.length > 0 ? storeFleet : loadedFleet;

  const drillNode = drill ? projectModel.nodes.find((n) => n.id === drill) ?? null : null;
  // Name the drilled project in the titlebar crumb (#3041) — "" on the un-drilled network overview.
  useCrumbEntity("glance", drillNode?.slug ?? "");
  // The drilled project's authored team (#2572): its blueprint's `team` (positions + relationships).
  const drillTeam = useMemo(() => {
    const bpId = drill ? projectBlueprintId[drill] : undefined;
    return bpId ? blueprints.find((b) => b.id === bpId)?.team : undefined;
  }, [drill, projectBlueprintId, blueprints]);
  // Whether the drilled project's build is COMPLETE (#2623) — drives the ▷ preview node in the drill.
  const drillComplete = useProjectComplete(drill);
  // The verify-build state (#2623): the built PreviewSource + in-flight flag; the morph's "Build to
  // preview" button kicks the Rust `verify_build`, which resolves the stack, builds + serves, and returns
  // a PreviewSource (null until the backend command lands — the invoke degrades gracefully).
  const previewSources = useAppStore((s) => s.previewSources);
  const previewBuilding = useAppStore((s) => s.previewBuilding);
  const setPreviewSource = useAppStore((s) => s.setPreviewSource);
  const setPreviewBuilding = useAppStore((s) => s.setPreviewBuilding);
  const buildPreview = useCallback((key: string) => {
    setPreviewBuilding(key, true);
    void safeInvoke<PreviewSource | null>("verify_build", { projectKey: key }, null)
      .then((src) => { if (src) setPreviewSource(key, src); })
      .finally(() => setPreviewBuilding(key, false));
  }, [setPreviewBuilding, setPreviewSource]);
  // The reviewer loop for the open preview (#2623 slice 5b): capture a shot → Claude review → confirm-gated inbox.
  const previewReview = usePreviewReview(drill);
  const fleetData = useMemo(() => {
    if (!drillNode) return null;
    // Team-driven fleet (#3101/#3103): fold the team's ROLE-ACTOR streams (curator/documentor/…) into
    // the drilled graph so what SHOWS matches what LAUNCHES — the same `teamRoleStreams` the launch
    // composes (`usePlanPublish`). A team position for a seedable role becomes a node even before the
    // fleet plan lists a worker for it.
    const roleStreams = effectiveFleet ? teamRoleStreams(drillTeam, personas, effectiveFleet.streams) : [];
    const composed = effectiveFleet ? { ...effectiveFleet, streams: [...effectiveFleet.streams, ...roleStreams] } : undefined;
    const base = composed && composed.streams.length > 0
      ? buildRealFleetData(composed, personas, drillTeam)
      : buildFleetData({ id: drillNode.id, name: drillNode.slug });
    // Add the preview node when the project has finished building (idempotent, no-op while building).
    return withPreviewNode(base, drillComplete);
  }, [drillNode, effectiveFleet, personas, drillTeam, drillComplete]);
  // Overlay the LIVE session state onto the drilled fleet's agent nodes (#3252) — the L1 twin of the L0
  // stall/fault overlays: an agent lifts off its planned idle to building/waiting/warning per its session.
  // Applied to rawNodes BEFORE buildGraph so the rollup + inherited-health recompute over the live values.
  const liveFleetData = useMemo(
    () =>
      fleetData && drill
        ? { ...fleetData, rawNodes: applyFleetLiveStatus(fleetData.rawNodes, drill, { livePaneIds, paneStatus, waiting: coord.state.waiting, now }) }
        : fleetData,
    [fleetData, drill, livePaneIds, paneStatus, coord.state.waiting, now],
  );
  const fleetModel = useMemo(() => (liveFleetData ? buildGraph(liveFleetData.rawNodes, liveFleetData.rawEdges) : null), [liveFleetData]);
  // The ACTIVE graph — the drilled fleet (with live status), else the project network. Everything downstream
  // (canvas, sidebar, focus, cycles, viewport) reads these, so the whole page swaps its graph on drill.
  const data = liveFleetData ?? projectData;
  const model = fleetModel ?? projectModel;

  const vp = useGraphViewport({ w: model.worldW, h: model.worldH });
  // Fit only when a node is OPENED/closed — i.e. the DRILL target changes (L0 network ⇄ an L1 fleet) —
  // plus on mount and page change (#2554). Keying on `drill`, NOT `model`: `model` gets a fresh
  // reference on every data poll (the liveness/fault/stall overlays recompute it), and depending on it
  // re-fit the graph every few seconds, wiping out the user's pan/zoom. `fit` reads the current world
  // via a ref, so the deferred call still fits the freshly-swapped graph.
  const { fit } = vp;
  useEffect(() => {
    if (page !== "network") return;
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [drill, fit, page]);

  const selNodeId = sel?.type === "node" ? sel.id : null;
  const selEdgeId = sel?.type === "edge" ? sel.id : null;
  // Ignore a focus target that isn't in the CURRENT graph — e.g. a hover/selection left over from the
  // project network after drilling into a fleet. Otherwise the stale id spotlights nothing and greys out
  // every node on the new page until you mouse over one. Self-corrects on any page change (drill/back/fwd).
  const nodeExists = (id: string | null) => !!id && model.nodes.some((n) => n.id === id);
  const focusNode = nodeExists(hoverNode) ? hoverNode : nodeExists(selNodeId) ? selNodeId : null;
  const focus = focusSets(model, focusNode, hoverEdge ?? selEdgeId, showCycle && model.cyclePairs.length > 0);

  const pickNode = (id: string) => { setSel({ type: "node", id }); setShowCycle(false); };
  const pickEdge = (id: string) => { setSel({ type: "edge", id }); setShowCycle(false); };
  // A node is LIVE — its terminal openable via the in-graph morph — iff its identity pane id
  // (`<project>:<stream>` or `<project>:director`) is a live cell of a launched fleet tab. EVERY fleet
  // node — workers AND the director — gets the morph (#2534/#2542). Drilled only.
  const isLiveAgent = (nodeId: string) =>
    !!drill && nodeHasLiveSession(fleetPaneId(drill, nodeId), livePaneIds);
  // On the L0 network: a click drills into that project's fleet. Inside a fleet a click checks in on a
  // LIVE agent (morph → terminal, #2401) or selects a non-live one. (Project links are LLM-authored, not
  // drawn by hand — the manual connect-mode was removed, #2737 direction.)
  const onNodeClick = (id: string) => {
    // Inside a fleet: opening a LIVE agent morphs its node into the live terminal; a non-live agent has
    // no session to open, so it just selects → inspector.
    if (drill) {
      if (id === PREVIEW_NODE_ID) setPreviewOpen(true);       // the ▷ preview node → render the app (#2623)
      else if (isLiveAgent(id)) setChatNode(id);
      else pickNode(id);
    }
    // A cross-graph LIBRARY node (#2571 kit → generalized #3119: kit/algorithm/sound) has no fleet to
    // drill into — a click just SELECTS it (→ the library inspector).
    else if (isLibraryNode(projectModel.nodes.find((n) => n.id === id) ?? {})) pickNode(id);
    else { setDrill(id); setSel(null); setShowCycle(false); }
  };
  const exitDrill = () => { setDrill(null); setSel(null); setShowCycle(false); setChatNode(null); setPreviewOpen(false); };
  // Kill ONE live pane (#3049): terminate its PTY (mirrors the console's disable path) and disable the
  // cell so the node drops out of the live set + its stale "run" clears. fleetStartProject re-enables the
  // cell on relaunch, so the teardown is self-reversing — "Relaunch fleet" (#3044) respawns it.
  const killPane = (pid: string) => {
    void safeInvoke("pty_kill", { paneId: pid }, undefined);
    setPaneDisabled(pid, true);
    setPaneStatus(pid, "idle");
  };
  // END a single agent's session from its morph (#3049): tear it down + collapse the morph.
  const endSession = (pid: string) => { killPane(pid); setChatNode(null); };
  // The drilled project's live sessions — every launched pane under its `<key>:` prefix (director +
  // workers). The `:` delimiter makes the prefix exact (`cli:` never matches `cli-typer:`). Drives the
  // toolbar "End sessions" button + its count.
  const liveProjectPanes = useMemo(
    () => (drill ? livePanesForProject(drill, livePaneIds) : []),
    [drill, livePaneIds],
  );
  // END EVERY session for the drilled project (#3052) — the bulk form of endSession, behind a confirm
  // (this stops the whole fleet at once). Self-reversing like the single kill: worktrees/branches/plan.db
  // are untouched, so "Relaunch fleet" restarts them.
  const endAllSessions = async () => {
    const panes = liveProjectPanes;
    if (panes.length === 0) return;
    const ok = await confirm({
      title: `End ${panes.length} session${panes.length === 1 ? "" : "s"}?`,
      message: `Kills every live agent for ${drillNode?.slug ?? "this project"} (director + workers). `
        + `Their worktrees, branches, and plan are kept — "Relaunch fleet" restarts them.`,
      confirmLabel: "End sessions",
      cancelLabel: "Cancel",
      danger: true,
    });
    if (!ok) return;
    for (const pid of panes) killPane(pid);
    setChatNode(null);
  };

  // The dock shows ONLY while the open node is still a live agent in the CURRENT fleet — so drilling
  // out (or a nav-history back/forward that swaps `drill`) closes it by derivation, no reset effect.
  const chatPaneId = drill && chatNode && isLiveAgent(chatNode) ? fleetPaneId(drill, chatNode) : null;
  const chatMeta = chatPaneId ? model.nodes.find((n) => n.id === chatNode) : null;
  // The preview morph shows only while the drill still HAS a preview node — drilling out / to an incomplete
  // project closes it by derivation. `source` is null until the verify-build produces one (#2623 slice 3).
  const previewOn = previewOpen && !!drill && model.nodes.some((n) => n.preview);

  // On opening a live agent's terminal (#2534): bring its node into view and ensure a readable zoom, so
  // the in-graph terminal lands legible (option A: it scales with the graph). centerOn is the
  // least-disruptive focus (keeps the current zoom); we only bump zoom up when the graph is small.
  useEffect(() => {
    if (!chatPaneId || !chatMeta) return;
    if (vp.view.scale < 0.85) vp.zoomTo(1);
    vp.centerOn(chatMeta.x + NW / 2, chatMeta.y + NH / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatPaneId]);

  const q = search.trim().toLowerCase();
  const sidebar = model.nodes.slice().sort((a, b) => a.layer - b.layer || a.slug.localeCompare(b.slug)).filter((n) => !q || n.slug.toLowerCase().includes(q));
  // An un-drilled project network with no projects yet. We ALWAYS render the (empty) graph now (#3033) —
  // never a blocking empty-state page — and instead surface a one-click "Load demo" in the toolbar so the
  // #2272 demo stays reachable. (Create a project in the Projects workspace via the Rail as usual.)
  const networkEmpty = !drill && projectModel.nodes.length === 0;

  return (
    <Screen
      tabs={tabs}
      active={page}
      onSelect={select}
      onReorder={reorder}
      onTearOff={tearOff}
      pageOverride={pageOverride}
      className="glance-workspace"
    >
      {page === "fleet" ? <Fleet /> : (
      // The graph must FILL the screen body (a pan/zoom canvas, not scrolling content); the shared
      // .screen-body is a block scroll container, so give it an explicit full-height flex column.
      <Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <GraphCanvas
      vp={vp}
      world={{ w: model.worldW || 1600, h: model.worldH || 900 }}
      canvasBackground="radial-gradient(120% 120% at 30% 0%, var(--bg-elev) 0%, var(--bg) 100%)"
      // The infinite viewport grid (#2418, the same graph paper org uses) — 28px tiles; the color
      // matches the old in-world grid (12% fg dots at 0.6 layer opacity ⇒ ~7.2% fg).
      grid gridSize={28} gridColor="color-mix(in oklch, var(--fg) 7.2%, transparent)"
      overlays={<GlanceOverlays drill={!!drill} archetypes={drill ? Array.from(new Set(model.edges.map((e) => e.archetype).filter((a): a is string => !!a))) : []} />}
      railResizable railWidth={266} railMin={200} railMax={420}
      inspectorResizable inspectorWidth={340} inspectorMin={280} inspectorMax={520}
      // Click the empty canvas → clear the selection + any cycle highlight (#2232).
      onBackgroundClick={() => { setSel(null); setShowCycle(false); }}
      toolbar={
        <>
          {/* The 'glance' wordmark + 'project network' subtitle were redundant chrome — the Rail already
              names the workspace and the graph IS the project network — so dropped (#2692). The L1 drill
              breadcrumb (which project's fleet you're in) stays; the '← projects' button exits it. */}
          {drill && <Text as="span" mono size={11} tone="dim">{`${drillNode?.slug ?? "project"} · fleet`}</Text>}
          {drill && <Button variant="ghost" onClick={exitDrill}>← projects</Button>}
          {/* The project filter moved into the rail's search slot (#2797) — every graph nav menu now leads
              with a search box. Manual connect-mode was removed (#2737): links are LLM-authored, not drawn
              by hand. The graph is configured by the planner/agents, never wired manually here. */}
          <Box style={{ flex: 1 }} />
          {drill
            ? (data.sample
                ? <Chip color="var(--warn, #f2b155)">sample fleet · no plan.db fleet</Chip>
                : <Chip color="#4fd6a0">real fleet · {model.nodes.length} agents</Chip>)
            : (data.sample && <Chip color="var(--warn, #f2b155)">sample topology · preview</Chip>)}
          {/* Project-level bulk kill (#3052): end EVERY live session for the drilled project at once —
              the fast recovery when a whole fleet is soft-locked. Shown only when it has live sessions. */}
          {drill && liveProjectPanes.length > 0 && (
            <Button variant="ghost" danger onClick={endAllSessions}
              title="End every live agent session for this project — Relaunch fleet restarts them">
              End {liveProjectPanes.length} session{liveProjectPanes.length === 1 ? "" : "s"}
            </Button>
          )}
          {model.cyclePairs.length > 0 && (
            <Box as="button" onClick={() => { setShowCycle((v) => !v); setSel(null); }}
              style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderRadius: 7, padding: "6px 11px",
                background: showCycle ? "rgba(242,85,95,.18)" : "rgba(242,85,95,.08)", border: `1px solid ${showCycle ? "rgba(242,85,95,.55)" : "rgba(242,85,95,.3)"}` }}>
              <Text as="span" style={{ color: "var(--graph-health-error)" }}>▲</Text>
              <Text as="span" mono size={11} weight={600} style={{ color: "#f2848b" }}>{model.cyclePairs.length} cycle</Text>
            </Box>
          )}
          <ZoomControls vp={vp} step={1.2} />
          <Button variant="ghost" onClick={vp.fit}>fit</Button>
          {/* No projects yet → keep the one-click demo reachable here instead of a blocking empty page (#3033). */}
          {networkEmpty && <Button variant="ghost" title="Load a demo platform — projects, fleets, and libraries" onClick={() => loadDemoState(demoSnapshot())}>Load demo</Button>}
        </>
      }
      rail={
        // Headerless graph-nav menu (#2797): the project/agent filter leads the rail as a search box;
        // the coordination-hazards footer stays pinned below.
        <GraphRail
          tools={<SearchField value={search} onChange={setSearch} placeholder={drill ? "Filter agents…" : "Filter projects…"} aria-label="Filter projects" style={{ width: "100%" }} />}
          footer={model.cyclePairs.length > 0 ? (
            <Box style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
              <Row gap={7} align="center" style={{ marginBottom: 9 }}>
                <Text as="span" style={{ color: "var(--graph-health-error)" }}>▲</Text>
                <Text as="span" mono size={11} style={{ letterSpacing: "1px", color: "#f2848b" }}>COORDINATION HAZARDS</Text>
              </Row>
              {model.cyclePairs.map(([a, b]) => (
                <Box key={a + b} onClick={() => { setShowCycle(true); setSel(null); }}
                  style={{ background: "rgba(242,85,95,.08)", border: "1px solid rgba(242,85,95,.28)", borderRadius: 7, padding: "9px 11px", cursor: "pointer", marginBottom: 6 }}>
                  <Text as="div" mono size={11} style={{ color: "#f3a4a9", marginBottom: 3 }}>dependency cycle</Text>
                  <Text as="div" mono size={11.5}>{model.nodes.find((n) => n.id === a)?.slug} ⇄ {model.nodes.find((n) => n.id === b)?.slug}</Text>
                </Box>
              ))}
            </Box>
          ) : undefined}
        >
          {sidebar.map((n) => {
            const st = HEALTH_META[n.rollupHealth];
            return (
              <RailRow key={n.id} active={selNodeId === n.id}
                onClick={() => onNodeClick(n.id)}
                onMouseEnter={() => setHoverNode(n.id)} onMouseLeave={() => setHoverNode(null)}
                leading={<StatusDot color={st.color} size={7} style={{ boxShadow: st.pulse ? `0 0 7px ${st.color}` : "none" }} />}
                trailing={<>
                  {(n.faults ?? 0) > 0 && (
                    <Text as="span" mono size={9.5} weight={700} title={`${n.faults} unresolved runtime faults`}
                      style={{ flex: "none", color: "#fff", background: "var(--graph-health-error)", borderRadius: 8, padding: "1px 5px", minWidth: 15, textAlign: "center" }}>
                      {(n.faults ?? 0) > 99 ? "99+" : n.faults}
                    </Text>
                  )}
                  <Box style={{ width: 8, height: 3, borderRadius: 2, background: ROLE_COLOR[n.role], flex: "none" }} />
                </>}>
                {n.slug}
              </RailRow>
            );
          })}
        </GraphRail>
      }
      inspector={sel ? <GlanceInspector model={model} selType={sel.type} selId={sel.id} onSelectNode={pickNode} onClose={() => setSel(null)}
        onRemoveEdge={!drill && !data.sample ? removeProjectLink : undefined}
        autoTriageOn={!drill && sel.type === "node" ? !!autoTriage[sel.id] : undefined}
        onToggleAutoTriage={!drill && sel.type === "node" ? (on) => setAutoTriage(sel.id, on) : undefined}
        // Open the real PTY stream (#2369) — only for a drilled, LIVE agent node.
        onOpenStream={sel.type === "node" && isLiveAgent(sel.id) ? (id) => setChatNode(id) : undefined} /> : undefined}
    >
      {/* keyed so drilling in/out remounts + replays the shared transition (graphCanvas.css, #2418) */}
      <Box key={drill ?? "network"} className="graph-drill-anim" style={{ position: "absolute", inset: 0 }}>
        <GlanceCanvas
          model={model} dragMoved={vp.dragMoved} zoom={vp.view.scale}
          focus={focus} selNodeId={selNodeId} selEdgeId={selEdgeId}
          onHoverNode={setHoverNode} onHoverEdge={setHoverEdge} onSelectNode={onNodeClick} onSelectEdge={pickEdge}
          // The live-agent terminal morphs open IN the graph, as an oversized node (#2534).
          chat={chatPaneId && chatNode ? { nodeId: chatNode, paneId: chatPaneId, name: chatMeta?.slug ?? "agent", role: chatMeta?.roleLabel } : null}
          onCloseChat={() => setChatNode(null)}
          onEndChat={chatPaneId ? () => endSession(chatPaneId) : undefined}
          preview={previewOn && drill ? {
            nodeId: PREVIEW_NODE_ID, name: drillNode?.slug ?? "app",
            source: previewSources[drill] ?? null,
            building: !!previewBuilding[drill],
            onBuild: () => buildPreview(drill),
            review: previewReview,
          } : null}
          onClosePreview={() => setPreviewOpen(false)}
        />
      </Box>
    </GraphCanvas>
      </Box>
      </Box>
      )}
      {/* The bulk "End sessions" confirm (#3052) — rendered regardless of page. */}
      {endAllDialog}
    </Screen>
  );
}
