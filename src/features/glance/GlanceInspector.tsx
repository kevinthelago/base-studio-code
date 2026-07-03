// Glance inspector (#2206) — the right dock, in one of two modes. PROJECT (node): status · role · cycle
// warning · depends-on / depended-on-by (clickable) · a drill-to-agents affordance (the L2 agent
// network lands in a later slice) · open project. CONTRACT (edge): kind · cycle warning ·
// consumer→provider · strength · surface · description. Read-only view over the graph model.
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { ROLE_COLOR, STATUS_META, EDGE_META, type GraphModel, type GNode } from "./lib/glanceGraph";

// Fills its (drag-resizable) wrapper column in GraphCanvas — the width is owned by the layout, not here.
const PANEL: React.CSSProperties = { flex: 1, minWidth: 0, background: "var(--bg-elev)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 15 };
const CARD: React.CSSProperties = { flex: 1, background: "var(--bg-soft)", border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px" };
const LABEL = (t: string) => <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: "1px", margin: "20px 0 9px" }}>{t}</Text>;
const CYCLE_BG = "rgba(242,85,95,.08)", CYCLE_BD = "rgba(242,85,95,.28)";

interface InspectorProps {
  model: GraphModel;
  selType: "node" | "edge" | null;
  selId: string | null;
  onSelectNode: (id: string) => void;
  onClose: () => void;
}

function DepRow({ node, kind, color, onClick }: { node: GNode; kind: string; color: string; onClick: () => void }) {
  return (
    <Row gap={9} align="center" onClick={onClick} style={{ padding: "8px 10px", borderRadius: 7, cursor: "pointer", background: "var(--bg)", border: "1px solid var(--border)", marginBottom: 5 }}>
      <Box style={{ width: 8, height: 8, borderRadius: "50%", background: ROLE_COLOR[node.role], flex: "none" }} />
      <Text as="span" mono size={12} style={{ flex: 1 }}>{node.slug}</Text>
      <Text as="span" mono size={9.5} style={{ textTransform: "uppercase", letterSpacing: ".5px", color }}>{kind}</Text>
    </Row>
  );
}

function Header({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <Row align="center" justify="between" style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
      <Text as="span" mono size={10.5} tone="dim" style={{ letterSpacing: "1.5px" }}>{title}</Text>
      <IconButton aria-label="close inspector" onClick={onClose}>×</IconButton>
    </Row>
  );
}

export function GlanceInspector({ model, selType, selId, onSelectNode, onClose }: InspectorProps) {
  if (selType === "node" && selId) {
    const n = model.nodes.find((x) => x.id === selId);
    if (!n) return null;
    const st = STATUS_META[n.status];
    const deps = model.edges.filter((e) => e.from === n.id);
    const rdeps = model.edges.filter((e) => e.to === n.id);
    const inCycle = model.cycleNodeIds.has(n.id);
    const kindOf = (k: string, isCycle: boolean) => (isCycle ? "cycle" : EDGE_META[k as keyof typeof EDGE_META].label.split(" ")[0]);
    const colorOf = (k: string, isCycle: boolean) => (isCycle ? "#f2555f" : EDGE_META[k as keyof typeof EDGE_META].color);

    return (
      <Box style={PANEL}>
        <Header title="PROJECT" onClose={onClose} />
        <Box style={{ flex: 1, overflowY: "auto", padding: "18px 16px" }}>
          <Text as="div" mono size={19} weight={700} style={{ letterSpacing: "-.4px" }}>{n.slug}</Text>

          <Row gap={8} style={{ marginTop: 16 }}>
            <Box style={CARD}>
              <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>STATUS</Text>
              <Row gap={7} align="center">
                <Box style={{ width: 9, height: 9, borderRadius: "50%", background: st.color, boxShadow: st.pulse ? `0 0 8px ${st.color}` : "none" }} />
                <Text as="span" mono size={12.5} weight={500} style={{ color: st.color }}>{st.label}</Text>
              </Row>
            </Box>
            <Box style={CARD}>
              <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>ROLE</Text>
              <Text as="span" mono size={11} style={{ color: ROLE_COLOR[n.role], background: `color-mix(in oklch, ${ROLE_COLOR[n.role]} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${ROLE_COLOR[n.role]} 30%, transparent)`, borderRadius: 5, padding: "3px 8px" }}>{n.role}</Text>
            </Box>
          </Row>

          {inCycle && (
            <Row gap={9} align="start" style={{ marginTop: 14, background: CYCLE_BG, border: `1px solid ${CYCLE_BD}`, borderRadius: 8, padding: "10px 12px" }}>
              <Text as="span" style={{ color: "#f2555f", flex: "none" }}>▲</Text>
              <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: "#f3a4a9" }}>In a cross-project dependency cycle — coordinate release order before shipping to avoid a deadlock.</Text>
            </Row>
          )}

          {LABEL("AGENTS")}
          <Text as="div" size={11.5} tone="muted" style={{ lineHeight: 1.5 }}>Drilling a project opens its live agent network (director · workers · triage) — arriving in the next slice.</Text>

          {LABEL("DEPENDS ON")}
          {deps.length === 0 ? <Text as="div" mono size={11} tone="dim">— foundational, no upstream deps</Text>
            : deps.map((e) => <DepRow key={e.id} node={model.nodes.find((x) => x.id === e.to)!} kind={kindOf(e.kind, e.isCycle)} color={colorOf(e.kind, e.isCycle)} onClick={() => onSelectNode(e.to)} />)}

          {LABEL("DEPENDED ON BY")}
          {rdeps.length === 0 ? <Text as="div" mono size={11} tone="dim">— leaf, nothing depends on it</Text>
            : rdeps.map((e) => <DepRow key={e.id} node={model.nodes.find((x) => x.id === e.from)!} kind={kindOf(e.kind, e.isCycle)} color={colorOf(e.kind, e.isCycle)} onClick={() => onSelectNode(e.from)} />)}

          <Button variant="ghost" onClick={() => { /* L2 drill → open project console lands in a later slice */ }} style={{ width: "100%", marginTop: 18 }}>open project ↗</Button>
        </Box>
      </Box>
    );
  }

  if (selType === "edge" && selId) {
    const e = model.edges.find((x) => x.id === selId);
    if (!e) return null;
    const meta = EDGE_META[e.kind];
    const kindColor = e.isCycle ? "#f2555f" : meta.color;
    const from = model.nodes.find((x) => x.id === e.from)!, to = model.nodes.find((x) => x.id === e.to)!;
    return (
      <Box style={PANEL}>
        <Header title="CONTRACT INSPECTOR" onClose={onClose} />
        <Box style={{ flex: 1, overflowY: "auto", padding: "18px 16px" }}>
          <Text as="span" mono size={11} style={{ color: e.isCycle ? "#f2848b" : kindColor, background: `color-mix(in oklch, ${kindColor} 12%, transparent)`, border: `1px solid color-mix(in oklch, ${kindColor} 32%, transparent)`, borderRadius: 6, padding: "5px 10px" }}>{e.isCycle ? "cycle" : meta.label}</Text>

          {e.isCycle && (
            <Row gap={9} align="start" style={{ marginTop: 14, background: CYCLE_BG, border: `1px solid ${CYCLE_BD}`, borderRadius: 8, padding: "11px 12px" }}>
              <Text as="span" style={{ color: "#f2555f", flex: "none" }}>▲</Text>
              <Text as="span" size={11.5} style={{ lineHeight: 1.5, color: "#f3a4a9" }}>This edge closes a cycle. Two projects depend on each other — releasing either in isolation can deadlock the other.</Text>
            </Row>
          )}

          <Row gap={12} align="center" style={{ marginTop: 20 }}>
            <Box onClick={() => onSelectNode(e.from)} style={{ ...CARD, cursor: "pointer" }}>
              <Text as="div" mono size={9} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>CONSUMER</Text>
              <Row gap={7} align="center"><Box style={{ width: 8, height: 8, borderRadius: "50%", background: ROLE_COLOR[from.role] }} /><Text as="span" mono size={12}>{from.slug}</Text></Row>
            </Box>
            <Text as="span" tone="dim">→</Text>
            <Box onClick={() => onSelectNode(e.to)} style={{ ...CARD, cursor: "pointer" }}>
              <Text as="div" mono size={9} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>PROVIDER</Text>
              <Row gap={7} align="center"><Box style={{ width: 8, height: 8, borderRadius: "50%", background: ROLE_COLOR[to.role] }} /><Text as="span" mono size={12}>{to.slug}</Text></Row>
            </Box>
          </Row>

          <Box style={{ ...CARD, marginTop: 16, flex: "unset" }}>
            <Text as="div" mono size={9.5} tone="dim" style={{ letterSpacing: ".8px", marginBottom: 6 }}>STRENGTH</Text>
            <Text as="span" mono size={11} style={{ color: e.hard ? "#f2b155" : "var(--fg-muted)" }}>{e.hard ? "hard" : "soft"}</Text>
          </Box>

          {LABEL("SURFACE")}
          <Box style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "12px 13px" }}>
            <Text as="span" mono size={11.5} tone="muted" style={{ lineHeight: 1.7 }}>{meta.surface}</Text>
          </Box>

          {LABEL("DESCRIPTION")}
          <Text as="div" size={12} style={{ lineHeight: 1.6, color: "var(--fg-muted)" }}>
            {e.isCycle
              ? `${from.slug} and ${to.slug} depend on each other. This back-edge closes the loop — treat as a release-ordering hazard.`
              : `${from.slug} consumes ${to.slug} over a ${meta.label.toLowerCase()}. ${e.hard ? "Hard dependency: a breaking change here blocks the consumer." : "Soft dependency: degrades gracefully."}`}
          </Text>
        </Box>
      </Box>
    );
  }

  return null;
}
