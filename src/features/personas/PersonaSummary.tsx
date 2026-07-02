// PersonaSummary (#2186) — the read-only identity card for the persona a stream launches as. The
// Streams pane lets you PICK a persona (agentEditor's SelectField) but never showed WHAT you picked:
// a persona's blurb, default model, attached skills, and start prompt were invisible behind the
// dropdown label. This surfaces that identity so you can see exactly what the agent will BE before
// launch. Presentational + read-only — editing a persona still happens on the Personas tab.
import { useAppStore } from "@/store";
import type { Persona } from "./lib/persona";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";

export function PersonaSummary({ persona }: { persona: Persona }) {
  // Resolve attached skill ids → names from the live Skills library; fall back to the raw id when a
  // referenced skill isn't in the library (a stale/planned reference) so nothing silently disappears.
  const skills = useAppStore((s) => s.skills);
  const skillNames = persona.skills.map((id) => skills.find((sk) => sk.id === id)?.name ?? id);
  return (
    <Box bg="var(--bg-panel)" radius={5} pad={[9, 10]} style={{ marginTop: 8, border: "1px solid var(--border-soft)" }}>
      <Stack gap={8}>
        {persona.blurb && (
          <Text as="div" mono size={10} tone="muted" style={{ lineHeight: 1.5 }}>{persona.blurb}</Text>
        )}

        <Row gap={8} wrap align="center">
          <Text as="span" className="ulabel" tone="dim">model</Text>
          <Text as="span" mono size={9.5} tone={persona.model ? "accent" : "dim"}>
            {persona.model || "session default"}
          </Text>
        </Row>

        <Box>
          <Text as="div" className="ulabel" tone="dim" style={{ marginBottom: 5 }}>
            skills · {skillNames.length}
          </Text>
          {skillNames.length === 0 ? (
            <Text as="div" mono size={9.5} tone="dim">none attached</Text>
          ) : (
            <Row gap={5} wrap>
              {skillNames.map((name, i) => (
                <Chip key={persona.skills[i]}>{name}</Chip>
              ))}
            </Row>
          )}
        </Box>

        <details>
          <summary className="mono" style={{ cursor: "pointer", fontSize: 10, color: "var(--fg-dim)", userSelect: "none" }}>
            Start prompt
          </summary>
          {persona.startPrompt ? (
            <Code style={{ marginTop: 6 }}>{persona.startPrompt}</Code>
          ) : (
            <Text as="div" mono size={9.5} tone="dim" style={{ marginTop: 6, lineHeight: 1.5 }}>
              No start prompt — falls back to the {persona.role} role's own kickoff assembly at launch.
            </Text>
          )}
        </details>
      </Stack>
    </Box>
  );
}
