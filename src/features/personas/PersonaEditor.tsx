// PersonaEditor (#2199) — the shared editor for one persona's facets (name · blurb · role+tiers ·
// responsibilities · start prompt · model · skills), extracted from PersonasPanel so BOTH the Personas
// tab and the Org designer's position inspector drive the same fields + the same `updatePersona`. It
// edits the SHARED persona identity (a persona used by N positions changes everywhere) — callers that
// need to surface that show their own "shared · used in N" note. `compact` collapses the long start
// prompt (for the narrow Org inspector).
import { useState } from "react";
import { useAppStore } from "@/store";
import { roleCapability, ROLE_DEFAULTS, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { MODEL_IDS } from "@/app/console/lib/models";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { TextField, SelectField } from "@/shared/ui/controls/Field";
import type { Persona } from "./lib/persona";

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];
const TIER_COLOR: Record<string, string> = { none: "var(--fg-dim)", read: "var(--info)", write: "var(--accent)" };

/** The four capability tiers of a role, as coloured pills — the permission floor a persona inherits. */
export function RoleTiers({ role }: { role: SessionRole }) {
  const cap = roleCapability(role);
  const tiers: [string, string][] = [["git", cap.git], ["github", cap.github], ["code", cap.code], ["net", cap.net]];
  return (
    <Row gap={5} wrap>
      {tiers.map(([k, v]) => <Chip key={k} color={TIER_COLOR[v] ?? "var(--fg-dim)"}>{k} · {v}</Chip>)}
    </Row>
  );
}

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
        <Box style={{ marginTop: 6 }}><RoleTiers role={persona.role} /></Box>
      </Box>

      {/* responsibilities — an editable charter list */}
      <Box>
        <Row align="center" justify="between" style={{ marginBottom: 6 }}>
          <Text as="div" className="ulabel" tone="dim">responsibilities · {resp.length}</Text>
          <Button variant="ghost" onClick={() => setResp([...resp, ""])}>+ add</Button>
        </Row>
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
          <Row align="center" justify="between" style={{ marginBottom: 6 }}>
            <Text as="div" className="ulabel" tone="dim">start prompt</Text>
            <Button variant="ghost" onClick={() => setShowPrompt((v) => !v)}>{showPrompt ? "hide" : "edit"}</Button>
          </Row>
        )}
        {showPrompt && (
          <Box className="field">
            {!compact && <label>Start prompt</label>}
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke multi-line prompt editor; TextField is single-line */}
            <textarea
              className="input"
              value={persona.startPrompt}
              onChange={(e) => updatePersona(persona.id, { startPrompt: e.target.value })}
              placeholder="The protocol/prose injected at launch. Empty falls back to the role's own kickoff."
              style={{ width: "100%", minHeight: compact ? 110 : 150, resize: "vertical", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55 }}
            />
          </Box>
        )}
      </Box>

      <SelectField label="Default model" value={persona.model ?? ""} onChange={(v) => updatePersona(persona.id, { model: v || undefined })}>
        <option value="">session default</option>
        {MODEL_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
        {persona.model && !(MODEL_IDS as string[]).includes(persona.model) && <option value={persona.model}>{persona.model} (custom)</option>}
      </SelectField>

      <Box>
        <Text as="div" className="ulabel" tone="dim" style={{ marginBottom: 6 }}>attached skills · {persona.skills.length}</Text>
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
