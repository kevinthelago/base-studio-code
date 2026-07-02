// Blueprint Author — 3 · CAPABILITIES (disposition · skills · MCP). Per-stage
// expandable rows wiring each stage's output disposition, attached skills, and
// attached MCP servers.

import { useExpandable } from "@/shared/hooks/useExpandable";
import { Sparkles } from "lucide-react";
import { Ic } from "@/features/planner/blueprints/blueprintIcons";
import { hue, tint, DISPOSITIONS, DISPOSITION_KEYS } from "@/features/planner/blueprints/blueprintCatalog";
import {
  setOutput, addSkill, removeSkill, addMcpServer, removeMcpServer,
} from "@/features/planner/blueprints/blueprintEdit";
import { Card } from "@/shared/ui/data/Card";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { BlueprintStage } from "@/features/planner/stages/blueprints";
import { StageGlyph, Lbl, type AuthorViewProps } from "./shared";

export function CapabilitiesView({ bp, onChange, skillLibrary = [], mcpLibrary = [] }: AuthorViewProps) {
  const stages = bp.sections ?? [];
  const { open, toggle } = useExpandable(stages[0] ? [stages[0].uid] : []);
  const setSections = (next: BlueprintStage[]) => onChange({ ...bp, sections: next });

  const totalSkills = new Set(stages.flatMap((s) => s.skills ?? [])).size;
  const totalMcp = new Set(stages.flatMap((s) => s.mcp ?? [])).size;

  return (
    <Stack gap={12}>
      <Box className="stats" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: 4 }}>
        <Box className="stat"><Text as="div" className="sk">stages</Text><Text as="div" className="sv">{stages.length}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">skills wired</Text><Text as="div" className="sv">{totalSkills}</Text></Box>
        <Box className="stat"><Text as="div" className="sk">MCP wired</Text><Text as="div" className="sv">{totalMcp}</Text></Box>
      </Box>

      {stages.map((s) => {
        const isOpen = open.has(s.uid);
        const attachedSkills = s.skills ?? [];
        const attachedMcp = s.mcp ?? [];
        const addableSkills = skillLibrary.filter((sk) => !attachedSkills.includes(sk.id));
        const addableMcp = mcpLibrary.filter((m) => !attachedMcp.includes(m.id));
        return (
          <Card key={s.uid} style={{ padding: 0, overflow: "hidden" }}>
            <Row gap={10} style={{ padding: "11px 13px", cursor: "pointer" }} onClick={() => toggle(s.uid)}>
              <StageGlyph k={s.key} />
              <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                <Text as="span" className="mono-value">{s.name}</Text>
                <Box as="span" style={{ fontSize: 10, color: "var(--fg-dim)", display: "flex", gap: 8 }}>
                  <Text as="span">{attachedSkills.length} skill{attachedSkills.length !== 1 ? "s" : ""}</Text>
                  <Text as="span">{attachedMcp.length} MCP</Text>
                  <Text as="span">→ {DISPOSITIONS[s.output ?? ""]?.title ?? "plan file"}</Text>
                </Box>
              </Stack>
              <Text as="span" size={10} className="dim mono">{isOpen ? "▼" : "▶"}</Text>
            </Row>

            {isOpen && (
              <Box style={{ padding: "0 13px 14px", borderTop: "1px solid var(--border-soft)" }}>
                <Lbl style={{ marginTop: 13 }} hint="what happens to the artifact">Output disposition</Lbl>
                <Box className="disp-grid">
                  {DISPOSITION_KEYS.map((key) => {
                    const d = DISPOSITIONS[key];
                    return (
                      <Box className={"disp" + (s.output === key ? " on" : "")} key={key} onClick={() => setSections(setOutput(stages, s.uid, key))}>
                        <Box as="span" className="dgl" bg={tint(d.h, 0.16)} style={{ color: hue(d.h) }}><Ic n={d.glyph} size={13} /></Box>
                        <Box as="span" className="dtxt"><Text as="div" className="dt">{d.title}</Text><Text as="div" className="dd">{d.desc}</Text></Box>
                      </Box>
                    );
                  })}
                </Box>

                <Lbl style={{ marginTop: 18 }} hint="injected context for this stage"><Sparkles size={12} style={{ verticalAlign: "-2px", marginRight: 5, opacity: 0.85 }} />Skills &amp; knowledge</Lbl>
                {attachedSkills.length === 0 && <Box className="hint" style={{ marginBottom: 8 }}>No skills attached.</Box>}
                {attachedSkills.length > 0 && (
                  <Box className="dep-row" style={{ marginBottom: 8 }}>
                    {attachedSkills.map((id) => {
                      const sk = skillLibrary.find((x) => x.id === id);
                      return (
                        <Box as="span" className="dep-chip on" key={id} title={sk?.desc}>
                          {sk && <Text as="span" className="dim" size={8.5}>{sk.kind} </Text>}{sk?.name ?? id}
                          <Box as="span" style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setSections(removeSkill(stages, s.uid, id))}> ✕</Box>
                        </Box>
                      );
                    })}
                  </Box>
                )}
                {addableSkills.length > 0 && (
                  <Box className="pipe-add">
                    {addableSkills.map((sk) => (
                      // eslint-disable-next-line no-restricted-syntax -- bespoke .chip-sug add-skill suggestion (not .btn family)
                      <button className="chip-sug" key={sk.id} title={sk.desc} onClick={() => setSections(addSkill(stages, s.uid, sk.id))}>+ {sk.name}</button>
                    ))}
                  </Box>
                )}

                <Lbl style={{ marginTop: 18 }} hint="tools this stage's agents can call">MCP servers</Lbl>
                {attachedMcp.length === 0 && <Box className="hint" style={{ marginBottom: 8 }}>No MCP servers attached.</Box>}
                {attachedMcp.length > 0 && (
                  <Box className="dep-row" style={{ marginBottom: 8 }}>
                    {attachedMcp.map((name) => (
                      <Box as="span" className="dep-chip on" key={name} title={mcpLibrary.find((m) => m.id === name)?.desc}>
                        {name}
                        <Box as="span" style={{ cursor: "pointer", opacity: 0.8 }} onClick={() => setSections(removeMcpServer(stages, s.uid, name))}> ✕</Box>
                      </Box>
                    ))}
                  </Box>
                )}
                {addableMcp.length > 0 && (
                  <Box className="pipe-add">
                    {addableMcp.map((m) => (
                      // eslint-disable-next-line no-restricted-syntax -- bespoke .chip-sug add-MCP suggestion (not .btn family)
                      <button className="chip-sug" key={m.id} title={m.desc} onClick={() => setSections(addMcpServer(stages, s.uid, m.id))}>+ {m.name}</button>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </Card>
        );
      })}
    </Stack>
  );
}
