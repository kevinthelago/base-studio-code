// The per-stream agent editor for the focused ProjectPane (#1560). AgentEditor edits a stream's
// MODEL + execution FLOW; AgentsA is the roster of agent rows that expand into it. Per-capability
// permissions are NO LONGER per-stream: a worker runs under the Autonomous (trusted) role and the
// director under Read-only review (the unified role→profile model) — the planner only layers extra
// commands on top. The row still shows the role's resolved posture read-only (PostureBar).
import { useState, useEffect } from "react";
import "./projectPane.css";
import type { Flow, Agent } from "./projectPaneData";
import { type ModelId, modelTier, tierToModelId } from "@/app/console/lib/models";
import { Dot, Avatar, RoleChip, PostureBar, Seg } from "./focusedPrimitives";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export function AgentEditor({ a, onFlow, onModel }: {
  a: Agent;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
}) {
  const [flow, setFlow] = useState<Flow>(a.flow);
  const [model, setModel] = useState<ModelId | undefined>(a.model);
  useEffect(() => { setFlow(a.flow); setModel(a.model); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Read-only preview block for the kickoff + lane-context text (#2053).
  const preStyle: React.CSSProperties = {
    margin: 0, maxHeight: 150, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
    fontFamily: "var(--mono)", fontSize: 10, lineHeight: 1.5, color: "var(--fg-muted)",
    background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 5, padding: "8px 9px",
  };
  return (
    <>
      {/* Kickoff preview (#2053) — the exact first message this worker gets at launch, plus its lane
          context (CLAUDE.local.md) collapsed below. Read-only: it mirrors what the launch generates. */}
      <Box style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)" }}>
        <Row className="ulabel" gap={8} style={{ marginBottom: 8 }}>
          <Box as="span">kickoff</Box>
          <Text as="span" mono size={9} tone={a.authoredPrompt ? "accent" : "dim"}>
            {a.authoredPrompt ? "authored" : "generated"}
          </Text>
        </Row>
        {a.authoredPrompt && (
          <Text as="div" mono size={10} tone="muted" style={{ lineHeight: 1.5, marginBottom: 8 }}>
            Launches from an authored kickoff script — <Box as="span" className="glob">{a.authoredPrompt}</Box>. The generated default below is the fallback.
          </Text>
        )}
        <pre style={preStyle}>{a.kickoff}</pre>
        <details style={{ marginTop: 8 }}>
          <summary className="mono" style={{ cursor: "pointer", fontSize: 10, color: "var(--fg-dim)", userSelect: "none" }}>
            Lane context — CLAUDE.local.md
          </summary>
          <pre style={{ ...preStyle, marginTop: 6 }}>{a.scope}</pre>
        </details>
      </Box>

      {onModel && (
        <Box style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)" }}>
          <Box className="ulabel" style={{ marginBottom: 8 }}>model</Box>
          <Row gap={8}>
            <Seg options={["default", "haiku", "sonnet", "opus"]} value={model ? modelTier(model) : "default"}
              onChange={(v) => { const m = v === "default" ? undefined : tierToModelId(v); setModel(m); onModel(a.id, m); }} />
            <Text as="span" mono size={9} tone="dim">
              {model ? `claude --model ${modelTier(model)}` : "uses the global default"}
            </Text>
          </Row>
        </Box>
      )}

      <Box style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
        <Box className="ulabel" style={{ marginBottom: 8 }}>flow</Box>
        <Stack gap={8}>
          <Row gap={8}>
            <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>autonomy</Text>
            <Seg options={["continuous", "checkpoint", "confirm"]} value={flow.autonomy}
              onChange={(v) => { const next = { ...flow, autonomy: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </Row>
          <Row gap={8}>
            <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>push</Text>
            <Seg options={["auto-PR", "push-confirm", "commit-only", "none"]} value={flow.push}
              onChange={(v) => { const next = { ...flow, push: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </Row>
          <Row gap={8}>
            <Text as="span" mono size={10} tone="muted" style={{ flex: "0 0 64px" }}>gate</Text>
            <Seg options={["soft", "hard"]} value={flow.gate}
              onChange={(v) => { const next = { ...flow, gate: v }; setFlow(next); onFlow?.(a.id, next); }} />
            <Text as="span" mono size={9} tone="dim">
              {flow.gate === "hard" ? "blocks on violation" : "warns, continues"}
            </Text>
          </Row>
        </Stack>
      </Box>
    </>
  );
}

export function AgentsA({ agents = [], onFlow, onModel, focusedStream, onSelect }: {
  agents?: Agent[];
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  /** #1392 streams-link: the stream the Streams graph has focused — expand its editor here. */
  focusedStream?: string;
  /** Notify the parent which stream's editor opened/closed, so the graph spotlights it too. */
  onSelect?: (id: string | null) => void;
}) {
  const [open, setOpen] = useState<string | null>((agents.find((a) => a.focus) ?? agents[0])?.id ?? null);
  // When the graph focuses a stream, expand its editor here. Adjusted DURING render (React's
  // recommended alternative to a sync effect) so it's instant + avoids set-state-in-effect.
  const [lastFocused, setLastFocused] = useState(focusedStream);
  if (focusedStream !== lastFocused) {
    setLastFocused(focusedStream);
    if (focusedStream) setOpen(focusedStream);
  }
  const running = agents.filter((a) => a.status === "run").length;
  return (
    <Box style={{ padding: "4px 0" }}>
      <Row className="mono" gap={8} style={{ padding: "0 2px 8px", fontSize: 9.5, color: "var(--fg-dim)" }}>
        <Box as="span">{agents.length} agents · {running} running</Box>
        <Box as="span" style={{ flex: 1 }} />
        <Box as="span" className="mini">+ agent</Box>
      </Row>
      <Stack gap={4}>
        {agents.map((a) => {
          const on = open === a.id;
          return (
            <Box key={a.id} style={{
              borderRadius: 6, overflow: "hidden",
              background: "var(--bg-canvas)",
              border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <Grid onClick={() => { const next = on ? null : a.id; setOpen(next); onSelect?.(next); }}
                cols="auto 1fr auto" gap={8} align="center" style={{ padding: "7px 8px", cursor: "pointer" }}>
                <Row gap={7}>
                  <Dot s={a.status} />
                  <Avatar id={a.id} sz={18} agents={agents} />
                </Row>
                <Box style={{ minWidth: 0 }}>
                  <Row gap={6}>
                    <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>{a.name}</Text>
                    <RoleChip role={a.role} mute />
                  </Row>
                  <Row gap={6} style={{ marginTop: 4 }}>
                    <PostureBar perm={a.perm} />
                    <Text as="span" mono size={9} tone="dim" style={{
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}
                    </Text>
                  </Row>
                </Box>
                <Stack align="end" gap={4}>
                  <Text as="span" mono size={9} tone="muted">{a.preset}</Text>
                  <Box as="span" className={"fbadge" + (a.flow.gate === "hard" ? " hard" : "")}>{a.flow.gate}</Box>
                </Stack>
              </Grid>

              {on && (
                <>
                  <Row className="mono" gap={6} wrap style={{ padding: "7px 10px", borderTop: "1px solid var(--border-soft)", fontSize: 9.5, color: "var(--fg-muted)" }}>
                    <Text as="span" style={{ color: "var(--info)" }}>⎇ {a.repo}</Text>
                    <Text as="span" tone="dim">·</Text>
                    <Box as="span">owns</Box>
                    {a.owns.map((o) => <Box as="span" key={o} className="glob">{o}</Box>)}
                    {a.issues.map((i) => <Text as="span" key={i} tone="accent">{i}</Text>)}
                  </Row>
                  <AgentEditor a={a} onFlow={onFlow} onModel={onModel} />
                </>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
