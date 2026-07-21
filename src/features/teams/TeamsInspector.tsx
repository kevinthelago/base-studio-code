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
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { IconBox } from "@/shared/ui/data/IconBox";
import { SectionLabel, type SectionLabelProps } from "@/shared/ui/layout/SectionLabel";
import { PersonaEditor } from "@/features/personas";
import type { Persona } from "@/features/personas";
import { RELATIONSHIP_ARCHETYPES, archetypeById, formById, type Team } from "./lib/team";
import { positionDisplay, positionComms, hueColor } from "./lib/orgView";
import { FormChip, FormLane } from "./components";
import type { Selection } from "./TeamsCanvas";

/** The inspector's block header — the shared SectionLabel (`right` slot, #2420) at the org
 *  designer's `.ulabel` size, with the block's standard 9px bottom gap baked in. */
function BlockLabel(props: Omit<SectionLabelProps, "size" | "style">) {
  return <SectionLabel size={9.5} style={{ marginBottom: 9 }} {...props} />;
}

interface InspectorProps {
  org: Team;
  /** Every org — to count how many positions share a persona (the "used in N" note). */
  orgs: Team[];
  personas: Persona[];
  sel: Selection;
  onSelectNode: (nodeId: string) => void;
  onChangeArchetype: (relId: string, archetype: string) => void;
  /** Point an agent position at a different persona identity. */
  onChangePersona: (nodeId: string, personaId: string) => void;
  /** Rename a resource/external node (or override an agent node's label). */
  onChangeLabel: (nodeId: string, label: string) => void;
  /** Delete a position (node) + every relationship touching it (manual override, #2383/#2382). */
  onDeletePosition: (nodeId: string) => void;
  /** Delete a relationship (edge). */
  onDeleteRelationship: (relId: string) => void;
}

// Fills its (drag-resizable) wrapper column in GraphCanvas — the width is owned by the layout, not here.
const PANEL: React.CSSProperties = { flex: 1, minWidth: 0, borderLeft: "1px solid var(--border-soft)", overflowY: "auto" };
const BLOCK: React.CSSProperties = { padding: "15px 17px", borderBottom: "1px solid var(--border-soft)" };

export function TeamsInspector({ org, orgs, personas, sel, onSelectNode, onChangeArchetype, onChangePersona, onChangeLabel, onDeletePosition, onDeleteRelationship }: InspectorProps) {
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
            <IconBox size={40} radius={11} fontSize={18} color="#fff" background="var(--accent)">{d.glyph}</IconBox>
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
            <BlockLabel right={persona && uses > 1 ? <Text as="span" mono size={9} tone="dim">shared · used in {uses}</Text> : undefined}>Persona</BlockLabel>
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
            <BlockLabel>{pos.kind === "resource" ? "Resource" : "External actor"}</BlockLabel>
            <TextField label="Label" value={pos.label ?? ""} onChange={(v) => onChangeLabel(pos.nodeId, v)} placeholder="Name" />
          </Box>
        )}

        {/* communication (derived) */}
        <Box style={{ padding: "15px 17px 24px" }}>
          <BlockLabel right={<Text as="span" mono size={9} tone="dim">auto · from relationships</Text>}>Communication</BlockLabel>
          {comms.length === 0 ? (
            <Text as="div" size={11} tone="dim">No relationships yet — connect this position on the canvas.</Text>
          ) : (
            <Stack gap={7}>
              {comms.map((cm) => (
                <Box key={cm.counterpartNode + cm.archetype} onClick={() => onSelectNode(cm.counterpartNode)}
                  style={{ padding: "8px 9px", borderRadius: 8, background: "var(--bg-soft)", border: "1px solid var(--border-soft)", cursor: "pointer" }}>
                  <Row gap={7} align="center">
                    <ColorSwatch color={hueColor(cm.hue)} size={7} />
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

        {/* Manual override (#2383): delete this node + its relationships. Interim until the agent owns
            every mutation (#2382 — UI as read-only). */}
        <Box style={{ padding: "0 17px 20px" }}>
          <ConfirmButton size="sm" label="Delete position" armedLabel="Confirm — removes its links"
            onConfirm={() => onDeletePosition(pos.nodeId)} />
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
        <BlockLabel>Relationship</BlockLabel>
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
        <BlockLabel>Communication forms</BlockLabel>
        <FormLane from={aLabel} to={bLabel} forms={fwd} hue={arch?.hue ?? 0} />
        <FormLane from={bLabel} to={aLabel} forms={back} hue={arch?.hue ?? 0} />
      </Stack>

      {/* Manual override (#2383): delete this relationship edge. */}
      <Box style={{ padding: "0 17px 20px" }}>
        <ConfirmButton size="sm" label="Delete relationship" armedLabel="Confirm delete"
          onConfirm={() => onDeleteRelationship(rel.id)} />
      </Box>
    </Box>
  );
}
