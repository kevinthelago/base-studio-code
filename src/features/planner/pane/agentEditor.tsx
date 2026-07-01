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

export function AgentEditor({ a, onFlow, onModel }: {
  a: Agent;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
}) {
  const [flow, setFlow] = useState<Flow>(a.flow);
  const [model, setModel] = useState<ModelId | undefined>(a.model);
  useEffect(() => { setFlow(a.flow); setModel(a.model); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <>
      {onModel && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)" }}>
          <div className="ulabel" style={{ marginBottom: 8 }}>model</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Seg options={["default", "haiku", "sonnet", "opus"]} value={model ? modelTier(model) : "default"}
              onChange={(v) => { const m = v === "default" ? undefined : tierToModelId(v); setModel(m); onModel(a.id, m); }} />
            <span className="mono" style={{ fontSize: 9, color: "var(--fg-dim)" }}>
              {model ? `claude --model ${modelTier(model)}` : "uses the global default"}
            </span>
          </div>
        </div>
      )}

      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
        <div className="ulabel" style={{ marginBottom: 8 }}>flow</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ flex: "0 0 64px", fontSize: 10, color: "var(--fg-muted)" }}>autonomy</span>
            <Seg options={["continuous", "checkpoint", "confirm"]} value={flow.autonomy}
              onChange={(v) => { const next = { ...flow, autonomy: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ flex: "0 0 64px", fontSize: 10, color: "var(--fg-muted)" }}>push</span>
            <Seg options={["auto-PR", "push-confirm", "commit-only", "none"]} value={flow.push}
              onChange={(v) => { const next = { ...flow, push: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="mono" style={{ flex: "0 0 64px", fontSize: 10, color: "var(--fg-muted)" }}>gate</span>
            <Seg options={["soft", "hard"]} value={flow.gate}
              onChange={(v) => { const next = { ...flow, gate: v }; setFlow(next); onFlow?.(a.id, next); }} />
            <span className="mono" style={{ fontSize: 9, color: "var(--fg-dim)" }}>
              {flow.gate === "hard" ? "blocks on violation" : "warns, continues"}
            </span>
          </div>
        </div>
      </div>
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
    <div style={{ padding: "4px 0" }}>
      <div className="mono" style={{
        display: "flex", alignItems: "center", gap: 8, padding: "0 2px 8px",
        fontSize: 9.5, color: "var(--fg-dim)",
      }}>
        <span>{agents.length} agents · {running} running</span>
        <span style={{ flex: 1 }} />
        <span className="mini">+ agent</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {agents.map((a) => {
          const on = open === a.id;
          return (
            <div key={a.id} style={{
              borderRadius: 6, overflow: "hidden",
              background: "var(--bg-canvas)",
              border: "1px solid " + (on ? "var(--accent-dim)" : "var(--border-soft)"),
            }}>
              <div onClick={() => { const next = on ? null : a.id; setOpen(next); onSelect?.(next); }} style={{
                display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8,
                alignItems: "center", padding: "7px 8px", cursor: "pointer",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                  <Dot s={a.status} />
                  <Avatar id={a.id} sz={18} agents={agents} />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="mono" style={{ fontSize: 11, color: "var(--fg)" }}>{a.name}</span>
                    <RoleChip role={a.role} mute />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <PostureBar perm={a.perm} />
                    <span className="mono" style={{
                      fontSize: 9, color: "var(--fg-dim)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <span className="mono" style={{ fontSize: 9, color: "var(--fg-muted)" }}>{a.preset}</span>
                  <span className={"fbadge" + (a.flow.gate === "hard" ? " hard" : "")}>{a.flow.gate}</span>
                </div>
              </div>

              {on && (
                <>
                  <div className="mono" style={{
                    display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
                    padding: "7px 10px", borderTop: "1px solid var(--border-soft)",
                    fontSize: 9.5, color: "var(--fg-muted)",
                  }}>
                    <span style={{ color: "var(--info)" }}>⎇ {a.repo}</span>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span>owns</span>
                    {a.owns.map((o) => <span key={o} className="glob">{o}</span>)}
                    {a.issues.map((i) => <span key={i} style={{ color: "var(--accent)" }}>{i}</span>)}
                  </div>
                  <AgentEditor a={a} onFlow={onFlow} onModel={onModel} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
