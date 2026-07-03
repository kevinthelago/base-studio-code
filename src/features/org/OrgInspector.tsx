// The org inspector (#2193, config #2199) — the right panel, in one of two modes. POSITION: the node's
// identity (a persona picker + the shared <PersonaEditor> for agent nodes, or a label for
// resource/external) + the AUTO-DERIVED communication surface. RELATIONSHIP: the edge's archetype
// (changeable) + the communication forms flowing each way. Reads the real store data.
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { SelectField, TextField } from "@/shared/ui/controls/Field";
import { PersonaEditor } from "@/features/personas";
import type { Persona } from "@/features/personas";
import { RELATIONSHIP_ARCHETYPES, archetypeById, formById, type Org } from "./lib/org";
import { positionDisplay, positionComms, hueColor } from "./lib/orgView";
import { FormChip, SectionLabel, FormLane } from "./components";
import type { Selection } from "./OrgCanvas";

interface InspectorProps {
  org: Org;
  /** Every org — to count how many positions share a persona (the "used in N" note). */
  orgs: Org[];
  personas: Persona[];
  sel: Selection;
  onSelectNode: (nodeId: string) => void;
  onChangeArchetype: (relId: string, archetype: string) => void;
  /** Point an agent position at a different persona identity. */
  onChangePersona: (nodeId: string, personaId: string) => void;
  /** Rename a resource/external node (or override an agent node's label). */
  onChangeLabel: (nodeId: string, label: string) => void;
}

// Fills its (drag-resizable) wrapper column in GraphCanvas — the width is owned by the layout, not here.
const PANEL: React.CSSProperties = { flex: 1, minWidth: 0, borderLeft: "1px solid var(--border-soft)", overflowY: "auto" };
const BLOCK: React.CSSProperties = { padding: "15px 17px", borderBottom: "1px solid var(--border-soft)" };

export function OrgInspector({ org, orgs, personas, sel, onSelectNode, onChangeArchetype, onChangePersona, onChangeLabel }: InspectorProps) {
  if (sel.type === "node") {
    const pos = org.positions.find((p) => p.nodeId === sel.id);
    if (!pos) return <Box style={PANEL} />;
    const d = positionDisplay(pos, personas);
    const persona = pos.personaId ? personas.find((p) => p.id === pos.personaId) : undefined;
    const comms = positionComms(org, pos, personas);
    // How many positions across every org embody this same persona (edits here ripple to all of them).
    const uses = persona ? orgs.reduce((n, o) => n + o.positions.filter((p) => p.personaId === persona.id).length, 0) : 0;

    return (
      <Box style={PANEL}>
        {/* header */}
        <Box style={{ ...BLOCK, padding: "16px 17px 14px" }}>
          <Row gap={11} align="center">
            <Box style={{ width: 40, height: 40, borderRadius: 11, display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 18, color: "#fff", background: "var(--accent)", flex: "none" }}>{d.glyph}</Box>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text as="div" weight={600} size={16}>{d.name}</Text>
              <Row gap={7} align="center" style={{ marginTop: 3 }}>
                <Text as="span" size={10} tone="muted">{d.dept}</Text>
                {d.role && <Chip color="var(--accent)">{d.role}</Chip>}
              </Row>
            </Box>
          </Row>
        </Box>

        {/* identity — a persona (agent) or a label (resource/external) */}
        {pos.kind === "agent" ? (
          <Box style={BLOCK}>
            <SectionLabel right={persona && uses > 1 ? <Text as="span" mono size={9} tone="dim">shared · used in {uses}</Text> : undefined}>Persona</SectionLabel>
            <SelectField label="" value={pos.personaId ?? ""} onChange={(v) => onChangePersona(pos.nodeId, v)}>
              {!pos.personaId && <option value="">— pick a persona —</option>}
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </SelectField>
            {persona && (
              <>
                <Text as="div" size={10} tone="dim" style={{ margin: "8px 0 12px" }}>Editing the shared identity — changes reach every position that uses it.</Text>
                <PersonaEditor persona={persona} compact />
              </>
            )}
          </Box>
        ) : (
          <Box style={BLOCK}>
            <SectionLabel>{pos.kind === "resource" ? "Resource" : "External actor"}</SectionLabel>
            <TextField label="Label" value={pos.label ?? ""} onChange={(v) => onChangeLabel(pos.nodeId, v)} placeholder="Name" />
          </Box>
        )}

        {/* communication (derived) */}
        <Box style={{ padding: "15px 17px 24px" }}>
          <SectionLabel right={<Text as="span" mono size={9} tone="dim">auto · from relationships</Text>}>Communication</SectionLabel>
          {comms.length === 0 ? (
            <Text as="div" size={11} tone="dim">No relationships yet — connect this position on the canvas.</Text>
          ) : (
            <Stack gap={7}>
              {comms.map((cm) => (
                <Box key={cm.counterpartNode + cm.archetype} onClick={() => onSelectNode(cm.counterpartNode)}
                  style={{ padding: "8px 9px", borderRadius: 8, background: "var(--bg-soft)", border: "1px solid var(--border-soft)", cursor: "pointer" }}>
                  <Row gap={7} align="center">
                    <Box style={{ width: 7, height: 7, borderRadius: 2, background: hueColor(cm.hue), flex: "none" }} />
                    <Text as="span" size={12} weight={500}>{cm.archetypeLabel} · {cm.counterpartName}</Text>
                  </Row>
                  <Row gap={5} wrap style={{ marginTop: 6 }}>
                    {cm.sends.map((f) => <FormChip key={"o" + f.id} form={f} />)}
                    {cm.receives.map((f) => <FormChip key={"i" + f.id} form={f} />)}
                  </Row>
                </Box>
              ))}
            </Stack>
          )}
        </Box>
      </Box>
    );
  }

  // ── relationship mode ──
  const rel = org.relationships.find((r) => r.id === sel.id);
  if (!rel) return <Box style={PANEL} />;
  const arch = archetypeById(rel.archetype);
  const from = org.positions.find((p) => p.nodeId === rel.from);
  const to = org.positions.find((p) => p.nodeId === rel.to);
  const aLabel = from ? positionDisplay(from, personas).name : rel.from;
  const bLabel = to ? positionDisplay(to, personas).name : rel.to;
  const fwd = (arch?.forward ?? []).map(formById).filter((f): f is NonNullable<typeof f> => !!f);
  const back = (arch?.backward ?? []).map(formById).filter((f): f is NonNullable<typeof f> => !!f);

  return (
    <Box style={PANEL}>
      <Box style={{ ...BLOCK, padding: "16px 17px 15px" }}>
        <SectionLabel>Relationship</SectionLabel>
        <SelectField label="" value={rel.archetype} onChange={(v) => onChangeArchetype(rel.id, v)}>
          {RELATIONSHIP_ARCHETYPES.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
        </SelectField>
        <Row gap={8} align="center" style={{ marginTop: 12 }}>
          <Text as="span" weight={600} size={12.5} style={{ cursor: "pointer" }} onClick={() => onSelectNode(rel.from)}>{aLabel}</Text>
          <Text as="span" tone="dim">—</Text>
          <Text as="span" size={11} tone="muted">{arch?.label}</Text>
          <Text as="span" tone="dim">→</Text>
          <Text as="span" weight={600} size={12.5} style={{ cursor: "pointer" }} onClick={() => onSelectNode(rel.to)}>{bLabel}</Text>
        </Row>
        {arch && <Text as="p" size={11} tone="muted" style={{ lineHeight: 1.45, margin: "11px 0 0" }}>{arch.blurb}</Text>}
      </Box>

      <Stack gap={10} style={{ padding: "15px 17px 24px" }}>
        <SectionLabel>Communication forms</SectionLabel>
        <FormLane from={aLabel} to={bLabel} forms={fwd} hue={arch?.hue ?? 0} />
        <FormLane from={bLabel} to={aLabel} forms={back} hue={arch?.hue ?? 0} />
      </Stack>
    </Box>
  );
}
