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
import { Screen } from "@/app/chrome/Screen";
import { type TabItem } from "@/app/chrome/TabBar";
import { usePageTabs } from "@/shared/hooks/usePageTabs";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { Fleet } from "@/features/planner/fleet/Fleet";
import { GlanceCanvas, GlanceOverlays } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, focusSets, STATUS_META, ROLE_COLOR } from "./lib/glanceGraph";
import { buildGlanceData, type ProjectLite } from "./lib/glanceData";
import { buildFleetData, buildRealFleetData } from "./lib/glanceFleet";
import "./glance.css";

const GLANCE_TABS: TabItem[] = [
  { id: "network", label: "Network", hint: "projects · dependencies" },
  { id: "fleet", label: "Fleet", hint: "agents · throughput" },
];

export function GlanceWorkspace({ pageOverride }: { pageOverride?: string } = {}) {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const planFleet = useAppStore((s) => s.planFleet);
  const personas = useAppStore((s) => s.personas);
  const projects: ProjectLite[] = useMemo(
    () => Object.entries(drafts).map(([id, d]) => ({ id, name: d.title })),
    [drafts],
  );
  // L0 — the project-network graph.
  const projectData = useMemo(() => buildGlanceData(projects), [projects]);
  const projectModel = useMemo(() => buildGraph(projectData.rawNodes, projectData.rawEdges), [projectData]);

  const { tabs, activeId, select, reorder, tearOff } = usePageTabs("glance", GLANCE_TABS);
  const page = pageOverride ?? activeId;

  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [showCycle, setShowCycle] = useState(false);
  const [search, setSearch] = useState("");
  // Drill (#…): clicking a project on the Network graph animates INTO that project's fleet-relationship
  // graph — the SAME canvas, a different graph (L0 project network → L1 agent fleet). `drill` is the
  // drilled project node id; the fleet graph is SAMPLE until a real per-project fleet feed lands.
  const [drill, setDrill] = useState<string | null>(null);

  const drillNode = drill ? projectModel.nodes.find((n) => n.id === drill) ?? null : null;
  // The drilled project's REAL fleet (plan.db is keyed by project id, so the node id resolves it); falls
  // back to a sample fleet when a project has no planned fleet yet (e.g. the sample project topology).
  const realFleet = drill ? planFleet[drill] : undefined;
  const fleetData = useMemo(() => {
    if (!drillNode) return null;
    if (realFleet && realFleet.streams.length > 0) return buildRealFleetData(realFleet, personas);
    return buildFleetData({ id: drillNode.id, name: drillNode.slug });
  }, [drillNode, realFleet, personas]);
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
  const focus = focusSets(model, hoverNode ?? selNodeId, hoverEdge ?? selEdgeId, showCycle);

  const pickNode = (id: string) => { setSel({ type: "node", id }); setShowCycle(false); };
  const pickEdge = (id: string) => { setSel({ type: "edge", id }); setShowCycle(false); };
  // On the L0 network a node CLICK drills into that project's fleet; inside a fleet it selects an agent.
  const onNodeClick = (id: string) => { if (drill) pickNode(id); else { setDrill(id); setSel(null); setShowCycle(false); } };
  const exitDrill = () => { setDrill(null); setSel(null); setShowCycle(false); };

  const q = search.trim().toLowerCase();
  const sidebar = model.nodes.slice().sort((a, b) => a.layer - b.layer || a.slug.localeCompare(b.slug)).filter((n) => !q || n.slug.toLowerCase().includes(q));

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
    <GraphCanvas
      vp={vp}
      world={{ w: model.worldW, h: model.worldH }}
      canvasBackground="radial-gradient(120% 120% at 30% 0%, var(--bg-elev) 0%, var(--bg) 100%)"
      overlays={<GlanceOverlays />}
      railResizable railWidth={266} railMin={200} railMax={420}
      inspectorResizable inspectorWidth={340} inspectorMin={280} inspectorMax={520}
      toolbar={
        <>
          <Row gap={9} align="baseline">
            <Box style={{ width: 9, height: 9, borderRadius: "50%", background: "#4fd6a0", boxShadow: "0 0 10px #4fd6a0", alignSelf: "center" }} />
            <Text as="span" mono size={16} weight={700} style={{ letterSpacing: "-.5px" }}>glance</Text>
            <Text as="span" mono size={11} tone="dim">{drill ? `${drillNode?.slug ?? "project"} · fleet` : "project network"}</Text>
          </Row>
          {drill && <Button variant="ghost" onClick={exitDrill}>← projects</Button>}
          {/* eslint-disable-next-line no-restricted-syntax -- compact search input; a full Field is overkill in the toolbar */}
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter projects…" className="input"
            style={{ width: 280, fontFamily: "var(--mono)", fontSize: 12, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 7, padding: "7px 11px" }} />
          <Box style={{ flex: 1 }} />
          {data.sample && <Chip color="var(--warn, #f2b155)">{drill ? "sample fleet · preview" : "sample topology · preview"}</Chip>}
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
      inspector={sel ? <GlanceInspector model={model} selType={sel.type} selId={sel.id} onSelectNode={pickNode} onClose={() => setSel(null)} /> : undefined}
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
