// StreamFocusCards (#2189) — the focused stream rebuilt as a stack of collapsible cards (the
// "Streams Pane Redesign"). Replaces the monolithic StreamCard/AgentEditor with one CollapsibleCard
// each for Persona · Kickoff · Scope · Model & flow. Persona + Kickoff are default-open (they were
// buried before), and the persona pairing is ALWAYS shown — "Worker (default)" when a stream launches
// with no persona assigned. Uses the app's abstracted primitives (CollapsibleCard, Seg, Chip, Code,
// SelectField, RoleChip) + the #2186 PersonaSummary (rendered flat inside the Persona card).
import { useState } from "react";
import type { Flow, Agent } from "@/features/planner/pane/projectPaneData";
import { type ModelId, modelTier, tierToModelId } from "@/app/console/lib/models";
import { CollapsibleCard } from "./collapsibleCard";
import { RoleChip, Seg } from "@/features/planner/pane/focusedPrimitives";
import { PersonaSummary } from "@/features/personas";
import { Chip } from "@/shared/ui/data/Chip";
import { Code } from "@/shared/ui/data/Code";
import { SelectField } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { useAppStore } from "@/store";

export function StreamFocusCards({ a, onFlow, onModel, onPersona }: {
  a: Agent;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  onPersona?: (streamId: string, personaId: string | undefined) => void;
}) {
  const personas = useAppStore((s) => s.personas);
  const assigned = personas.find((p) => p.id === a.persona);
  // Unassigned ⇒ display the packaged Worker persona so the pairing is never blank; the header still
  // reads "Worker (default)" and the picker value stays "" so nothing is written onto the stream.
  const display = assigned ?? personas.find((p) => p.id === "persona-worker");

  // Local echo of model/flow, resynced when the focused stream changes — adjusted DURING render
  // (React's recommended alternative to a sync effect), which also avoids a set-state-in-effect lint.
  const [flow, setFlow] = useState<Flow>(a.flow);
  const [model, setModel] = useState<ModelId | undefined>(a.model);
  const [lastId, setLastId] = useState(a.id);
  if (a.id !== lastId) { setLastId(a.id); setFlow(a.flow); setModel(a.model); }

  const personaName = assigned ? assigned.name : "Worker (default)";
  const personaRole = display?.role ?? "worker";

  return (
    <Stack gap={12} style={{ marginTop: 14 }}>
      {/* PERSONA — the behavioral identity this stream launches as. */}
      <CollapsibleCard
        title="Persona"
        icon="☺"
        defaultOpen
        right={
          <Row gap={7} align="center">
            <Text as="span" size={11} tone="muted">{personaName}</Text>
            <RoleChip role={personaRole} mute />
          </Row>
        }
      >
        <Stack gap={12}>
          {onPersona && (
            <SelectField
              label="launches as"
              hint="the role sets the permission floor"
              value={a.persona ?? ""}
              onChange={(v) => onPersona(a.id, v || undefined)}
            >
              <option value="">worker (default)</option>
              {personas.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.role}</option>)}
            </SelectField>
          )}
          {display && <PersonaSummary persona={display} flat />}
        </Stack>
      </CollapsibleCard>

      {/* KICKOFF — the exact first message the worker receives at launch (the hero card). */}
      <CollapsibleCard
        title="Kickoff"
        icon="➤"
        iconTone="var(--accent)"
        defaultOpen
        right={a.authoredPrompt ? <Chip color="var(--accent)">authored</Chip> : <Chip>generated</Chip>}
      >
        <Stack gap={11}>
          {a.authoredPrompt && (
            <Text as="div" mono size={10} tone="muted" style={{ lineHeight: 1.5 }}>
              Launches from an authored kickoff script — <Box as="span" className="glob">{a.authoredPrompt}</Box>. The generated default below is the fallback.
            </Text>
          )}
          <Code>{a.kickoff}</Code>
          <details>
            <summary className="mono" style={{ cursor: "pointer", fontSize: 10, color: "var(--fg-dim)", userSelect: "none" }}>
              Lane context — CLAUDE.local.md
            </summary>
            <Code style={{ marginTop: 6 }}>{a.scope}</Code>
          </details>
        </Stack>
      </CollapsibleCard>

      {/* SCOPE — repo · owned globs · issues. */}
      <CollapsibleCard title="Scope" icon="⎇" right={<Text as="span" mono size={9.5} tone="dim">{a.repo}</Text>}>
        <Row className="mono" gap={6} wrap style={{ fontSize: 9.5, color: "var(--fg-muted)" }}>
          <Text as="span" style={{ color: "var(--info)" }}>⎇ {a.repo}</Text>
          <Text as="span" tone="dim">·</Text>
          <Box as="span">owns</Box>
          {a.owns.map((o) => <Box as="span" key={o} className="glob">{o}</Box>)}
          {a.issues.map((i) => <Text as="span" key={i} tone="accent">{i}</Text>)}
        </Row>
      </CollapsibleCard>

      {/* MODEL & FLOW — the per-stream launch knobs. */}
      <CollapsibleCard
        title="Model & flow"
        icon="⚙"
        right={<Text as="span" mono size={9.5} tone="dim">{model ? modelTier(model) : "default model"} · {flow.autonomy}</Text>}
      >
        <Stack gap={14}>
          <Stack gap={6}>
            <Box className="ulabel">model</Box>
            <Row gap={8} align="center">
              <Seg
                options={["default", "haiku", "sonnet", "opus"]}
                value={model ? modelTier(model) : "default"}
                onChange={(v) => { const m = v === "default" ? undefined : tierToModelId(v); setModel(m); onModel?.(a.id, m); }}
              />
              <Text as="span" mono size={9} tone="dim">
                {model ? `claude --model ${modelTier(model)}` : "uses the global default"}
              </Text>
            </Row>
          </Stack>
          <Stack gap={9}>
            <Box className="ulabel">flow</Box>
            <Row gap={8} align="center">
              <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>autonomy</Text>
              <Seg options={["continuous", "checkpoint", "confirm"]} value={flow.autonomy}
                onChange={(v) => { const next = { ...flow, autonomy: v }; setFlow(next); onFlow?.(a.id, next); }} />
            </Row>
            <Row gap={8} align="center">
              <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>push</Text>
              <Seg options={["auto-PR", "push-confirm", "commit-only", "none"]} value={flow.push}
                onChange={(v) => { const next = { ...flow, push: v }; setFlow(next); onFlow?.(a.id, next); }} />
            </Row>
            <Row gap={8} align="center">
              <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>gate</Text>
              <Seg options={["soft", "hard"]} value={flow.gate}
                onChange={(v) => { const next = { ...flow, gate: v }; setFlow(next); onFlow?.(a.id, next); }} />
              <Text as="span" mono size={9} tone="dim">
                {flow.gate === "hard" ? "blocks on violation" : "warns, continues"}
              </Text>
            </Row>
          </Stack>
        </Stack>
      </CollapsibleCard>
    </Stack>
  );
}
