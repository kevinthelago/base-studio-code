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
import { resolveKitLibraryRefs } from "@/features/designs";
import { FleetGraphHost } from "@/features/planner/fleet/FleetGraphHost";
import { teamRoleStreams } from "@/features/planner/fleet/teamFleet";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { cellRect, placeByDirection, releaseCell, occupants, clampCell, DEFAULT_CELL, type CellSize, type MorphPlacement } from "./lib/morphGrid";
import { fleetPaneId, findPaneOwnerTab } from "@/app/console/lib/paneIdentity";
import { resumeProjectFleet, nothingToResume } from "./lib/resumeProject";
import { buildGraph, focusSets, isBandNode, HEALTH_META, ROLE_COLOR } from "./lib/glanceGraph";
import { timedSync } from "@/shared/lib/core/perf";
import { buildGlanceData } from "./lib/glanceData";
import { buildFleetData, buildRealFleetData, nodeHasLiveSession, livePanesForProject, withPreviewNode, PREVIEW_NODE_ID } from "./lib/glanceFleet";
import { BASE_STUDIO_PROJECT, BASE_STUDIO_PROJECT_ID, buildStudioFleetData, studioPaneIdForNode, studioNodeHome, studioSessionLive, applyStudioLiveStatus } from "./lib/studioProject";
import { DEBUG_PANE_ID } from "@/features/debug";
import { isStudioId, useStudioViewers } from "@/features/studio-sessions";
import { useProjectComplete } from "./lib/useProjectComplete";
import { usePreviewReview } from "./usePreviewReview";
import type { PreviewSource } from "@/shared/lib/preview/previewSource";
import { useGlanceProjects, applyFaultHealth, applyOffHealth } from "./lib/useGlanceProjects";
import { useGlanceFaults } from "./lib/useGlanceFaults";
import { applyStallHealth, applyFleetLiveStatus, liveWaits } from "./lib/agentStall";
import { useCoordLog } from "@/shared/lib/fleet/useCoordLog";
import { useProjectFleet } from "./lib/useProjectFleet";
import { useFleetHeld } from "./lib/useFleetHeld";
import "./glance.css";
import { ensureClaudeRunning } from "@/shared/lib/session/ensureClaudeRunning";

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
  // The base-studio-code default project (#3319) renders the Studio Network team; the debug toggle gates
  // its debugger node.
  const teams = useAppStore((s) => s.teams);
  const debugSession = useAppStore((s) => s.debugSession);
  // #3498: the auto-spawned request sessions, so each is a visible, openable node in this graph.
  const activeDebugSlots = useAppStore((s) => s.activeDebugSlots);
  const setDebugSession = useAppStore((s) => s.setDebugSession);
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
  // Resume wiring (#glance-resume): jump to a live agent's Console pane, resume a single dormant pane in
  // place, and find a project's existing build tab so a project-resume can prefer jumping over rebuilding.
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setActiveTab = useAppStore((s) => s.setActiveTab);
  const setFocusedPane = useAppStore((s) => s.setFocusedPane);
  const resumePaneSession = useAppStore((s) => s.resumePaneSession);
  const findFleetTabIdx = useAppStore((s) => s.findFleetTabIdx);
  // Opening a base-studio-code studio node reveals its session on its own workspace page (#glance-resume);
  // `paneClaudeActive` tells us whether that stable-id session is already running.
  const navigate = useAppStore((s) => s.navigate);
  const paneClaudeActive = useAppStore((s) => s.paneClaudeActive);
  const projectLinks = useAppStore((s) => s.projectLinks);
  const removeProjectLink = useAppStore((s) => s.removeProjectLink);
  // The UI-kit consumer index + kit library (#2571): drives the kit NODES on the L0 network (one per
  // distinct kit in use, edged to every consuming project — showing which projects share a kit).
  const kitUsage = useAppStore((s) => s.kitUsage);
  const kits = useAppStore((s) => s.kits);
  // The cross-graph LIBRARY dimension (#3133): the algorithms/sounds each kit's components import. Memoized
  // on `components` ALONE — deriving it scans every component's source, and `projects` below re-identifies
  // on each status tick (faults/stall/`now`), so folding the scan into the `projectData` memo would re-run
  // it on every poll. This way the scan runs only when the component library actually changes.
  const components = useAppStore((s) => s.components);
  const libraryRefs = useMemo(() => resolveKitLibraryRefs(components), [components]);
  // The MCP-CONTRACT dimension (#3786, Phase 1 inter-app contracts): the MCP server store drives one
  // external contract node per SCOPED server (a global server is skipped), edged from each consuming
  // project — showing which projects contract with which external MCP servers.
  const mcpServers = useAppStore((s) => s.mcpServers);
  // Per-project auto-triage toggle (#2265) — gates the fault→fix loop; surfaced in the node inspector.
  const autoTriage = useAppStore((s) => s.autoTriage);
  const setAutoTriage = useAppStore((s) => s.setAutoTriage);
  // Per-node OFF toggle (#3239) — the user has deactivated these nodes; they render greyed (health `off`)
  // and read "off" over any live status. Persisted, so it continues from the last session.
  const glanceOff = useAppStore((s) => s.glanceOff);
  const setGlanceNodeOff = useAppStore((s) => s.setGlanceNodeOff);
  // Ending a stuck agent's session (#3049): disabling the cell drops it from livePaneIds (so the node
  // stops reading as live) and setPaneStatus clears a stale "run" dot. fleetStartProject re-enables the
  // cell on the next launch, so this is self-reversing — "Relaunch fleet" respawns it fresh.
  const setPaneDisabled = useAppStore((s) => s.setPaneDisabled);
  const setPaneStatus = useAppStore((s) => s.setPaneStatus);
  // The per-pane run status — drives the fleet-drill agent nodes' live activity (#3252, `applyFleetLiveStatus`).
  const paneStatus = useAppStore((s) => s.paneStatus);
  // #4005 — panes STOPPED waiting on the user (permission prompt / input wait), from the shared
  // pane-activity read. Drives the `attention` health so a blocked session is visible without drilling.
  const paneAttention = useAppStore((s) => s.paneAttention);
  // Memoized so the fleet-status memo below is not invalidated by a fresh Set on every render.
  const attentionPanes = useMemo(
    () => new Set(Object.keys(paneAttention).filter((p) => paneAttention[p])),
    [paneAttention],
  );
  // #3916: quarantine is a FIRST-CLASS node state now — a warden hard-pause used to be invisible
  // here, so a killed worker read as a plain `off` node (indistinguishable from never-launched).
  const quarantinedPanes = useAppStore((s) => s.quarantinedPanes);
  // Confirm before the BULK "End sessions" (#3052) — stopping a whole fleet at once warrants a guard.
  const { confirm, dialog: endAllDialog } = useConfirmDialog();
  // HEALTH axis (#2541, was #2265): the worst unresolved fault per project (from `bsc errors`) overlaid
  // onto each node — escalating health to warning/error and carrying the fault title as the reason.
  const faults = useGlanceFaults(useMemo(() => projectsBase.map((p) => p.id), [projectsBase]));
  // Agent-health watchdog (#2541): `coord.state.waiting` carries each parked `bsc-wait` + its epoch; a
  // wait overstaying the threshold escalates its project to a warning. `now` ticks on the same slow
  // cadence (kept out of render — `Date.now()` is impure) so a threshold crossing surfaces without a
  // coord change.
  const coord = useCoordLog();
  // #4010 — sessions parked by `bsc-maintain`. Memoized for the same reason: a fresh Set each render
  // would invalidate the fleet-status memo below on every tick.
  const maintainingPanes = useMemo(
    () => new Set(coord.state.maintaining.map((m) => m.session)),
    [coord.state.maintaining],
  );

  const [now, setNow] = useState(0);
  usePoll(async (isCancelled) => { if (!isCancelled()) setNow(Date.now()); }, STALL_POLL_MS, []);
  // Overlay order: base (merge+liveness) → STALL (waiting/warn) → FAULT (error) → OFF (#3239) last, so a
  // real error beats a stall and both beat the resting state — but the user's manual OFF beats them all
  // ("if it's not idle then it should be off").
  // A stall is only a stall while the agent is still THERE (#3429) — a wait parked by a since-dead session
  // pinned its project orange forever, since nothing ever clears it and `now - w.at` only grows.
  const liveWaiting = useMemo(() => liveWaits(coord.state.waiting, livePaneIds), [coord.state.waiting, livePaneIds]);
  const projects = useMemo(
    // The base-studio-code default project (#3319) is always present alongside the user's real projects —
    // the app's own studio sessions live under it; drilling it renders the Studio Network team. It's
    // appended AFTER the health overlays (incl. the manual OFF, #3239) so it stays always-on.
    () => [...applyOffHealth(applyFaultHealth(applyStallHealth(projectsBase, liveWaiting, now), faults), glanceOff), BASE_STUDIO_PROJECT],
    [projectsBase, liveWaiting, faults, now, glanceOff],
  );
  // L0 — the project-network graph (nodes = real projects + UI-kit nodes #2571 + the algorithm/sound
  // library nodes their kits require #3133 + external MCP-contract nodes #3786, edges = the user-drawn
  // relationships #2253 + one kit→project edge per consumer #2571 + the transitive project→library
  // `requires` edges #3133 + one project→mcp `uses-mcp` edge per scoped consumer #3786).
  const projectData = useMemo(
    () => buildGlanceData(projects, projectLinks, kitUsage, kits, libraryRefs, mcpServers),
    [projects, projectLinks, kitUsage, kits, libraryRefs, mcpServers],
  );
  const projectModel = useMemo(() => timedSync("buildGraph:glance-project", () => buildGraph(projectData.rawNodes, projectData.rawEdges)), [projectData]);

  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("glance", GLANCE_TABS);
  const page = pageOverride ?? activeId;

  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  // The drilled agents whose live PTY streams are morphed open in the graph (#2369 → MULTI, #3361).
  // Each carries the LATTICE CELL it occupies — signed, so a node left of the anchor holds a cell left
  // of it (#3367). Placements are stable: opening or closing one morph never moves another.
  const [placements, setPlacements] = useState<MorphPlacement[]>([]);
  // The node the grid is anchored on: the FIRST one opened. Slot 0 sits centred on it, so opening a
  // single node looks exactly as it always has and the grid only becomes visible from the second morph.
  // Held as an ID (not coords) so the grid tracks the graph when the model re-lays-out, and RETAINED
  // even if the anchor's own morph closes, so the remaining morphs never shift under the user.
  const [gridAnchorId, setGridAnchorId] = useState<string | null>(null);
  // The grid's SHARED cell size — any morph's resize handles drive it, so they all resize as one.
  const [cell, setCell] = useState<CellSize>(DEFAULT_CELL);
  // The PREVIEW node morphed open (#2623) — the finished app rendered in the graph. Closed by default.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [showCycle, setShowCycle] = useState(false);
  const [search, setSearch] = useState("");
  // Resume (#glance-resume): in-flight flag + a transient status line (a failure reason, or a launch
  // note such as "2 completed workers relaunching into maintenance").
  const [resuming, setResuming] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  // Drill (#…): clicking a project on the Network graph animates INTO that project's fleet-relationship
  // graph — the SAME canvas, a different graph (L0 project network → L1 agent fleet). `drill` is the
  // drilled project node id, held in the STORE so the app-wide nav history (mouse back/forward) can
  // drive it (see useNavHistory).
  const drill = useAppStore((s) => s.glanceDrill);
  const setDrill = useAppStore((s) => s.setGlanceDrill);
  // The MORPH is a first-class viewer of an app-owned studio session (#3357): opening a studio node starts
  // its session (lazily) and holds the idle reaper off for as long as the morph is open, exactly like its
  // page dock. Null for every other node, so the hook no-ops. (The debugger is NOT a studio here — its
  // lifecycle is the Settings toggle, not the reaper.)
  // MULTI (#3361): every open studio node must be pinned, not just the newest — otherwise the idle
  // reaper could kill a session the user has on screen in another morph.
  const openStudioIds = useMemo(
    () => (drill === BASE_STUDIO_PROJECT_ID ? occupants(placements).filter(isStudioId) : []),
    [drill, placements],
  );
  useStudioViewers(openStudioIds);
  const closeStudio = useAppStore((s) => s.closeStudio);
  // The drilled project's fleet, translated from plan.db. The store's `planFleet` only mirrors the ACTIVE
  // project, so for any OTHER project we load its fleet straight from its own plan.db (useProjectFleet).
  // Prefer the live store copy when it has streams so the active project never flashes sample → real.
  const loadedFleet = useProjectFleet(drill);
  const storeFleet = drill ? planFleet[drill] : undefined;
  const effectiveFleet = storeFleet && storeFleet.streams.length > 0 ? storeFleet : loadedFleet;
  // #3931: which streams the dependency gate is holding, so their nodes explain themselves instead of
  // rendering as anonymous dark `off` nodes. Read-only — this never launches anything.
  const heldStreams = useFleetHeld(drill, effectiveFleet?.streams);

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
    // The synthetic base-studio-code project (#3319) drills into the app's OWN studio-session graph — the
    // Studio Network team, with the debugger node gated by the Settings toggle (#3317). No plan.db fleet.
    if (drillNode.id === BASE_STUDIO_PROJECT_ID) return buildStudioFleetData(teams, personas, debugSession, activeDebugSlots);
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
  }, [drillNode, effectiveFleet, personas, drillTeam, drillComplete, teams, debugSession, activeDebugSlots]);
  // Overlay the LIVE session state onto the drilled fleet's agent nodes (#3252) — the L1 twin of the L0
  // stall/fault overlays: an agent lifts off its planned idle to building/waiting/warning per its session.
  // Applied to rawNodes BEFORE buildGraph so the rollup + inherited-health recompute over the live values.
  const liveFleetData = useMemo(
    () =>
      fleetData && drill
        ? {
            ...fleetData,
            // The base-studio project's nodes are STUDIO sessions, keyed by their stable app-owned pane id
            // (`studioPaneIdForNode`) — not `fleetPaneId(project, node)`. Running the fleet overlay over them
            // looked up a pane that never exists, so none was ever found live (#3421).
            rawNodes:
              drill === BASE_STUDIO_PROJECT_ID
                ? applyStudioLiveStatus(fleetData.rawNodes, { debugSession, paneClaudeActive, paneStatus })
                : applyFleetLiveStatus(fleetData.rawNodes, drill, { livePaneIds, paneStatus, waiting: coord.state.waiting, now, quarantined: quarantinedPanes, held: heldStreams, attention: attentionPanes, maintaining: maintainingPanes }),
          }
        : fleetData,
    // `quarantinedPanes` + `heldStreams` belong here: without them the memo keeps a stale overlay, so a
    // newly quarantined worker (#3916) or a stream released by the gate (#3931) would not repaint until
    // some unrelated dep changed.
    [fleetData, drill, livePaneIds, paneStatus, coord.state.waiting, now, debugSession, paneClaudeActive, quarantinedPanes, heldStreams, attentionPanes, maintainingPanes],
  );
  const fleetModel = useMemo(() => (liveFleetData ? timedSync("buildGraph:glance-fleet", () => buildGraph(liveFleetData.rawNodes, liveFleetData.rawEdges)) : null), [liveFleetData]);
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
  // The app-owned studio session pane id for a node in the base-studio-code drill (#3326/#3357) — every
  // studio node (debugger + designer/librarian/architect) maps to its TerminalHost-hosted session; a
  // library/resource node or any non-studio drill returns null. Non-null ⇒ this node opens an app-owned
  // session, not a fleet cell.
  const studioPaneId = (nodeId: string): string | null =>
    drill === BASE_STUDIO_PROJECT_ID ? studioPaneIdForNode(nodeId) : null;
  // A node is MORPHABLE — its terminal openable inline via the in-graph morph — iff its identity pane id
  // (`<project>:<stream>` or `<project>:director`) is a live cell of a launched fleet tab. EVERY fleet
  // node — workers AND the director — gets the morph (#2534/#2542). Drilled only. In the base-studio-code
  // drill EVERY studio session node morphs (#3357): all four now live on the shared TerminalHost, so the
  // host can re-parent their single terminal into the morph. The debugger additionally requires its
  // Settings toggle (its node only EXISTS while the toggle is on); the designer/librarian/architect are
  // always openable — clicking one lazily STARTS its session if it isn't up (stable pane id ⇒ it resumes
  // the same conversation, never a second session).
  const isLiveAgent = (nodeId: string) => {
    if (!drill) return false;
    if (drill === BASE_STUDIO_PROJECT_ID) {
      if (studioNodeHome(nodeId)?.kind !== "morph") return false;
      return nodeId === "debugger" ? debugSession : true;
    }
    return nodeHasLiveSession(fleetPaneId(drill, nodeId), livePaneIds);
  };
  // Whether a node's SESSION is actually running (#glance-resume) — the studio analogue of morph-liveness.
  // Drives the details-pane action's wording (open a running session vs resume a stopped one). A studio
  // node reads its app-owned session's live signals; a fleet node is live when its cell is live.
  const nodeActive = (nodeId: string) =>
    drill === BASE_STUDIO_PROJECT_ID
      ? studioSessionLive(nodeId, { debugSession, paneClaudeActive, paneStatus })
      : isLiveAgent(nodeId);
  // On the L0 network: a click drills into that project's fleet. Inside a fleet a click checks in on a
  // LIVE agent (morph → terminal, #2401) or selects a non-live one. (Project links are LLM-authored, not
  // drawn by hand — the manual connect-mode was removed, #2737 direction.)
  const onNodeClick = (id: string) => {
    // Inside a fleet: opening a LIVE agent morphs its node into the live terminal; a non-live agent has
    // no session to open, so it just selects → inspector.
    if (drill) {
      if (id === PREVIEW_NODE_ID) setPreviewOpen(true);       // the ▷ preview node → render the app (#2623)
      else if (isLiveAgent(id)) openChat(id);
      else pickNode(id);
    }
    // A fenced-BAND node — a cross-graph LIBRARY node (#2571 kit → #3119 kit/algorithm/sound) OR an
    // external MCP-CONTRACT node (#3786) — has no fleet to drill into, so a click just SELECTS it
    // (→ the library/contract inspector).
    else if (isBandNode(projectModel.nodes.find((n) => n.id === id) ?? {})) pickNode(id);
    // An OFF (deactivated) node (#3239): a click SELECTS it (→ the details pane, where the user turns it
    // back on) rather than drilling into a fleet the user has muted.
    else if (glanceOff[id]) pickNode(id);
    else { setDrill(id); setSel(null); setShowCycle(false); }
  };
  // OPEN a node's session into a grid cell (#3361). The FIRST open also anchors the grid on that node,
  // so its morph grows exactly where a lone morph always has. Every later node is placed in the
  // DIRECTION its node sits relative to the anchor NODE (#3367) — open one to the left of the anchor and
  // its terminal opens to the left — so the grid reads as a spatial projection of the graph. Idempotent:
  // clicking an already-open node is a no-op, not a second cell.
  const openChat = (id: string) => {
    const node = model.nodes.find((n) => n.id === id);
    if (!node) return;
    setGridAnchorId((prev) => prev ?? id);
    setPlacements((prev) => {
      // `gridAnchorId` still holds the PRE-click value during this handler, so `?? id` covers the very
      // first open (where this node becomes the anchor and takes cell 0,0).
      const anchor = model.nodes.find((n) => n.id === (gridAnchorId ?? id));
      if (!anchor) return prev;
      return placeByDirection(prev, id, { dx: node.x - anchor.x, dy: node.y - anchor.y });
    });
  };
  /** Collapse ONE morph. Its PTY stays alive — the agent is untouched. Frees its cell for a later open;
   *  the surviving morphs keep theirs, and the anchor is retained so the grid never shifts under them —
   *  until the LAST one closes, which releases the anchor so the next session re-anchors on its own node
   *  rather than inheriting a stale grid origin from a node that is no longer open (#3365). */
  const closeChat = (id: string) => setPlacements((prev) => {
    const next = releaseCell(prev, id);
    if (next.length === 0) setGridAnchorId(null);
    return next;
  });
  /** Close everything — the only path that releases the grid anchor, so the next session re-anchors. */
  const closeAllChats = () => { setPlacements([]); setGridAnchorId(null); };
  const exitDrill = () => { setDrill(null); setSel(null); setShowCycle(false); closeAllChats(); setPreviewOpen(false); };
  // Kill ONE live pane (#3049): terminate its PTY (mirrors the console's disable path) and disable the
  // cell so the node drops out of the live set + its stale "run" clears. fleetStartProject re-enables the
  // cell on relaunch, so the teardown is self-reversing — "Relaunch fleet" (#3044) respawns it.
  const killPane = (pid: string) => {
    void safeInvoke("pty_kill", { paneId: pid }, undefined);
    setPaneDisabled(pid, true);
    setPaneStatus(pid, "idle");
  };
  // END a single agent's session from its morph (#3049): tear it down + collapse the morph.
  const endSession = (nodeId: string, pid: string) => { killPane(pid); closeChat(nodeId); };
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
    closeAllChats();   // every morph's agent is gone (#3361)
  };

  // ── Resume (#glance-resume) ──────────────────────────────────────────────────────────────────
  // Scoped to a drilled REAL (plan.db) project. The base-studio-code studio project (#3319) has no
  // plan.db fleet — its sessions are app-managed (the debugger toggle, the always-on Studio team) — so
  // it doesn't take a fleet-resume; its live nodes still open via the graph morph as before.
  const canResume = !!drill && drill !== BASE_STUDIO_PROJECT_ID;
  // The project's display title (for the recreated "· build" tab name); falls back to the graph slug.
  // Cosmetic — the build tab is matched/reused by the stable key.
  const projectDisplayName = (key: string) =>
    projects.find((p) => p.id === key)?.name ?? projectModel.nodes.find((n) => n.id === key)?.slug ?? key;
  // Navigate to a pane's live Console cell by its identity id (mirrors WorkerDetail.openSession). Reads
  // tabs fresh (getState) so a just-launched build tab is found.
  const jumpToConsolePane = (paneId: string) => {
    const owner = findPaneOwnerTab(useAppStore.getState().tabs, paneId);
    setWorkspace("console");
    if (owner) {
      setActiveTab(owner.tabIdx);
      const pi = owner.tab.paneIds?.indexOf(paneId) ?? -1;
      if (pi >= 0) setFocusedPane(pi);
    }
  };
  // Header Resume: bring the drilled project's whole fleet back. If a build tab is already LIVE, jump to
  // it instead of rebuilding (rebuilding would restart running agents); otherwise run the progress-gated
  // relaunch, which reopens the build tab and switches to the Console.
  const onResumeProject = async () => {
    if (!canResume || !drill || resuming) return;
    setResumeMsg(null);
    // #3923: only navigate when there is genuinely NOTHING to start. This used to bail on the FIRST
    // live pane, which made Resume permanently inert once a single node had been resumed on its own —
    // the "turn them all back on" button just switched screens. Its stated reason ("rebuilding would
    // restart running agents") does not hold: `pty_create` RECONNECTS to an existing session and
    // returns before spawning, so a live pane's remount never re-sends `claude --continue`.
    const idx = findFleetTabIdx(drill);
    if (idx >= 0) {
      const paneIds = useAppStore.getState().tabs[idx]?.paneIds ?? [];
      // Every pane already live ⇒ nothing to resume; jump to it. A pane that is live OR quarantined is
      // not startable here (quarantine is surfaced, not relaunched, #3916), so a fleet made entirely of
      // those two is "nothing to do" too.
      if (nothingToResume(paneIds, livePaneIds, quarantinedPanes)) { setWorkspace("console"); setActiveTab(idx); return; }
    }
    setResuming(true);
    try {
      const res = await resumeProjectFleet({ projectName: projectDisplayName(drill), projectKey: drill, fleet: effectiveFleet });
      // #3916: SHOW the sessions that couldn't resume rather than quietly skipping them — select the
      // first blocked node so the inspector opens on it (its overlay already carries the reason), and
      // name the rest in the status line. The user decides what to do; resume never decides for them.
      const blocked = res.blocked ?? [];
      if (blocked.length > 0) pickNode(blocked[0].streamId);
      const blockedMsg = blocked.length > 0
        ? `${blocked.length} session${blocked.length === 1 ? "" : "s"} not resumed — `
          + blocked.map((b) => `${b.streamId}: ${b.reason}`).join("; ")
        : null;
      // #3931: streams HELD by the dependency gate are reported but NOT opened as errors — nothing is
      // wrong with them, it simply isn't their turn. They launch on their own once their upstream lands,
      // so naming them (and the first few ids) is the whole surface a resume owes the user.
      const held = res.held ?? [];
      const heldMsg = held.length > 0
        ? `${held.length} held by dependencies — ${held.slice(0, 3).map((h) => h.streamId).join(", ")}`
          + (held.length > 3 ? ` +${held.length - 3} more` : "")
        : null;
      const okMsg = [res.note, blockedMsg, heldMsg].filter(Boolean).join(" · ") || null;
      setResumeMsg(res.ok ? okMsg : (res.error ?? "Couldn't resume this project."));
    } finally {
      setResuming(false);
    }
  };
  // Node Resume: jump to a live agent's Console pane; for a dormant agent, resume just that pane in place
  // when its build tab is still open, else bring the whole fleet back and land on it.
  const onResumeNode = (nodeId: string) => {
    if (!drill) return;
    // base-studio-code studio node (#3319/#glance-resume): open its app-owned session at its HOME. These
    // sessions have STABLE ids, so revealing them re-uses the running session (or mounts it if it isn't
    // up) — we never start a second one. Since #3357 every studio session is TerminalHost-hosted, so they
    // all open inline in the graph morph; the `page` branch remains for a future non-morphable node.
    if (drill === BASE_STUDIO_PROJECT_ID) {
      const home = studioNodeHome(nodeId);
      if (!home) return;                                   // a library/resource node — no session to open
      if (home.kind === "morph") openChat(nodeId);
      else navigate({ workspace: "projects", page: home.pageMode });
      return;
    }
    if (!canResume) return;
    const paneId = fleetPaneId(drill, nodeId);
    // #3998: `livePaneIds` is TAB MEMBERSHIP (a session cell exists), not "an agent is running" — see
    // `glanceFleet.ts`. Jumping was therefore the whole of Resume for any pane still in its tab, which
    // is every pane whose agent had quietly exited to a `$` prompt. Nothing remounts such a pane
    // either (TerminalView is portal-hosted by paneId), so this is the only place that can revive it.
    // Fire-and-forget: the probe decides whether anything is needed, and navigation shouldn't wait.
    if (livePaneIds.has(paneId)) { void ensureClaudeRunning([paneId]); jumpToConsolePane(paneId); return; }
    setResumeMsg(null);
    if (resumePaneSession(paneId)) { jumpToConsolePane(paneId); return; }
    setResuming(true);
    void resumeProjectFleet({ projectName: projectDisplayName(drill), projectKey: drill, fleet: effectiveFleet })
      .then((res) => {
        if (!res.ok) setResumeMsg(res.error ?? "Couldn't resume this agent.");
        else jumpToConsolePane(paneId);
      })
      .finally(() => setResuming(false));
  };

  // The open morphs, DERIVED (never stored) — a morph shows only while its node is still a live agent in
  // the CURRENT fleet, so drilling out (or a nav-history back/forward that swaps `drill`) closes them all
  // by derivation, with no reset effect. #3361 keeps that property PER MORPH: the filter that used to
  // guard one `chatPaneId` now guards each entry, so one agent going away drops just its morph.
  //
  // Each entry carries its SLOT — the grid box it grows into, derived from the anchor node's live coords
  // and the shared cell size. Because slots are discrete, two morphs can never overlap.
  const anchorNode = gridAnchorId ? model.nodes.find((n) => n.id === gridAnchorId) ?? null : null;
  const openChats = placements.flatMap(({ nodeId, col, row }) => {
    if (!drill || !anchorNode || !isLiveAgent(nodeId)) return [];
    const paneId = studioPaneId(nodeId) ?? fleetPaneId(drill, nodeId);
    const node = model.nodes.find((n) => n.id === nodeId);
    if (!paneId || !node) return [];
    return [{ nodeId, paneId, name: node.slug, role: node.roleLabel, slot: cellRect(anchorNode, { col, row }, cell) }];
  });
  // END one morph's session (#3049). Ending an APP-OWNED session drops its declaration rather than
  // killing a fleet cell:
  //  • DEBUG (#3326) — turn the Settings toggle OFF, which unmounts DebugSessionMount → clean PTY
  //    teardown → the node disappears.
  //  • a STUDIO (#3357) — drop it from `wantedStudios`, which unmounts its persistent claim; the
  //    `pty_kill` is still explicit, because a studio PAGE dock may hold another claim (End means end,
  //    not "end unless the Design Studio page happens to be mounted").
  // Fleet nodes end their one PTY as before. Scoped to the ONE morph — its siblings stay open (#3361).
  const endChat = (nodeId: string) => {
    const open = openChats.find((o) => o.nodeId === nodeId);
    if (!open) return;
    if (open.paneId === DEBUG_PANE_ID) { setDebugSession(false); closeChat(nodeId); }
    else if (isStudioId(nodeId)) {
      // NOT killPane: that also sets the PERSISTED `disabledPanes` flag, which is a fleet-cell concept
      // (fleetStartProject re-enables it). A studio has no cell to re-enable.
      closeStudio(nodeId);
      void safeInvoke("pty_kill", { paneId: open.paneId }, undefined);
      setPaneStatus(open.paneId, "idle");
      closeChat(nodeId);
    }
    else endSession(nodeId, open.paneId);
  };

  // The preview morph shows only while the drill still HAS a preview node — drilling out / to an incomplete
  // project closes it by derivation. `source` is null until the verify-build produces one (#2623 slice 3).
  const previewOn = previewOpen && !!drill && model.nodes.some((n) => n.preview);

  // On opening a live agent's terminal (#2534): bring it into view and ensure a readable zoom, so the
  // in-graph terminal lands legible (option A: it scales with the graph). centerOn is the
  // least-disruptive focus (keeps the current zoom); we only bump zoom up when the graph is small.
  //
  // #3361: centre on the SLOT the morph grew into, not the node — with a grid the two diverge from the
  // second morph on, and it is the panel the user needs to see. Keyed on the open COUNT so it fires once
  // per open (any count) and never on a re-render; the zoom bump stays first-open-only, so adding a
  // fourth morph can't yank the zoom out from under the user.
  const openCount = openChats.length;
  useEffect(() => {
    const newest = openChats[openChats.length - 1];
    if (!newest) return;
    if (openCount === 1 && vp.view.scale < 0.85) vp.zoomTo(1);
    vp.centerOn(newest.slot.left + newest.slot.w / 2, newest.slot.top + newest.slot.h / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openCount]);

  // Auto-clear the transient resume status line so a one-off note/error doesn't linger (#glance-resume).
  useEffect(() => {
    if (!resumeMsg) return;
    const id = setTimeout(() => setResumeMsg(null), 6000);
    return () => clearTimeout(id);
  }, [resumeMsg]);

  const q = search.trim().toLowerCase();
  const sidebar = model.nodes.slice().sort((a, b) => a.layer - b.layer || a.slug.localeCompare(b.slug)).filter((n) => !q || n.slug.toLowerCase().includes(q));
  // An un-drilled project network with no projects yet. We ALWAYS render the (empty) graph now (#3033) —
  // never a blocking empty-state page — and instead surface a one-click "Load demo" in the toolbar so the
  // #2272 demo stays reachable. (Create a project in the Projects workspace via the Rail as usual.)
  // Emptiness is measured on the user's REAL projects (`projectsBase`), not on the graph's node count:
  // since #3319 the always-on base-studio-code studio node is appended to `projects`, so the graph is
  // never node-empty and the demo affordance had become unreachable dead UI (#3411).
  const networkEmpty = !drill && projectsBase.length === 0;

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
      {page === "fleet" ? <FleetGraphHost /> : (
      // The graph must FILL the screen body (a pan/zoom canvas, not scrolling content); the shared
      // .screen-body is a block scroll container, so give it an explicit full-height flex column.
      <Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
    <GraphCanvas
      profileId="glance"
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
              breadcrumb went the same way: the titlebar crumb already names the drilled project, so the
              toolbar keeps only the '← projects' button that exits the drill. */}
          {drill && <Button variant="ghost" onClick={exitDrill}>← projects</Button>}
          {/* The project filter moved into the rail's search slot (#2797) — every graph nav menu now leads
              with a search box. Manual connect-mode was removed (#2737): links are LLM-authored, not drawn
              by hand. The graph is configured by the planner/agents, never wired manually here. */}
          <Box style={{ flex: 1 }} />
          {drill
            ? (data.sample
                ? <Chip color="var(--graph-health-warning)">sample fleet · no plan.db fleet</Chip>
                : <Chip color="var(--graph-health-healthy)">real fleet · {model.nodes.length} agents</Chip>)
            : (data.sample && <Chip color="var(--graph-health-warning)">sample topology · preview</Chip>)}
          {/* Project-level bulk kill (#3052): end EVERY live session for the drilled project at once —
              the fast recovery when a whole fleet is soft-locked. Shown only when it has live sessions. */}
          {drill && liveProjectPanes.length > 0 && (
            <Button variant="ghost" danger onClick={endAllSessions}
              title="End every live agent session for this project — Relaunch fleet restarts them">
              End {liveProjectPanes.length} session{liveProjectPanes.length === 1 ? "" : "s"}
            </Button>
          )}
          {/* Project Resume (#glance-resume): bring the drilled project's fleet back to life (or jump to it
              if already live). Drilled REAL projects only — the studio project has no plan.db fleet. */}
          {canResume && (
            <Button variant="primary" onClick={onResumeProject} disabled={resuming}
              title={`Resume ${drillNode?.slug ?? "project"}'s fleet`}>
              {resuming ? "Resuming…" : "▶ Resume"}
            </Button>
          )}
          {resumeMsg && <Text as="span" mono size={10.5} tone="dim" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={resumeMsg}>{resumeMsg}</Text>}
          {model.cyclePairs.length > 0 && (
            <Box as="button" onClick={() => { setShowCycle((v) => !v); setSel(null); }}
              style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderRadius: 7, padding: "6px 11px",
                background: showCycle ? "rgba(242,85,95,.18)" : "rgba(242,85,95,.08)", border: `1px solid ${showCycle ? "rgba(242,85,95,.55)" : "rgba(242,85,95,.3)"}` }}>
              <Text as="span" style={{ color: "var(--graph-health-error)" }}>▲</Text>
              <Text as="span" mono size={11} weight={600} style={{ color: "var(--cycle)" }}>{model.cyclePairs.length} cycle</Text>
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
                <Text as="span" mono size={11} style={{ letterSpacing: "1px", color: "var(--cycle)" }}>COORDINATION HAZARDS</Text>
              </Row>
              {model.cyclePairs.map(([a, b]) => (
                <Box key={a + b} onClick={() => { setShowCycle(true); setSel(null); }}
                  style={{ background: "rgba(242,85,95,.08)", border: "1px solid rgba(242,85,95,.28)", borderRadius: 7, padding: "9px 11px", cursor: "pointer", marginBottom: 6 }}>
                  <Text as="div" mono size={11} style={{ color: "var(--cycle-soft)", marginBottom: 3 }}>dependency cycle</Text>
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
        // The per-node OFF toggle (#3239) — only on the L0 project network (a drilled fleet node has none).
        offOn={!drill && sel.type === "node" ? !!glanceOff[sel.id] : undefined}
        onToggleOff={!drill && sel.type === "node" ? (off) => setGlanceNodeOff(sel.id, off) : undefined}
        // Open the real PTY stream (#2369) — only for a drilled, LIVE agent node.
        onOpenStream={sel.type === "node" && isLiveAgent(sel.id) ? openChat : undefined}
        // Resume this node's session (#glance-resume). A drilled REAL fleet node jumps to its Console pane
        // when live, else relaunches that one agent. A base-studio-code STUDIO node opens its app-owned
        // session at its home (re-using the running one) — offered for the nodes that HAVE a session.
        onResumeNode={sel.type === "node" && sel.id !== PREVIEW_NODE_ID
          && (canResume || (drill === BASE_STUDIO_PROJECT_ID && !!studioNodeHome(sel.id)))
          ? onResumeNode : undefined}
        nodeLive={sel.type === "node" ? nodeActive(sel.id) : undefined} /> : undefined}
    >
      {/* keyed so drilling in/out remounts + replays the shared transition (graphCanvas.css, #2418) */}
      <Box key={drill ?? "network"} className="graph-drill-anim" style={{ position: "absolute", inset: 0 }}>
        <GlanceCanvas
          model={model} dragMoved={vp.dragMoved} zoom={vp.view.scale}
          focus={focus} selNodeId={selNodeId} selEdgeId={selEdgeId}
          onHoverNode={setHoverNode} onHoverEdge={setHoverEdge} onSelectNode={onNodeClick} onSelectEdge={pickEdge}
          // Every open live-agent terminal, each morphed into its grid slot (#2534 → MULTI, #3361).
          chats={openChats}
          onCloseChat={closeChat}
          onEndChat={endChat}
          // A resize on ANY morph drives the grid's shared cell, so they all resize together.
          onResizeCell={(w, h) => setCell(clampCell(w, h))}
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
