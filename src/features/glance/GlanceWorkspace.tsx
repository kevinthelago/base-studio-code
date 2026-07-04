// Glance workspace (#2206, epic #2205) — the workspace-level mission control. A tabbed Screen (#2223):
// NETWORK (the project-network map: every project a node, dependencies as edges, cross-project CYCLES as
// coordination hazards) paired with FLEET (the live orchestration analytics for the active project's
// fleet). Network toolbar (search · cycle pill · zoom/fit) · sidebar (projects + hazards) · transform
// graph canvas · project/contract inspector. Nodes are the user's REAL projects; the topology is
// clearly-marked SAMPLE until a real cross-project dependency model lands (epic slice 4). Clicking a
// project will drill to its live agent network (L2, later slice) — for now it opens the inspector. The
// pan/zoom shell is the shared GraphCanvas template + useGraphViewport (#2208, epic #2197 slice 2).
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Screen } from "@/app/chrome/Screen";
import { type TabItem } from "@/app/chrome/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { Fleet } from "@/features/planner/fleet/Fleet";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, focusSets, STATUS_META, ROLE_COLOR, EDGE_META, type GEdgeKind } from "./lib/glanceGraph";
import { buildGlanceData } from "./lib/glanceData";
import { buildFleetData, buildRealFleetData } from "./lib/glanceFleet";
import { useGlanceProjects } from "./lib/useGlanceProjects";
import { useProjectFleet } from "./lib/useProjectFleet";
import "./glance.css";

const GLANCE_TABS: TabItem[] = [
  { id: "network", label: "Network", hint: "projects · dependencies" },
  { id: "fleet", label: "Fleet", hint: "agents · throughput" },
];

export function GlanceWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const planFleet = useAppStore((s) => s.planFleet);
  const personas = useAppStore((s) => s.personas);
  // The REAL project set: published GitHub projects merged with local drafts (keyed by the plan key so the
  // drill resolves each project's fleet). A "planning" status marks a planned project; "live" (app running)
  // is the detection follow-up.
  const projects = useGlanceProjects();
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const projectLinks = useAppStore((s) => s.projectLinks);
  const addProjectLink = useAppStore((s) => s.addProjectLink);
  const removeProjectLink = useAppStore((s) => s.removeProjectLink);
  // L0 — the project-network graph (nodes = real projects, edges = the user-drawn relationships #2253).
  const projectData = useMemo(() => buildGlanceData(projects, projectLinks), [projects, projectLinks]);
  const projectModel = useMemo(() => buildGraph(projectData.rawNodes, projectData.rawEdges), [projectData]);

  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("glance", GLANCE_TABS);
  const page = pageOverride ?? activeId;

  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [showCycle, setShowCycle] = useState(false);
  const [search, setSearch] = useState("");
  // Connect-mode (#2253): a chosen edge kind + the pending source project; two node clicks draw a link.
  const [connect, setConnect] = useState<{ kind: GEdgeKind; from: string | null } | null>(null);
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
  const fleetData = useMemo(() => {
    if (!drillNode) return null;
    if (effectiveFleet && effectiveFleet.streams.length > 0) return buildRealFleetData(effectiveFleet, personas);
    return buildFleetData({ id: drillNode.id, name: drillNode.slug });
  }, [drillNode, effectiveFleet, personas]);
  const fleetModel = useMemo(() => (fleetData ? buildGraph(fleetData.rawNodes, fleetData.rawEdges) : null), [fleetData]);
  // The ACTIVE graph — the drilled fleet, else the project network. Everything downstream (canvas,
  // sidebar, focus, cycles, viewport) reads these, so the whole page swaps its graph on drill.
  const data = fleetData ?? projectData;
  const model = fleetModel ?? projectModel;

  const vp = useGraphViewport({ w: model.worldW, h: model.worldH });
  // Fit when the graph changes (a drill in/out swaps `model`) OR the Network page (re)mounts. `fit` is a
  // stable callback, so this doesn't re-fit every render (the earlier `[model, vp]` dep did).
  const { fit } = vp;
  useEffect(() => {
    if (page !== "network") return;
    const id = requestAnimationFrame(() => fit());
    return () => cancelAnimationFrame(id);
  }, [model, fit, page]);

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
  // On the L0 network: connect-mode wires two projects; otherwise a click drills into the fleet. Inside a
  // fleet a click selects an agent.
  const onNodeClick = (id: string) => {
    if (!drill && connect) {
      if (!connect.from) { setConnect({ ...connect, from: id }); return; }
      if (connect.from !== id) addProjectLink(connect.from, id, connect.kind);
      setConnect(null);
      return;
    }
    if (drill) pickNode(id); else { setDrill(id); setSel(null); setShowCycle(false); }
  };
  const exitDrill = () => { setDrill(null); setSel(null); setShowCycle(false); };

  const q = search.trim().toLowerCase();
  const sidebar = model.nodes.slice().sort((a, b) => a.layer - b.layer || a.slug.localeCompare(b.slug)).filter((n) => !q || n.slug.toLowerCase().includes(q));
  // A brand-new / unseeded app has no projects → show a REAL empty state instead of the old mock graph
  // (#2272). Only on the (un-drilled) project network — you can't drill without projects.
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
      {page === "fleet" ? <Fleet /> : networkEmpty ? (
      <Box style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
        <EmptyState
          icon="◍" iconVariant="dashed"
          title="No project network yet"
          description="Projects you create show up here as a network you can wire together — dependencies, contracts, and cross-project cycles. Create one in Projects, or load a demo from Settings → General → Demo app-state to see it come alive."
          actions={<Button onClick={() => setWorkspace("projects")}>Go to Projects</Button>}
        />
      </Box>
      ) : (
      // The graph must FILL the screen body (a pan/zoom canvas, not scrolling content); the shared
      // .screen-body is a block scroll container, so give it an explicit full-height flex column.
      <Box style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
    <GraphCanvas
      vp={vp}
      world={{ w: model.worldW, h: model.worldH }}
      canvasBackground="radial-gradient(120% 120% at 30% 0%, var(--bg-elev) 0%, var(--bg) 100%)"
      overlays={<GlanceOverlays />}
      railResizable railWidth={266} railMin={200} railMax={420}
      inspectorResizable inspectorWidth={340} inspectorMin={280} inspectorMax={520}
      // Click the empty canvas → clear the selection + any cycle highlight (#2232).
      onBackgroundClick={() => { setSel(null); setShowCycle(false); }}
      toolbar={
        <>
          <Row gap={9} align="baseline">
            <Text as="span" mono size={16} weight={700} style={{ letterSpacing: "-.5px" }}>glance</Text>
            <Text as="span" mono size={11} tone="dim">{drill ? `${drillNode?.slug ?? "project"} · fleet` : "project network"}</Text>
          </Row>
          {drill && <Button variant="ghost" onClick={exitDrill}>← projects</Button>}
          {/* eslint-disable-next-line no-restricted-syntax -- compact search input; a full Field is overkill in the toolbar */}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter projects…" className="input"
            style={{ width: 240, fontFamily: "var(--mono)", fontSize: 12, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 7, padding: "7px 11px" }} />
          {/* connect-mode palette (#2253) — pick a kind, then click source → target to draw a project link */}
          {!drill && (
            <Row gap={8} align="center" style={{ minWidth: 0 }}>
              <Text as="span" className="ulabel" tone="dim" size={9.5} style={{ flex: "none" }}>{connect ? (connect.from ? "pick a target" : "pick a source") : "connect"}</Text>
              <Row gap={6}>
                {(["api", "data", "events"] as GEdgeKind[]).map((k) => (
                  <Box as="button" key={k} onClick={() => setConnect(connect?.kind === k ? null : { kind: k, from: null })}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 500,
                      color: "var(--fg-muted)", background: connect?.kind === k ? "color-mix(in oklch, var(--accent) 16%, transparent)" : "var(--bg-soft)",
                      border: `1px solid ${connect?.kind === k ? "var(--accent)" : "var(--border)"}`, padding: "3px 9px 3px 7px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap" }}>
                    <Box style={{ width: 8, height: 8, borderRadius: "50%", background: EDGE_META[k].color, flex: "none" }} />{EDGE_META[k].label}
                  </Box>
                ))}
              </Row>
            </Row>
          )}
          <Box style={{ flex: 1 }} />
          {drill
            ? (data.sample
                ? <Chip color="var(--warn, #f2b155)">sample fleet · no plan.db fleet</Chip>
                : <Chip color="#4fd6a0">real fleet · {model.nodes.length} agents</Chip>)
            : (data.sample && <Chip color="var(--warn, #f2b155)">sample topology · preview</Chip>)}
          {model.cyclePairs.length > 0 && (
            <Box as="button" onClick={() => { setShowCycle((v) => !v); setSel(null); }}
              style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderRadius: 7, padding: "6px 11px",
                background: showCycle ? "rgba(242,85,95,.18)" : "rgba(242,85,95,.08)", border: `1px solid ${showCycle ? "rgba(242,85,95,.55)" : "rgba(242,85,95,.3)"}` }}>
              <Text as="span" style={{ color: "#f2555f" }}>▲</Text>
              <Text as="span" mono size={11} weight={600} style={{ color: "#f2848b" }}>{model.cyclePairs.length} cycle</Text>
            </Box>
          )}
          <ZoomControls vp={vp} step={1.2} />
          <Button variant="ghost" onClick={vp.fit}>fit</Button>
        </>
      }
      rail={
        <Stack gap={0} style={{ flex: 1, minWidth: 0, background: "var(--bg-elev)", borderRight: "1px solid var(--border)", minHeight: 0 }}>
          <Row align="baseline" justify="between" style={{ padding: "14px 16px 10px" }}>
            <Text as="span" mono size={11} tone="dim" style={{ letterSpacing: "1.5px" }}>{drill ? "AGENTS" : "PROJECTS"}</Text>
            <Text as="span" mono size={11} tone="dim">{model.nodes.length}</Text>
          </Row>
          <Box style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
            {sidebar.map((n) => {
              const st = STATUS_META[n.status];
              const on = selNodeId === n.id || hoverNode === n.id;
              return (
                <Row key={n.id} gap={9} align="center" onClick={() => onNodeClick(n.id)} onMouseEnter={() => setHoverNode(n.id)} onMouseLeave={() => setHoverNode(null)}
                  style={{ padding: "8px 9px", borderRadius: 7, cursor: "pointer", background: on ? "var(--bg-soft)" : "transparent", border: `1px solid ${on ? "var(--border)" : "transparent"}` }}>
                  <Box style={{ width: 7, height: 7, borderRadius: "50%", background: st.color, flex: "none", boxShadow: st.pulse ? `0 0 7px ${st.color}` : "none" }} />
                  <Text as="span" mono size={12} style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
                  <Box style={{ width: 8, height: 3, borderRadius: 2, background: ROLE_COLOR[n.role], flex: "none" }} />
                </Row>
              );
            })}
          </Box>
          {model.cyclePairs.length > 0 && (
            <Box style={{ borderTop: "1px solid var(--border)", padding: "12px 16px" }}>
              <Row gap={7} align="center" style={{ marginBottom: 9 }}>
                <Text as="span" style={{ color: "#f2555f" }}>▲</Text>
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
          )}
        </Stack>
      }
      inspector={sel ? <GlanceInspector model={model} selType={sel.type} selId={sel.id} onSelectNode={pickNode} onClose={() => setSel(null)}
        onRemoveEdge={!drill && !data.sample ? removeProjectLink : undefined} /> : undefined}
    >
      {/* keyed so drilling in/out remounts + replays the transition animation (glance.css) */}
      <Box key={drill ?? "network"} className="glance-drill-anim" style={{ position: "absolute", inset: 0 }}>
        <GlanceCanvas
          model={model} dragMoved={vp.dragMoved}
          focus={focus} selNodeId={selNodeId} selEdgeId={selEdgeId}
          onHoverNode={setHoverNode} onHoverEdge={setHoverEdge} onSelectNode={onNodeClick} onSelectEdge={pickEdge}
        />
      </Box>
    </GraphCanvas>
      </Box>
      )}
    </Screen>
  );
}
