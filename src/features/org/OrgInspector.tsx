// The org inspector (#2193) — the right panel, in one of two modes. POSITION: the selected node's
// facets (role/clearance · responsibilities · skills · the AUTO-DERIVED communication surface).
// RELATIONSHIP: the selected edge's archetype (changeable) + the communication forms flowing each way.
// Ported from the Claude Design prototype onto the app's kit; reads the real store data.
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { SelectField } from "@/shared/ui/controls/Field";
import { RELATIONSHIP_ARCHETYPES, archetypeById, formById, type Org } from "./lib/org";
import { positionDisplay, positionComms, hueColor } from "./lib/orgView";
import { TierChips, FormChip, SectionLabel, FormLane } from "./components";
import type { Selection } from "./OrgCanvas";
import type { Persona } from "@/features/personas";

interface InspectorProps {
  org: Org;
  personas: Persona[];
  skills: { id: string; name: string }[];
  sel: Selection;
  onSelectNode: (nodeId: string) => void;
  onChangeArchetype: (relId: string, archetype: string) => void;
}

const PANEL: React.CSSProperties = { width: 344, minWidth: 344, borderLeft: "1px solid var(--border-soft)", overflowY: "auto" };
const BLOCK: React.CSSProperties = { padding: "15px 17px", borderBottom: "1px solid var(--border-soft)" };

export function OrgInspector({ org, personas, skills, sel, onSelectNode, onChangeArchetype }: InspectorProps) {
  if (sel.type === "node") {
    const pos = org.positions.find((p) => p.nodeId === sel.id);
    if (!pos) return <Box style={PANEL} />;
    const d = positionDisplay(pos, personas);
    const persona = pos.personaId ? personas.find((p) => p.id === pos.personaId) : undefined;
    const comms = positionComms(org, pos, personas);
    const skillNames = (persona?.skills ?? []).map((id) => skills.find((s) => s.id === id)?.name ?? id);

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
          {d.blurb && <Text as="p" size={12} tone="muted" style={{ lineHeight: 1.45, margin: "11px 0 0" }}>{d.blurb}</Text>}
        </Box>

        {/* role / clearance */}
        {d.role && (
          <Box style={BLOCK}>
            <SectionLabel right={<Text as="span" mono size={9.5} tone="dim">floor: {d.role}</Text>}>Role · Clearance</SectionLabel>
            <TierChips role={d.role} />
          </Box>
        )}

        {/* responsibilities */}
        {persona?.responsibilities && persona.responsibilities.length > 0 && (
          <Box style={BLOCK}>
            <SectionLabel>Responsibilities</SectionLabel>
            <Stack gap={2}>
              {persona.responsibilities.map((r, i) => (
                <Row key={i} gap={8} align="start" style={{ padding: "6px 7px", borderRadius: 7, background: "var(--bg-soft)" }}>
                  <Text as="span" tone="dim" size={11} style={{ lineHeight: 1.5, flex: "none" }}>·</Text>
                  <Text as="span" size={12} style={{ lineHeight: 1.5 }}>{r}</Text>
                </Row>
              ))}
            </Stack>
          </Box>
        )}

        {/* skills */}
        {skillNames.length > 0 && (
          <Box style={BLOCK}>
            <SectionLabel>Skills</SectionLabel>
            <Row gap={6} wrap>
              {skillNames.map((n, i) => <Chip key={i} color="var(--accent)">{n}</Chip>)}
            </Row>
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
