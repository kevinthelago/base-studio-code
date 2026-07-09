// Team designer (#2193, interactive #2199) — the persona-relationship graph, mounted as the Team tab of
// the Planner workspace. Navigation is IN the graph (#2742): the TOP level is a Teams overview (every
// team a clickable card, the rail lists the teams); clicking a card enters that team's position graph;
// a breadcrumb (Teams › team) climbs back up. The old header org-switcher dropdown is gone. The team is
// AI-configured now (#2750): the user inspects + deletes, but no longer creates teams/positions or wires
// relationships by hand (no create buttons, no click-to-connect palette). Per team: toolbar (breadcrumb ·
// auto-organize/fit/zoom) · left rail (positions by department, or teams at the top level) · canvas
// (pan/zoom/node-drag) · inspector (position identity / relationship). Driven by the real org/persona/
// skill stores; pure model + geometry live in lib/*.
// The pan/zoom shell is the shared GraphCanvas template + useGraphViewport (#2208, epic #2197 slice 2).
import departmentsEmbedded from "@data/teams/departments.json";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { IconBox } from "@/shared/ui/data/IconBox";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { TeamsCanvas, OrgLegend, type Selection } from "./TeamsCanvas";
import { TeamsOverview } from "./TeamsOverview";
import { TeamsInspector } from "./TeamsInspector";
import { TeamsContextMenu } from "./TeamsContextMenu";
import { type Position } from "./lib/team";
import { autoLayout, nodeBox, contentBounds, CANVAS_W, CANVAS_H, type Box as GBox } from "./lib/orgLayout";
import { teamsBounds } from "./lib/teamsLayout";
import { detectPools, collapseOrg, poolLayoutSizes, applyPoolLayout } from "./lib/orgPools";
import { positionDisplay } from "./lib/orgView";
import { overlayFile } from "@/shared/lib/core/configOverrides";

/** Department display order in the left rail (positionDisplay assigns each a dept) — from
 *  `@data/teams/departments.json` (#2419, beside the teams vocabulary); config-dir-overlaid (#2047). */
const DEPT_ORDER: string[] = overlayFile("teams/departments.json", departmentsEmbedded);

export function TeamsPanel() {
  const orgs = useAppStore((s) => s.teams);
  const personas = useAppStore((s) => s.personas);
  const updateOrg = useAppStore((s) => s.updateOrg);
  const updateRelationship = useAppStore((s) => s.updateRelationship);
  const updatePosition = useAppStore((s) => s.updatePosition);
  const removePosition = useAppStore((s) => s.removePosition);
  const removeRelationship = useAppStore((s) => s.removeRelationship);
  const setOrgZoom = useAppStore((s) => s.setTeamsZoom);

  // The ENTERED team (#2742) — null = the top-level Teams overview, where the graph shows every team as
  // a card and the user drills IN by clicking one (no header dropdown). `atTeams` also catches a stale
  // id whose team was deleted, so we never render a missing team.
  const [orgId, setOrgId] = useState<string | null>(null);
  const org = orgId ? orgs.find((o) => o.id === orgId) : undefined;
  const savedZoom = useAppStore((s) => s.teamsZoom[orgId ?? ""]);
  // Open with nothing selected (the empty sentinel — inspector empty, no dimming; see onBackgroundClick).
  const [sel, setSel] = useState<Selection>({ type: "node", id: "" });
  // Right-click context menu (#2385): the cursor position + the target it was opened on.
  const [menu, setMenu] = useState<{ x: number; y: number; target: Selection } | null>(null);

  // The nodes of the collapsed graph — computed on demand for framing. fit + the saved-zoom restore
  // center on THESE, not the fixed 1120×800 canvas, so the graph opens centered instead of parked high
  // / clipped at the top (#2673). Mirrors `view` below. (The pool-member drill was dropped, #2750.)
  const framedPositions = (): Position[] => {
    if (!org) return [];
    return collapseOrg(org, detectPools(org, personas)).org.positions;
  };
  // What the viewport fits/centers on — the team cards at the top level (#2742), else the framed
  // positions of the entered team (mirrors `atTeams`/`view` below, read fresh each fit).
  const framedBounds = (): GBox | null =>
    !org ? teamsBounds(orgs.length + 1) : contentBounds(framedPositions());

  const vp = useGraphViewport(
    { w: CANVAS_W, h: CANVAS_H },
    { min: 0.4, max: 1.5, fitPad: 20, maxFitScale: 1.5, contentBounds: framedBounds },
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

  // Persist zoom, debounced so a wheel-zoom gesture doesn't spam the store.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setOrgZoom(orgId ?? "", scale), 400);
    return () => clearTimeout(saveTimer.current);
  }, [scale, orgId, setOrgZoom]);

  // Enter a team's position graph (a card / rail click); `toTeams` climbs back to the overview.
  const enterTeam = (id: string) => { setOrgId(id); setSel({ type: "node", id: "" }); };
  const toTeams = () => { setOrgId(null); setSel({ type: "node", id: "" }); };

  // No teams at all → the first-run empty state. Teams are configured by the AI (the planner), not
  // created by the user (#2750), so there is no create action here — just the explanatory message.
  if (orgs.length === 0) {
    return (
      <EmptyState
        icon="◆" iconVariant="dashed"
        title="No team yet"
        description="A team wires personas into positions and relationships — the planner configures one as it plans your project."
      />
    );
  }

  // ── TOP LEVEL (#2742): the Teams overview — every team is a card you click to enter; the left rail
  // lists the teams. This replaced the header org-switcher dropdown. `!org` also covers a stale/deleted
  // id, and narrows `org` to a real Team for the per-team code below.
  if (!org) {
    return (
      <GraphCanvas
        vp={vp}
        world={{ w: CANVAS_W, h: CANVAS_H }}
        grid
        railResizable railWidth={260} railMin={200} railMax={420}
        toolbar={
          <>
            <Row gap={9} align="center">
              <IconBox size={22} radius={6} fontSize={12} background="var(--bg-soft)" border="1px solid var(--border)" color="var(--accent)">◆</IconBox>
              <Text as="span" weight={600} size={14}>Teams</Text>
              <Text as="span" mono size={10.5} tone="dim">{orgs.length} team{orgs.length === 1 ? "" : "s"} · click one to open</Text>
            </Row>
            <Box style={{ flex: 1 }} />
            <Button variant="ghost" onClick={vp.fit}>Fit</Button>
            <ZoomControls vp={vp} />
          </>
        }
        rail={
          <Stack gap={0} style={{ flex: 1, minWidth: 0, borderRight: "1px solid var(--border-soft)", background: "var(--bg-elev)", minHeight: 0 }}>
            <Row align="center" justify="between" style={{ padding: "13px 15px 11px", borderBottom: "1px solid var(--border-soft)" }}>
              <SectionLabel size={9.5}>Teams</SectionLabel>
            </Row>
            <Box style={{ overflowY: "auto", padding: "8px 8px 20px", flex: 1 }}>
              {orgs.map((o) => (
                <Row key={o.id} gap={9} align="center" className="teams-railrow" onClick={() => enterTeam(o.id)}
                  style={{ padding: "8px 9px", borderRadius: 8, cursor: "pointer" }}>
                  <IconBox size={20} radius={6} fontSize={11} color="var(--accent)" background="var(--bg-soft)">◆</IconBox>
                  <Text as="span" size={12.5} weight={500} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.name}</Text>
                  <Text as="span" mono size={9} tone="dim">{o.positions.length}</Text>
                </Row>
              ))}
            </Box>
          </Stack>
        }
      >
        <Box className="graph-drill-anim" style={{ position: "absolute", inset: 0 }}>
          <TeamsOverview teams={orgs} personas={personas} onEnter={enterTeam} />
        </Box>
      </GraphCanvas>
    );
  }

  // Selecting a node just focuses it — the click-to-connect relationship builder was removed (#2750;
  // the AI configures teams, the user only inspects/deletes).
  const onSelectNode = (nodeId: string) => setSel({ type: "node", id: nodeId });

  // Pools (#2199): homogeneous swarms of a `pooled` persona collapse to one stacked card. The canvas
  // shows the COLLAPSED parent graph (the pool-member drill was dropped, #2750 — a swarm is already
  // fully represented by its ×N stacked card).
  const pools = detectPools(org, personas);
  const collapsed = collapseOrg(org, pools);
  const view = collapsed;

  // Auto-organize lays out the graph being RENDERED (#2451): the COLLAPSED org, so the pool node
  // participates (with its stacked-card footprint) and lands ON a hierarchy row; the result writes back
  // through applyPoolLayout — non-pooled nodes directly, each pool's members translated as a cluster so
  // their centroid (where the stack renders) is the pool's laid-out spot (#2439).
  const autoOrganize = () => {
    const layout = autoLayout(collapsed.org, poolLayoutSizes(pools));
    updateOrg(org.id, { positions: applyPoolLayout(org, pools, layout) });
  };

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
          {/* Breadcrumb (#2742) — Teams › ‹team›; the Teams crumb climbs back to the overview (replaces
              the header org-switcher dropdown, which is gone; teams are entered from the graph now).
              The pool crumb was dropped with the pool-member drill (#2750). */}
          <Row gap={7} align="center">
            <IconBox size={22} radius={6} fontSize={12} background="var(--bg-soft)" border="1px solid var(--border)" color="var(--accent)">◆</IconBox>
            <Button variant="ghost" onClick={toTeams}>Teams</Button>
            <Text as="span" tone="dim">›</Text>
            <Text as="span" weight={600} size={14}>{org.name}</Text>
            <Text as="span" mono size={10.5} tone="dim" style={{ marginLeft: 2 }}>{org.positions.length} positions · {pools.length} pool{pools.length === 1 ? "" : "s"}</Text>
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
        <TeamsInspector
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
      {/* keyed to the team so entering/leaving replays the shared transition (graphCanvas.css, #2418) */}
      <Box key={org.id} className="graph-drill-anim" style={{ position: "absolute", inset: 0 }}>
        <TeamsCanvas
          org={view.org} personas={personas} sel={sel} scale={scale} connecting={false}
          dragMoved={vp.dragMoved} poolInfo={view.poolInfo}
          onSelectNode={onSelectNode} onSelectEdge={(id) => setSel({ type: "edge", id })}
          onMoveNode={(nodeId, x, y) => updatePosition(org.id, nodeId, { x, y })}
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
      <TeamsContextMenu
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
