// Glance workspace (#2206, epic #2205) — the workspace-level project-network map: every project a node,
// dependencies as edges, cross-project CYCLES surfaced as coordination hazards. Toolbar (search · cycle
// pill · zoom/fit) · sidebar (projects + hazards) · transform graph canvas · project/contract inspector.
// Nodes are the user's REAL projects; the topology (roles/edges/status) is clearly-marked SAMPLE until a
// real cross-project dependency model lands (epic slice 4). Clicking a project will drill to its live
// agent network (L2, later slice) — for now it opens the inspector.
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Button } from "@/shared/ui/controls/Button";
import { GlanceCanvas } from "./GlanceCanvas";
import { GlanceInspector } from "./GlanceInspector";
import { buildGraph, focusSets, STATUS_META, ROLE_COLOR } from "./lib/glanceGraph";
import { buildGlanceData, type ProjectLite } from "./lib/glanceData";
import { useGraphViewport } from "./lib/useGraphViewport";
import "./glance.css";

export function GlanceWorkspace() {
  const drafts = useAppStore((s) => s.localDraftProjects);
  const projects: ProjectLite[] = useMemo(
    () => Object.entries(drafts).map(([id, d]) => ({ id, name: d.title })),
    [drafts],
  );
  const data = useMemo(() => buildGlanceData(projects), [projects]);
  const model = useMemo(() => buildGraph(data.rawNodes, data.rawEdges), [data]);

  const [sel, setSel] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [showCycle, setShowCycle] = useState(false);
  const [search, setSearch] = useState("");

  const vp = useGraphViewport({ w: model.worldW, h: model.worldH });
  // Fit whenever the graph changes (project list / first mount).
  useEffect(() => { const id = requestAnimationFrame(() => vp.fit()); return () => cancelAnimationFrame(id); }, [model, vp]);

  const selNodeId = sel?.type === "node" ? sel.id : null;
  const selEdgeId = sel?.type === "edge" ? sel.id : null;
  const focus = focusSets(model, hoverNode ?? selNodeId, hoverEdge ?? selEdgeId, showCycle);

  const pickNode = (id: string) => { setSel({ type: "node", id }); setShowCycle(false); };
  const pickEdge = (id: string) => { setSel({ type: "edge", id }); setShowCycle(false); };

  const q = search.trim().toLowerCase();
  const sidebar = model.nodes.slice().sort((a, b) => a.layer - b.layer || a.slug.localeCompare(b.slug)).filter((n) => !q || n.slug.toLowerCase().includes(q));

  return (
    <Stack gap={0} style={{ flex: 1, minHeight: 0 }}>
      {/* ── toolbar ── */}
      <Row gap={18} align="center" style={{ height: 54, flex: "none", padding: "0 18px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border)" }}>
        <Row gap={9} align="baseline">
          <Box style={{ width: 9, height: 9, borderRadius: "50%", background: "#4fd6a0", boxShadow: "0 0 10px #4fd6a0", alignSelf: "center" }} />
          <Text as="span" mono size={16} weight={700} style={{ letterSpacing: "-.5px" }}>glance</Text>
          <Text as="span" mono size={11} tone="dim">project network</Text>
        </Row>
        {/* eslint-disable-next-line no-restricted-syntax -- compact search input; a full Field is overkill in the toolbar */}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Filter projects…" className="input"
          style={{ width: 280, fontFamily: "var(--mono)", fontSize: 12, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 7, padding: "7px 11px" }} />
        <Box style={{ flex: 1 }} />
        {data.sample && <Chip color="var(--warn, #f2b155)">sample topology · preview</Chip>}
        {model.cyclePairs.length > 0 && (
          <Box as="button" onClick={() => { setShowCycle((v) => !v); setSel(null); }}
            style={{ display: "flex", alignItems: "center", gap: 7, cursor: "pointer", borderRadius: 7, padding: "6px 11px",
              background: showCycle ? "rgba(242,85,95,.18)" : "rgba(242,85,95,.08)", border: `1px solid ${showCycle ? "rgba(242,85,95,.55)" : "rgba(242,85,95,.3)"}` }}>
            <Text as="span" style={{ color: "#f2555f" }}>▲</Text>
            <Text as="span" mono size={11} weight={600} style={{ color: "#f2848b" }}>{model.cyclePairs.length} cycle</Text>
          </Box>
        )}
        <Row align="center" style={{ background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
          <IconButton aria-label="zoom out" onClick={() => vp.zoomBy(1 / 1.2)}>−</IconButton>
          <Text as="span" mono size={11} tone="muted" style={{ width: 42, textAlign: "center" }}>{Math.round(vp.view.scale * 100)}%</Text>
          <IconButton aria-label="zoom in" onClick={() => vp.zoomBy(1.2)}>+</IconButton>
        </Row>
        <Button variant="ghost" onClick={vp.fit}>fit</Button>
      </Row>

      {/* ── body ── */}
      <Row gap={0} align="stretch" style={{ flex: 1, minHeight: 0 }}>
        {/* sidebar */}
        <Stack gap={0} style={{ width: 266, minWidth: 266, background: "var(--bg-elev)", borderRight: "1px solid var(--border)", minHeight: 0 }}>
          <Row align="baseline" justify="between" style={{ padding: "14px 16px 10px" }}>
            <Text as="span" mono size={11} tone="dim" style={{ letterSpacing: "1.5px" }}>PROJECTS</Text>
            <Text as="span" mono size={11} tone="dim">{model.nodes.length}</Text>
          </Row>
          <Box style={{ flex: 1, overflowY: "auto", padding: "0 8px 8px" }}>
            {sidebar.map((n) => {
              const st = STATUS_META[n.status];
              const on = selNodeId === n.id || hoverNode === n.id;
              return (
                <Row key={n.id} gap={9} align="center" onClick={() => pickNode(n.id)} onMouseEnter={() => setHoverNode(n.id)} onMouseLeave={() => setHoverNode(null)}
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

        {/* canvas + inspector */}
        <GlanceCanvas
          model={model} worldTransform={vp.worldTransform} setVp={vp.setVp} onCanvasDown={vp.onCanvasDown} dragMoved={vp.dragMoved}
          focus={focus} selNodeId={selNodeId} selEdgeId={selEdgeId}
          onHoverNode={setHoverNode} onHoverEdge={setHoverEdge} onSelectNode={pickNode} onSelectEdge={pickEdge}
        />
        <GlanceInspector model={model} selType={sel?.type ?? null} selId={sel?.id ?? null} onSelectNode={pickNode} onClose={() => setSel(null)} />
      </Row>
    </Stack>
  );
}
