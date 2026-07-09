// Org designer (#2193, interactive #2199) — the persona-relationship graph, mounted as the Org tab of
// the Planner workspace. Toolbar (org switch · relationship palette · auto-organize/fit/zoom) · left
// rail (positions by department) · canvas (pan/zoom/node-drag) · inspector (position identity /
// relationship). Driven by the real org/persona/skill stores; pure model + geometry live in lib/*.
// The pan/zoom shell is the shared GraphCanvas template + useGraphViewport (#2208, epic #2197 slice 2).
import departmentsEmbedded from "@data/org/departments.json";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { Dropdown } from "@/shared/ui/controls/Dropdown";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { IconBox } from "@/shared/ui/data/IconBox";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { OrgCanvas, OrgLegend, type Selection } from "./OrgCanvas";
import { OrgInspector } from "./OrgInspector";
import { OrgContextMenu } from "./OrgContextMenu";
import { RELATIONSHIP_ARCHETYPES, type Position } from "./lib/org";
import { autoLayout, nodeBox, contentBounds, CANVAS_W, CANVAS_H } from "./lib/orgLayout";
import { detectPools, collapseOrg, poolSubgraph, poolLayoutSizes, applyPoolLayout, organizeDrilledPool, type Pool } from "./lib/orgPools";
import { positionDisplay, hueColor } from "./lib/orgView";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** Department display order in the left rail (positionDisplay assigns each a dept) — from
 *  `@data/org/departments.json` (#2419, beside the org vocabulary); config-dir-overlaid (#2047). */
const DEPT_ORDER: string[] = overlayFile("org/departments.json", departmentsEmbedded);

export function OrgPanel() {
  const orgs = useAppStore((s) => s.orgs);
  const personas = useAppStore((s) => s.personas);
  const addOrg = useAppStore((s) => s.addOrg);
  const updateOrg = useAppStore((s) => s.updateOrg);
  const addRelationship = useAppStore((s) => s.addRelationship);
  const updateRelationship = useAppStore((s) => s.updateRelationship);
  const addPosition = useAppStore((s) => s.addPosition);
  const updatePosition = useAppStore((s) => s.updatePosition);
  const removePosition = useAppStore((s) => s.removePosition);
  const removeRelationship = useAppStore((s) => s.removeRelationship);
  const setOrgZoom = useAppStore((s) => s.setOrgZoom);

  const [orgId, setOrgId] = useState<string>(orgs[0]?.id ?? "");
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const savedZoom = useAppStore((s) => s.orgZoom[orgId]);
  // Open with nothing selected (the empty sentinel — inspector empty, no dimming; see onBackgroundClick).
  const [sel, setSel] = useState<Selection>({ type: "node", id: "" });
  // Right-click context menu (#2385): the cursor position + the target it was opened on.
  const [menu, setMenu] = useState<{ x: number; y: number; target: Selection } | null>(null);
  // Click-to-connect: a chosen archetype + the pending source node; two node clicks make an edge.
  const [connect, setConnect] = useState<{ archetype: string; from: string | null } | null>(null);
  // Drill state: the pool nodeId whose OWN graph is showing (null = the collapsed parent graph),
  // held in the STORE (#2492) so the app-wide nav history (mouse back/forward,
  // useNavHistory) can step drill in/out — same treatment as glanceDrill.
  const drill = useAppStore((s) => s.orgDrill);
  const setDrill = useAppStore((s) => s.setOrgDrill);

  // The nodes of whatever view is showing (the collapsed graph, or a drilled pool's members) — computed
  // on demand for framing. fit + the saved-zoom restore center on THESE, not the fixed 1120×800 canvas,
  // so the graph opens centered instead of parked high / clipped at the top (#2673). Mirrors `view` below.
  const framedPositions = (): Position[] => {
    if (!org) return [];
    const pls = detectPools(org, personas);
    const active = drill ? pls.find((p) => p.nodeId === drill) ?? null : null;
    return active ? poolSubgraph(org, active).positions : collapseOrg(org, pls).org.positions;
  };

  const vp = useGraphViewport(
    { w: CANVAS_W, h: CANVAS_H },
    { min: 0.4, max: 1.5, fitPad: 20, maxFitScale: 1.5, contentBounds: () => contentBounds(framedPositions()) },
  );
  const scale = vp.view.scale;

  // Restore this org's saved zoom (or fit) when the org changes. zoomToCentered (NOT zoomTo) re-centers
  // the world at the saved scale — zoomTo anchors about the viewport center starting from the fresh
  // mount's {0,0,1} origin, which leaves the world hanging off the bottom of the viewport (#2545).
  useEffect(() => {
    if (savedZoom) vp.zoomToCentered(savedZoom);
    else vp.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Re-fit when drilling into / out of a pool (skip the very first run so it doesn't clobber the
  // org-change zoom restore above).
  const drilledOnce = useRef(false);
  useEffect(() => {
    if (!drilledOnce.current) { drilledOnce.current = true; return; }
    vp.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill]);

  // Persist zoom, debounced so a wheel-zoom gesture doesn't spam the store.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setOrgZoom(orgId, scale), 400);
    return () => clearTimeout(saveTimer.current);
  }, [scale, orgId, setOrgZoom]);

  if (!org) {
    return (
      <EmptyState
        icon="◆" iconVariant="dashed"
        title="No team yet"
        description="A team wires personas into positions and relationships — create one to start designing."
        actions={<Button onClick={() => setOrgId(addOrg())}>+ new team</Button>}
      />
    );
  }

  const onSelectNode = (nodeId: string) => {
    if (connect) {
      if (!connect.from) { setConnect({ ...connect, from: nodeId }); return; }
      if (connect.from !== nodeId) {
        const id = `rel-${connect.from}-${nodeId}-${connect.archetype}`;
        if (!org.relationships.some((r) => r.id === id)) {
          addRelationship(org.id, { id, archetype: connect.archetype, from: connect.from, to: nodeId });
        }
        setSel({ type: "edge", id });
      }
      setConnect(null);
      return;
    }
    setSel({ type: "node", id: nodeId });
  };

  const addNode = () => {
    const nodeId = `pos-${Date.now().toString(36)}`;
    // Drop the new node into clear space below the current graph so it never lands on top of another;
    // the user can then wire it up and hit "Auto organize" to let the layout re-settle everything.
    const maxY = org.positions.reduce((m, p) => Math.max(m, p.y ?? 0), 0);
    const x = 60 + (org.positions.length % 4) * 220;
    const y = org.positions.length ? maxY + 150 : 48;
    addPosition(org.id, { nodeId, kind: "agent", personaId: personas[0]?.id, x, y });
    setSel({ type: "node", id: nodeId });
  };

  // Pools (#2199): homogeneous swarms of a `pooled` persona collapse to one stacked card. The canvas
  // shows either the COLLAPSED parent graph, or — when a pool is open — that pool's OWN sub-graph.
  const pools = detectPools(org, personas);
  const activePool: Pool | null = drill ? pools.find((p) => p.nodeId === drill) ?? null : null;
  const collapsed = collapseOrg(org, pools);
  const view = activePool
    ? { org: poolSubgraph(org, activePool), poolInfo: {} as Record<string, Pool> }
    : collapsed;
  const activePoolName = activePool ? positionDisplay({ nodeId: activePool.nodeId, kind: "agent", personaId: activePool.personaId }, personas).name : "";

  // Auto-organize lays out the graph being RENDERED (#2451). Parent view → the COLLAPSED org, so the
  // pool node participates (with its stacked-card footprint) and lands ON a hierarchy row; the result
  // writes back through applyPoolLayout — non-pooled nodes directly, each pool's members translated as
  // a cluster so their centroid (where the stack renders) is the pool's laid-out spot (#2439). Drilled
  // into a pool → only the members re-arrange; the boundary context stays fixed.
  const autoOrganize = () => {
    if (activePool) {
      updateOrg(org.id, { positions: organizeDrilledPool(org, activePool) });
      return;
    }
    const layout = autoLayout(collapsed.org, poolLayoutSizes(pools));
    updateOrg(org.id, { positions: applyPoolLayout(org, pools, layout) });
  };

  const onDrillPool = (poolNodeId: string) => { setDrill(poolNodeId); setSel({ type: "node", id: "" }); };
  const exitPool = () => { setDrill(null); setSel({ type: "node", id: "" }); };

  // Left rail: positions grouped by department, in canonical order.
  const byDept = new Map<string, typeof org.positions>();
  for (const p of org.positions) {
    const dept = positionDisplay(p, personas).dept;
    (byDept.get(dept) ?? byDept.set(dept, []).get(dept)!).push(p);
  }
  const depts = [...byDept.keys()].sort((a, b) => {
    const ia = DEPT_ORDER.indexOf(a), ib = DEPT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  // Nothing is selected while `sel.id` is the empty sentinel — the inspector column is HIDDEN then
  // (don't render an empty panel), and it appears only once a node/edge is actually selected.
  const hasSel = sel.id !== "";

  return (
    <>
    <GraphCanvas
      vp={vp}
      world={{ w: CANVAS_W, h: CANVAS_H }}
      overlays={<OrgLegend />}
      grid
      railResizable railWidth={260} railMin={200} railMax={420}
      inspectorResizable inspectorWidth={344} inspectorMin={280} inspectorMax={560}
      // Click the empty canvas → clear the selection (the empty sentinel; inspector empties, no dimming).
      onBackgroundClick={() => setSel({ type: "node", id: "" })}
      toolbar={
        <>
          <Row gap={9} align="center">
            <IconBox size={22} radius={6} fontSize={12} background="var(--bg-soft)" border="1px solid var(--border)" color="var(--accent)">◆</IconBox>
            {orgs.length > 1 ? (
              <Dropdown
                aria-label="Switch org"
                variant="ghost"
                size="md"
                value={org.id}
                onChange={(id) => { setOrgId(id); setDrill(null); setSel({ type: "node", id: "" }); }}
                options={orgs.map((o) => ({ value: o.id, label: o.name }))}
              />
            ) : (
              <Text as="span" weight={600} size={14}>{org.name}</Text>
            )}
            {activePool ? (
              <>
                <Text as="span" tone="dim" style={{ margin: "0 1px" }}>▸</Text>
                <Text as="span" mono size={11} weight={600}>{activePoolName} pool · ×{activePool.count}</Text>
                <Button variant="ghost" onClick={exitPool}>← back</Button>
              </>
            ) : (
              <Text as="span" mono size={10.5} tone="dim">team · {org.positions.length} positions · {pools.length} pool{pools.length === 1 ? "" : "s"}</Text>
            )}
          </Row>
          <Box style={{ width: 1, height: 22, background: "var(--border)" }} />
          <Row gap={10} align="center" style={{ minWidth: 0 }}>
            <SectionLabel size={9.5} style={{ flex: "none" }}>{connect ? (connect.from ? "pick a target" : "pick a source") : "Click to connect"}</SectionLabel>
            <Row gap={6}>
              {RELATIONSHIP_ARCHETYPES.map((a) => (
                <Box as="button" key={a.id} onClick={() => setConnect(connect?.archetype === a.id ? null : { archetype: a.id, from: null })}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 500,
                    color: "var(--fg-muted)", background: connect?.archetype === a.id ? "color-mix(in oklch, var(--accent) 16%, transparent)" : "var(--bg-soft)",
                    border: `1px solid ${connect?.archetype === a.id ? "var(--accent)" : "var(--border)"}`, padding: "3px 9px 3px 7px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap" }}>
                  <StatusDot color={hueColor(a.hue)} size={8} />{a.label}
                </Box>
              ))}
            </Row>
          </Row>
          <Box style={{ flex: 1 }} />
          <Button variant="ghost" onClick={autoOrganize}>⤢ Auto organize</Button>
          <Button variant="ghost" onClick={vp.fit}>Fit</Button>
          <ZoomControls vp={vp} />
        </>
      }
      rail={
        <Stack gap={0} style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--border-soft)", background: "var(--bg-elev)", minHeight: 0 }}>
          <Row align="center" justify="between" style={{ padding: "13px 15px 11px", borderBottom: "1px solid var(--border-soft)" }}>
            <SectionLabel size={9.5}>Positions</SectionLabel>
            <Button variant="ghost" onClick={addNode}>＋ new</Button>
          </Row>
          <Box style={{ overflowY: "auto", padding: "8px 8px 20px", flex: 1 }}>
            {depts.map((dept) => (
              <Box key={dept}>
                <Text as="div" size={9} tone="dim" style={{ margin: "10px 6px 5px", letterSpacing: ".11em", textTransform: "uppercase", fontWeight: 600 }}>{dept}</Text>
                {byDept.get(dept)!.map((p) => {
                  const d = positionDisplay(p, personas);
                  const on = sel.type === "node" && sel.id === p.nodeId;
                  return (
                    <Row key={p.nodeId} gap={9} align="center" onClick={() => onSelectNode(p.nodeId)}
                      style={{ padding: "7px 9px", borderRadius: 8, cursor: "pointer",
                        background: on ? "color-mix(in oklch, var(--accent) 10%, transparent)" : "transparent",
                        border: `1px solid ${on ? "var(--accent)" : "transparent"}` }}>
                      <IconBox size={20} radius={6} fontSize={11} color="var(--accent)" background="var(--bg-soft)">{d.glyph}</IconBox>
                      <Text as="span" size={12.5} weight={500} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</Text>
                      {d.role && <Text as="span" mono size={9} tone="dim" style={{ textTransform: "uppercase" }}>{d.role}</Text>}
                    </Row>
                  );
                })}
              </Box>
            ))}
          </Box>
        </Stack>
      }
      inspector={hasSel ? (
        <OrgInspector
          org={org} orgs={orgs} personas={personas} sel={sel}
          onSelectNode={(id) => setSel({ type: "node", id })}
          onChangeArchetype={(relId, a) => updateRelationship(org.id, relId, { archetype: a })}
          onChangePersona={(nodeId, personaId) => updatePosition(org.id, nodeId, { personaId })}
          onChangeLabel={(nodeId, label) => updatePosition(org.id, nodeId, { label })}
          onDeletePosition={(nodeId) => { removePosition(org.id, nodeId); setSel({ type: "node", id: "" }); }}
          onDeleteRelationship={(relId) => { removeRelationship(org.id, relId); setSel({ type: "node", id: "" }); }}
        />
      ) : undefined}
    >
      {/* keyed so drilling in/out remounts + replays the shared transition (graphCanvas.css, #2418) */}
      <Box key={drill ?? "__root__"} className="graph-drill-anim" style={{ position: "absolute", inset: 0 }}>
        <OrgCanvas
          org={view.org} personas={personas} sel={sel} scale={scale} connecting={!!connect}
          dragMoved={vp.dragMoved} poolInfo={view.poolInfo}
          onSelectNode={onSelectNode} onSelectEdge={(id) => setSel({ type: "edge", id })}
          onMoveNode={(nodeId, x, y) => updatePosition(org.id, nodeId, { x, y })}
          onDrillPool={onDrillPool}
          onMovePool={(poolNodeId, dx, dy) => {
            // The pool node is synthetic (rendered at its members' centroid) — commit a stack drag by
            // shifting EVERY member by the delta, so the centroid lands at the drop point and the
            // drill-in keeps its relative arrangement (#2439). nodeBox supplies the same default
            // position the canvas rendered, so members without a stored x/y shift from where they SHOW.
            const members = collapsed.poolInfo[poolNodeId]?.memberNodeIds ?? [];
            for (const m of members) {
              const pos = org.positions.find((p) => p.nodeId === m);
              if (!pos) continue;
              const b = nodeBox(pos);
              updatePosition(org.id, m, { x: b.x + dx, y: b.y + dy });
            }
          }}
          onContext={(target, e) => { setSel(target); setMenu({ x: e.clientX, y: e.clientY, target }); }}
        />
      </Box>
    </GraphCanvas>
    {menu && (
      <OrgContextMenu
        x={menu.x} y={menu.y}
        deleteLabel={menu.target.type === "node" ? "Delete position" : "Delete relationship"}
        onDelete={() => {
          if (menu.target.type === "node") removePosition(org.id, menu.target.id);
          else removeRelationship(org.id, menu.target.id);
          setSel({ type: "node", id: "" });
        }}
        onClose={() => setMenu(null)}
      />
    )}
    </>
  );
}
