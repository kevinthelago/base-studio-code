// PersonaEditor (#2199) — the shared editor for one persona's facets (name · blurb · role+tiers ·
// responsibilities · start prompt · model · skills), extracted from PersonasPanel so BOTH the Personas
// tab and the Org designer's position inspector drive the same fields + the same `updatePersona`. It
// edits the SHARED persona identity (a persona used by N positions changes everywhere) — callers that
// need to surface that show their own "shared · used in N" note. `compact` collapses the long start
// prompt (for the narrow Org inspector).
import { useState } from "react";
import { useAppStore } from "@/store";
import { ROLE_DEFAULTS, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { MODEL_IDS } from "@/app/console/lib/models";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TextField, TextArea, SelectField } from "@/shared/ui/controls/Field";
import { Checkbox } from "@/shared/ui/controls/Checkbox";
import { RoleTierChips } from "@/shared/ui/data/RoleTierChips";
import type { Persona } from "./lib/persona";

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];

export function PersonaEditor({ persona, compact = false }: { persona: Persona; compact?: boolean }) {
  const skills = useAppStore((s) => s.skills);
  const updatePersona = useAppStore((s) => s.updatePersona);
  const [showPrompt, setShowPrompt] = useState(!compact);

  const resp = persona.responsibilities ?? [];
  const setResp = (next: string[]) => updatePersona(persona.id, { responsibilities: next });
  const toggleSkill = (skillId: string) => {
    const has = persona.skills.includes(skillId);
    updatePersona(persona.id, { skills: has ? persona.skills.filter((s) => s !== skillId) : [...persona.skills, skillId] });
  };

  return (
    <Stack gap={16}>
      <TextField label="Name" value={persona.name} onChange={(v) => updatePersona(persona.id, { name: v })} />
      <TextField label="What it does" value={persona.blurb} onChange={(v) => updatePersona(persona.id, { blurb: v })} placeholder="One line — the job this persona does" />

      <Box>
        <SelectField label="Role — the permission floor (edited on Security)" value={persona.role} onChange={(v) => updatePersona(persona.id, { role: v as SessionRole })}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </SelectField>
        <Box style={{ marginTop: 6 }}><RoleTierChips role={persona.role} /></Box>
      </Box>

      {/* responsibilities — an editable charter list */}
      <Box>
        <SectionLabel size={9.5} style={{ marginBottom: 6 }} right={<Button variant="ghost" onClick={() => setResp([...resp, ""])}>+ add</Button>}>
          responsibilities · {resp.length}
        </SectionLabel>
        <Stack gap={5}>
          {resp.map((r, i) => (
            <Row key={i} gap={6} align="center">
              <TextField value={r} onChange={(v) => setResp(resp.map((x, j) => (j === i ? v : x)))} placeholder="What this persona is accountable for" style={{ flex: 1 }} />
              <IconButton aria-label="remove responsibility" onClick={() => setResp(resp.filter((_, j) => j !== i))}>×</IconButton>
            </Row>
          ))}
        </Stack>
      </Box>

      {/* start prompt — collapsible in compact mode */}
      <Box>
        {compact && (
          <SectionLabel size={9.5} style={{ marginBottom: 6 }} right={<Button variant="ghost" onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? "hide" : "edit"}</Button>}>
            start prompt
          </SectionLabel>
        )}
        {showPrompt && (
          <TextArea
            label={compact ? undefined : "Start prompt"}
            value={persona.startPrompt}
            onChange={(v) => updatePersona(persona.id, { startPrompt: v })}
            placeholder="The protocol/prose injected at launch. Empty falls back to the role's own kickoff."
            style={{ width: "100%", minHeight: compact ? 110 : 150, resize: "vertical", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55 }}
          />
        )}
      </Box>

      <SelectField label="Default model" value={persona.model ?? ""} onChange={(v) => updatePersona(persona.id, { model: v || undefined })}>
        <option value="">session default</option>
        {MODEL_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
        {persona.model && !(MODEL_IDS as string[]).includes(persona.model) && <option value={persona.model}>{persona.model} (custom)</option>}
      </SelectField>

      {/* pooled — a swarm of interchangeable instances; collapses to one stacked card in the Org designer */}
      <Row gap={9} align="start" onClick={() => updatePersona(persona.id, { pooled: !persona.pooled })} style={{ cursor: "pointer" }}>
        <Box style={{ marginTop: 1 }}><Checkbox checked={!!persona.pooled} aria-label="pooled persona" /></Box>
        <Box style={{ minWidth: 0 }}>
          <Text as="div" size={12.5} weight={500}>Pooled — a swarm of interchangeable instances</Text>
          <Text as="div" size={10.5} tone="dim" style={{ marginTop: 2 }}>Identical instances of this persona collapse into one stacked card in the Org designer; drill in to see the pool.</Text>
        </Box>
      </Row>

      <Box>
        <SectionLabel size={9.5} style={{ marginBottom: 6 }}>attached skills · {persona.skills.length}</SectionLabel>
        {skills.length === 0 ? (
          <Text as="div" size={11} tone="dim">No skills in the library yet — author them on the Skills page.</Text>
        ) : (
          <Row gap={6} wrap>
            {skills.map((sk) => {
              const on = persona.skills.includes(sk.id);
              return (
                <Box as="button" key={sk.id} onClick={() => toggleSkill(sk.id)} className="mono"
                  style={{ cursor: "pointer", padding: "2px 9px", borderRadius: 99, fontSize: 10.5,
                    color: on ? "var(--accent)" : "var(--fg-muted)",
                    border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                    background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent" }}>
                  {on ? "✓ " : ""}{sk.name}
                </Box>
              );
            })}
          </Row>
        )}
      </Box>
    </Stack>
  );
}
