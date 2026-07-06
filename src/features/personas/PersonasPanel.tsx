// Personas panel (#2094) — the CRUD surface for the agent-identity library, mounted as the Personas
// tab of the Planner workspace. Left: the persona list (built-ins + user personas) with a "new"
// action. Right: the shared <PersonaEditor> for the selected persona (name · role+tiers ·
// responsibilities · start prompt · skills · model). Built-ins are editable + clonable but not
// deletable. The editor is shared with the Org designer's position inspector (#2199).
import { useState } from "react";
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { MasterDetail } from "@/shared/ui/layouts/MasterDetail";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { PersonaEditor } from "./PersonaEditor";

export function PersonasPanel() {
  const personas = useAppStore((s) => s.personas);
  const addPersona = useAppStore((s) => s.addPersona);
  const clonePersona = useAppStore((s) => s.clonePersona);
  const removePersona = useAppStore((s) => s.removePersona);

  const [selectedId, setSelectedId] = useState<string>(personas[0]?.id ?? "");
  const selected = personas.find((p) => p.id === selectedId) ?? personas[0];

  return (
    // The standardized list+detail Layout (#2197) owns the rail width/border/scroll + detail
    // scroll/padding; the slots bring only their content.
    <MasterDetail
      railWidth={260}
      rail={
      <Stack gap={8}>
        <SectionLabel size={9.5} right={<Button variant="ghost" onClick={() => setSelectedId(addPersona())}>+ new</Button>}>
          personas · {personas.length}
        </SectionLabel>
        {personas.map((p) => (
          <Card
            key={p.id}
            interactive
            tone={p.id === selected?.id ? "var(--accent)" : undefined}
            onClick={() => setSelectedId(p.id)}
            style={{ padding: "9px 11px", cursor: "pointer" }}
          >
            <Row align="center" gap={7}>
              <Text as="div" weight={600} size={12.5} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</Text>
              {p.builtin && <Chip style={{ color: "var(--fg-dim)" }}>built-in</Chip>}
            </Row>
            <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 2 }}>role · {p.role}</Text>
          </Card>
        ))}
      </Stack>
      }
      detail={selected ? (
        <Stack gap={16}>
          <Row align="baseline" gap={10}>
            <Text as="h2" size={16} weight={600} style={{ margin: 0, flex: 1 }}>{selected.name || "Untitled persona"}</Text>
            <Button variant="ghost" onClick={() => setSelectedId(clonePersona(selected.id))}>clone</Button>
            {!selected.builtin && (
              <ConfirmButton label="delete" armedLabel="delete?" danger
                onConfirm={() => { removePersona(selected.id); setSelectedId(personas[0]?.id ?? ""); }} />
            )}
          </Row>
          <PersonaEditor persona={selected} />
        </Stack>
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }}>
          <Text tone="dim">Select or create a persona.</Text>
        </Stack>
      )}
    />
  );
}
