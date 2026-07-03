// Org designer (#2193, interactive #2199) — the persona-relationship graph, mounted as the Org tab of
// the Planner workspace. Toolbar (org switch · relationship palette · auto-organize/fit/zoom) · left
// rail (positions by department) · canvas (pan/zoom/node-drag) · inspector (position identity /
// relationship). Driven by the real org/persona/skill stores; pure model + geometry live in lib/*.
// The pan/zoom shell is the shared GraphCanvas template + useGraphViewport (#2208, epic #2197 slice 2).
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { OrgCanvas, OrgLegend, type Selection } from "./OrgCanvas";
import { OrgInspector } from "./OrgInspector";
import { RELATIONSHIP_ARCHETYPES } from "./lib/org";
import { autoLayout, CANVAS_W, CANVAS_H } from "./lib/orgLayout";
import { positionDisplay, hueColor } from "./lib/orgView";

/** Department display order in the left rail (positionDisplay assigns each a dept). */
const DEPT_ORDER = ["Leadership", "Engineering", "Quality", "Support", "Team", "Resource", "External"];

export function OrgPanel() {
  const orgs = useAppStore((s) => s.orgs);
  const personas = useAppStore((s) => s.personas);
  const addOrg = useAppStore((s) => s.addOrg);
  const updateOrg = useAppStore((s) => s.updateOrg);
  const addRelationship = useAppStore((s) => s.addRelationship);
  const updateRelationship = useAppStore((s) => s.updateRelationship);
  const addPosition = useAppStore((s) => s.addPosition);
  const updatePosition = useAppStore((s) => s.updatePosition);
  const setOrgZoom = useAppStore((s) => s.setOrgZoom);

  const [orgId, setOrgId] = useState<string>(orgs[0]?.id ?? "");
  const org = orgs.find((o) => o.id === orgId) ?? orgs[0];
  const savedZoom = useAppStore((s) => s.orgZoom[orgId]);
  const [sel, setSel] = useState<Selection>({ type: "node", id: org?.positions[0]?.nodeId ?? "" });
  // Click-to-connect: a chosen archetype + the pending source node; two node clicks make an edge.
  const [connect, setConnect] = useState<{ archetype: string; from: string | null } | null>(null);

  const vp = useGraphViewport({ w: CANVAS_W, h: CANVAS_H }, { min: 0.4, max: 1.5, fitPad: 20, maxFitScale: 1.5 });
  const scale = vp.view.scale;

  // Restore this org's saved zoom (or fit) when the org changes.
  useEffect(() => {
    if (savedZoom) vp.zoomTo(savedZoom);
    else vp.fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);

  // Persist zoom, debounced so a wheel-zoom gesture doesn't spam the store.
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => setOrgZoom(orgId, scale), 400);
    return () => clearTimeout(saveTimer.current);
  }, [scale, orgId, setOrgZoom]);

  if (!org) {
    return (
      <Stack align="center" justify="center" style={{ flex: 1 }}>
        <Text tone="dim">No org yet.</Text>
        <Button onClick={() => setOrgId(addOrg())}>+ new org</Button>
      </Stack>
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

  const autoOrganize = () => {
    const layout = autoLayout(org);
    updateOrg(org.id, { positions: org.positions.map((p) => ({ ...p, ...layout[p.nodeId] })) });
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

  return (
    <GraphCanvas
      vp={vp}
      world={{ w: CANVAS_W, h: CANVAS_H }}
      overlays={<OrgLegend />}
      toolbar={
        <>
          <Row gap={9} align="center">
            <Box style={{ width: 22, height: 22, borderRadius: 6, background: "var(--bg-soft)", border: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "var(--accent)" }}>◆</Box>
            {orgs.length > 1 ? (
              // eslint-disable-next-line no-restricted-syntax -- compact inline org switch; a full Field is overkill in the toolbar
              <select value={org.id} onChange={(e) => { setOrgId(e.target.value); setSel({ type: "node", id: orgs.find((o) => o.id === e.target.value)!.positions[0]?.nodeId ?? "" }); }}
                className="input" style={{ fontWeight: 600, fontSize: 14, background: "transparent", border: "none", cursor: "pointer", padding: "2px 4px" }}>
                {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : (
              <Text as="span" weight={600} size={14}>{org.name}</Text>
            )}
            <Text as="span" mono size={10.5} tone="dim">org · {org.positions.length} positions</Text>
          </Row>
          <Box style={{ width: 1, height: 22, background: "var(--border)" }} />
          <Row gap={10} align="center" style={{ minWidth: 0 }}>
            <Text as="span" className="ulabel" tone="dim" size={9.5} style={{ flex: "none" }}>{connect ? (connect.from ? "pick a target" : "pick a source") : "Click to connect"}</Text>
            <Row gap={6}>
              {RELATIONSHIP_ARCHETYPES.map((a) => (
                <Box as="button" key={a.id} onClick={() => setConnect(connect?.archetype === a.id ? null : { archetype: a.id, from: null })}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 500,
                    color: "var(--fg-muted)", background: connect?.archetype === a.id ? "color-mix(in oklch, var(--accent) 16%, transparent)" : "var(--bg-soft)",
                    border: `1px solid ${connect?.archetype === a.id ? "var(--accent)" : "var(--border)"}`, padding: "3px 9px 3px 7px", borderRadius: 999, cursor: "pointer", whiteSpace: "nowrap" }}>
                  <Box style={{ width: 8, height: 8, borderRadius: "50%", background: hueColor(a.hue), flex: "none" }} />{a.label}
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
        <Stack gap={0} style={{ width: 260, minWidth: 260, borderRight: "1px solid var(--border-soft)", background: "var(--bg-elev)", minHeight: 0 }}>
          <Row align="center" justify="between" style={{ padding: "13px 15px 11px", borderBottom: "1px solid var(--border-soft)" }}>
            <Text as="span" className="ulabel" tone="dim" size={9.5}>Positions</Text>
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
                      <Box style={{ width: 20, height: 20, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "var(--accent)", background: "var(--bg-soft)", flex: "none" }}>{d.glyph}</Box>
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
      inspector={
        <OrgInspector
          org={org} orgs={orgs} personas={personas} sel={sel}
          onSelectNode={(id) => setSel({ type: "node", id })}
          onChangeArchetype={(relId, a) => updateRelationship(org.id, relId, { archetype: a })}
          onChangePersona={(nodeId, personaId) => updatePosition(org.id, nodeId, { personaId })}
          onChangeLabel={(nodeId, label) => updatePosition(org.id, nodeId, { label })}
        />
      }
    >
      <OrgCanvas
        org={org} personas={personas} sel={sel} scale={scale} gridOn connecting={!!connect}
        dragMoved={vp.dragMoved}
        onSelectNode={onSelectNode} onSelectEdge={(id) => setSel({ type: "edge", id })}
        onMoveNode={(nodeId, x, y) => updatePosition(org.id, nodeId, { x, y })}
      />
    </GraphCanvas>
  );
}
