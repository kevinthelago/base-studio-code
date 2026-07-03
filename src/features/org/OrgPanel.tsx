// Org panel (#2193) — the substrate view of the persona-relationship graph, mounted as the Org tab of
// the Planner workspace. Left: the org list (built-ins + user orgs). Right: the selected org's
// positions, each with its AUTO-DERIVED communication surface (the generate-from-facets payoff), plus
// the relationship list. This is a functional list-based view; the rich draggable canvas designer
// lands separately and replaces the body here — the store/bridge/vocabulary underneath are the durable
// substrate it plugs into.
import { useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import {
  archetypeById, deriveCommunication, type Org, type Position,
} from "./lib/org";
import type { Persona } from "@/features/personas";

/** The display name for a position node: explicit label, else its persona's name, else the node id. */
function positionName(pos: Position, personas: Persona[]): string {
  if (pos.label) return pos.label;
  if (pos.personaId) return personas.find((p) => p.id === pos.personaId)?.name ?? pos.personaId;
  return pos.nodeId;
}

/** One position card: its name + kind + the forms flowing in/out, derived from the org's edges. */
function PositionCard({ org, pos, personas }: { org: Org; pos: Position; personas: Persona[] }) {
  const comms = deriveCommunication(org, pos.nodeId);
  const out = comms.filter((c) => c.dir === "out");
  const incoming = comms.filter((c) => c.dir === "in");
  return (
    <Card style={{ padding: "10px 12px" }}>
      <Row align="center" gap={7}>
        <Text as="div" weight={600} size={12.5} style={{ flex: 1, minWidth: 0 }}>{positionName(pos, personas)}</Text>
        <Chip style={{ color: "var(--fg-dim)" }}>{pos.kind}</Chip>
      </Row>
      <Stack gap={4} style={{ marginTop: 8 }}>
        <CommLane label="sends" edges={out} personas={personas} org={org} />
        <CommLane label="receives" edges={incoming} personas={personas} org={org} />
      </Stack>
    </Card>
  );
}

function CommLane(
  { label, edges, personas, org }:
  { label: string; edges: ReturnType<typeof deriveCommunication>; personas: Persona[]; org: Org },
) {
  if (edges.length === 0) return <Text as="div" size={10} tone="dim">{label}: —</Text>;
  return (
    <Box>
      <Text as="div" className="ulabel" tone="dim" size={9}>{label}</Text>
      <Row gap={5} wrap style={{ marginTop: 3 }}>
        {edges.map((e, i) => {
          const other = org.positions.find((p) => p.nodeId === e.withNode);
          const otherName = other ? positionName(other, personas) : e.withNode;
          return (
            <Chip key={`${e.form.id}-${e.withNode}-${i}`} color={e.form.authority ? "var(--accent)" : "var(--info)"}>
              {e.form.label} {e.dir === "out" ? "→" : "←"} {otherName}{e.form.blocks ? " ⚡" : ""}
            </Chip>
          );
        })}
      </Row>
    </Box>
  );
}

export function OrgPanel() {
  const orgs = useAppStore((s) => s.orgs);
  const personas = useAppStore((s) => s.personas);
  const addOrg = useAppStore((s) => s.addOrg);
  const cloneOrg = useAppStore((s) => s.cloneOrg);
  const removeOrg = useAppStore((s) => s.removeOrg);

  const [selectedId, setSelectedId] = useState<string>(orgs[0]?.id ?? "");
  const selected = orgs.find((o) => o.id === selectedId) ?? orgs[0];

  return (
    <Row align="stretch" gap={0} style={{ flex: 1, minHeight: 0 }}>
      {/* ── List rail ── */}
      <Stack gap={8} style={{ width: 240, minWidth: 240, padding: 14, overflowY: "auto", borderRight: "1px solid var(--border-soft)" }}>
        <Row align="center" gap={8}>
          <Text as="div" className="ulabel" tone="dim" style={{ flex: 1 }}>orgs · {orgs.length}</Text>
          <Button variant="ghost" onClick={() => setSelectedId(addOrg())}>+ new</Button>
        </Row>
        {orgs.map((o) => (
          <Card
            key={o.id}
            interactive
            tone={o.id === selected?.id ? "var(--accent)" : undefined}
            onClick={() => setSelectedId(o.id)}
            style={{ padding: "9px 11px", cursor: "pointer" }}
          >
            <Row align="center" gap={7}>
              <Text as="div" weight={600} size={12.5} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{o.name}</Text>
              {o.builtin && <Chip style={{ color: "var(--fg-dim)" }}>built-in</Chip>}
            </Row>
            <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 2 }}>{o.positions.length} positions · {o.relationships.length} links</Text>
          </Card>
        ))}
      </Stack>

      {/* ── Body ── */}
      {selected ? (
        <Stack gap={16} style={{ flex: 1, minWidth: 0, padding: 20, overflowY: "auto" }}>
          <Row align="baseline" gap={10}>
            <Text as="h2" size={16} weight={600} style={{ margin: 0, flex: 1 }}>{selected.name}</Text>
            <Button variant="ghost" onClick={() => setSelectedId(cloneOrg(selected.id))}>clone</Button>
            {!selected.builtin && (
              <ConfirmButton label="delete" armedLabel="delete?" danger
                onConfirm={() => { removeOrg(selected.id); setSelectedId(orgs[0]?.id ?? ""); }} />
            )}
          </Row>
          {selected.blurb && <Text as="div" size={11.5} tone="muted">{selected.blurb}</Text>}

          <Box>
            <Text as="div" className="ulabel" tone="dim" style={{ marginBottom: 8 }}>positions · communication (auto-derived)</Text>
            <Grid cols={2} gap={10}>
              {selected.positions.map((p) => (
                <PositionCard key={p.nodeId} org={selected} pos={p} personas={personas} />
              ))}
            </Grid>
          </Box>

          <Box>
            <Text as="div" className="ulabel" tone="dim" style={{ marginBottom: 8 }}>relationships · {selected.relationships.length}</Text>
            <Stack gap={5}>
              {selected.relationships.map((r) => {
                const arch = archetypeById(r.archetype);
                const from = selected.positions.find((p) => p.nodeId === r.from);
                const to = selected.positions.find((p) => p.nodeId === r.to);
                return (
                  <Row key={r.id} gap={8} align="center">
                    <Chip color={arch ? `oklch(0.7 0.12 ${arch.hue})` : "var(--fg-dim)"}>{arch?.label ?? r.archetype}</Chip>
                    <Text as="div" mono size={11}>
                      {from ? positionName(from, personas) : r.from} → {to ? positionName(to, personas) : r.to}
                    </Text>
                  </Row>
                );
              })}
            </Stack>
          </Box>
        </Stack>
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }}>
          <Text tone="dim">Select or create an org.</Text>
        </Stack>
      )}
    </Row>
  );
}
