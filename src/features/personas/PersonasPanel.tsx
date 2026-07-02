// Personas panel (#2094) — the CRUD surface for the agent-identity library, mounted as the Personas
// tab of the Planner workspace. Left: the persona list (built-ins + user personas) with a "new"
// action. Right: the editor for the selected persona — name · role (permission floor) · blurb · start
// prompt · attached skills · default model. Built-ins are editable + clonable but not deletable; the
// role a persona references is shown with its live capability tiers (read from sessionRoles, so the
// floor can't drift). Behavior identity only — the ROLE gate itself is edited on the Security page.
import { useState } from "react";
import { useAppStore } from "@/store";
import { ROLE_DEFAULTS, roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
import { TextField, SelectField } from "@/shared/ui/controls/Field";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";

const ROLES = Object.keys(ROLE_DEFAULTS) as SessionRole[];
const TIER_COLOR: Record<string, string> = {
  none: "var(--fg-dim)", read: "var(--info)", write: "var(--accent)",
};

/** The four capability tiers of a role, as coloured pills — the permission floor a persona inherits. */
function RoleTiers({ role }: { role: SessionRole }) {
  const cap = roleCapability(role);
  const tiers: [string, string][] = [
    ["git", cap.git], ["github", cap.github], ["code", cap.code], ["net", cap.net],
  ];
  return (
    <Row gap={5} wrap>
      {tiers.map(([k, v]) => (
        <Chip key={k} color={TIER_COLOR[v] ?? "var(--fg-dim)"}>{k} · {v}</Chip>
      ))}
    </Row>
  );
}

export function PersonasPanel() {
  const personas = useAppStore((s) => s.personas);
  const skills = useAppStore((s) => s.skills);
  const addPersona = useAppStore((s) => s.addPersona);
  const clonePersona = useAppStore((s) => s.clonePersona);
  const updatePersona = useAppStore((s) => s.updatePersona);
  const removePersona = useAppStore((s) => s.removePersona);

  const [selectedId, setSelectedId] = useState<string>(personas[0]?.id ?? "");
  const selected = personas.find((p) => p.id === selectedId) ?? personas[0];

  const toggleSkill = (skillId: string) => {
    if (!selected) return;
    const has = selected.skills.includes(skillId);
    updatePersona(selected.id, {
      skills: has ? selected.skills.filter((s) => s !== skillId) : [...selected.skills, skillId],
    });
  };

  return (
    <Row gap={0} style={{ flex: 1, minHeight: 0 }}>
      {/* ── List rail ── */}
      <Stack gap={8} style={{ width: 260, minWidth: 260, padding: 14, overflowY: "auto", borderRight: "1px solid var(--border-soft)" }}>
        <Row align="center" gap={8}>
          <Text as="div" className="ulabel" tone="dim" style={{ flex: 1 }}>personas · {personas.length}</Text>
          <Button variant="ghost" onClick={() => setSelectedId(addPersona())}>+ new</Button>
        </Row>
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

      {/* ── Editor ── */}
      {selected ? (
        <Stack gap={16} style={{ flex: 1, minWidth: 0, padding: 20, overflowY: "auto" }}>
          <Row align="baseline" gap={10}>
            <Text as="h2" size={16} weight={600} style={{ margin: 0, flex: 1 }}>{selected.name || "Untitled persona"}</Text>
            <Button variant="ghost" onClick={() => setSelectedId(clonePersona(selected.id))}>clone</Button>
            {!selected.builtin && (
              <ConfirmButton
                label="delete"
                armedLabel="delete?"
                danger
                onConfirm={() => { removePersona(selected.id); setSelectedId(personas[0]?.id ?? ""); }}
              />
            )}
          </Row>

          <TextField label="Name" value={selected.name} onChange={(v) => updatePersona(selected.id, { name: v })} />
          <TextField label="What it does" value={selected.blurb} onChange={(v) => updatePersona(selected.id, { blurb: v })} placeholder="One line — the job this persona does" />

          <Box>
            <SelectField
              label="Role — the permission floor (edited on Security)"
              value={selected.role}
              onChange={(v) => updatePersona(selected.id, { role: v as SessionRole })}
            >
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </SelectField>
            <Box style={{ marginTop: 6 }}><RoleTiers role={selected.role} /></Box>
          </Box>

          <Box className="field">
            <label>Start prompt</label>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke multi-line prompt editor; TextField is single-line */}
            <textarea
              className="input"
              value={selected.startPrompt}
              onChange={(e) => updatePersona(selected.id, { startPrompt: e.target.value })}
              placeholder="The protocol/prose injected at launch. Empty falls back to the role's own kickoff."
              style={{ width: "100%", minHeight: 150, resize: "vertical", fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.55 }}
            />
          </Box>

          <TextField label="Default model" value={selected.model ?? ""} onChange={(v) => updatePersona(selected.id, { model: v || undefined })} placeholder="empty = session default" />

          <Box>
            <Text as="div" className="ulabel" tone="dim" style={{ marginBottom: 6 }}>attached skills · {selected.skills.length}</Text>
            {skills.length === 0 ? (
              <Text as="div" size={11} tone="dim">No skills in the library yet — author them on the Skills page.</Text>
            ) : (
              <Row gap={6} wrap>
                {skills.map((sk) => {
                  const on = selected.skills.includes(sk.id);
                  return (
                    <Box
                      as="button"
                      key={sk.id}
                      onClick={() => toggleSkill(sk.id)}
                      className="mono"
                      style={{
                        cursor: "pointer", padding: "2px 9px", borderRadius: 99, fontSize: 10.5,
                        color: on ? "var(--accent)" : "var(--fg-muted)",
                        border: "1px solid " + (on ? "var(--accent)" : "var(--border)"),
                        background: on ? "color-mix(in oklch, var(--accent), transparent 88%)" : "transparent",
                      }}
                    >{on ? "✓ " : ""}{sk.name}</Box>
                  );
                })}
              </Row>
            )}
          </Box>
        </Stack>
      ) : (
        <Stack align="center" justify="center" style={{ flex: 1 }}>
          <Text tone="dim">Select or create a persona.</Text>
        </Stack>
      )}
    </Row>
  );
}
