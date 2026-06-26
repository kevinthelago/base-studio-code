// The per-stream agent-permissions widget for the focused ProjectPane (#1560, split verbatim out of
// FocusedBodies.tsx). AgentEditor is the expandable capability/model/flow editor; AgentsA is the
// roster of agent rows that expand into it. Used by the Permissions + Streams stage bodies.
import { useState, useEffect } from "react";
import "./projectPane.css";
import type { Posture, Perm, Flow, Agent } from "./projectPaneData";
import { type ModelId, modelTier, tierToModelId } from "@/app/console/lib/models";
import { Dot, Avatar, RoleChip, PostureBar, Tri, Seg, CAPS } from "./focusedPrimitives";

const PRESETS: Record<string, Perm> = {
  Plan:   { read: "allow", edit: "deny",  create: "deny",  run: "ask",   net: "ask",   push: "deny",  pkg: "deny" },
  Build:  { read: "allow", edit: "allow", create: "allow", run: "allow", net: "ask",   push: "ask",   pkg: "ask" },
  Review: { read: "allow", edit: "deny",  create: "deny",  run: "allow", net: "deny",  push: "deny",  pkg: "deny" },
  Triage: { read: "allow", edit: "deny",  create: "ask",   run: "deny",  net: "allow", push: "deny",  pkg: "deny" },
  Full:   { read: "allow", edit: "allow", create: "allow", run: "allow", net: "allow", push: "allow", pkg: "allow" },
};

export function AgentEditor({ a, onPerm, onPreset, onFlow, onModel }: {
  a: Agent;
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
}) {
  const [perm, setPerm] = useState<Perm>(a.perm);
  const [preset, setPreset] = useState(a.preset);
  const [flow, setFlow] = useState<Flow>(a.flow);
  const [model, setModel] = useState<ModelId | undefined>(a.model);
  useEffect(() => { setPerm(a.perm); setPreset(a.preset); setFlow(a.flow); setModel(a.model); }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: Posture) => {
    const next = { ...perm, [k]: v };
    setPerm(next); setPreset("custom");
    onPerm?.(a.id, next);
  };
  const applyPreset = (p: string) => {
    const next = { ...PRESETS[p] };
    setPreset(p); setPerm(next);
    onPreset?.(a.id, p, next);
  };
  return (
    <>
      <div style={{ padding: "9px 12px", borderTop: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
          <span className="ulabel">preset</span>
          <span style={{ flex: 1 }} />
          {preset === "custom" && <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--accent)" }}>● customized</span>}
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
          {Object.keys(PRESETS).map((p) => (
            <span key={p} className={"preset" + (preset === p ? " on" : "")}
              onClick={() => applyPreset(p)}>{p}</span>
          ))}
        </div>
      </div>

      <div style={{ padding: "6px 12px 10px", borderTop: "1px solid var(--border-soft)" }}>
        <div className="ulabel" style={{ padding: "5px 0 7px" }}>capabilities</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {CAPS.map((c) => (
            <div key={c.k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 16, textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>{c.g}</span>
              <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg)" }}>{c.label}</span>
              <Tri value={perm[c.k]} onChange={(v) => set(c.k, v)} />
            </div>
          ))}
        </div>
      </div>

      {onModel && (
        <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)" }}>
          <div className="ulabel" style={{ marginBottom: 8 }}>model</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Seg options={["default", "haiku", "sonnet", "opus"]} value={model ? modelTier(model) : "default"}
              onChange={(v) => { const m = v === "default" ? undefined : tierToModelId(v); setModel(m); onModel(a.id, m); }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
              {model ? `claude --model ${modelTier(model)}` : "uses the global default"}
            </span>
          </div>
        </div>
      )}

      <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border-soft)", background: "var(--bg-panel)" }}>
        <div className="ulabel" style={{ marginBottom: 8 }}>flow</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>autonomy</span>
            <Seg options={["continuous", "checkpoint", "confirm"]} value={flow.autonomy}
              onChange={(v) => { const next = { ...flow, autonomy: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>push</span>
            <Seg options={["auto-PR", "push-confirm", "commit-only", "none"]} value={flow.push}
              onChange={(v) => { const next = { ...flow, push: v }; setFlow(next); onFlow?.(a.id, next); }} />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: "0 0 64px", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>gate</span>
            <Seg options={["soft", "hard"]} value={flow.gate}
              onChange={(v) => { const next = { ...flow, gate: v }; setFlow(next); onFlow?.(a.id, next); }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)" }}>
              {flow.gate === "hard" ? "blocks on violation" : "warns, continues"}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

export function AgentsA({ agents = [], onPerm, onPreset, onFlow, onModel, focusedStream, onSelect }: {
  agents?: Agent[];
  onPerm?: (streamId: string, perm: Perm) => void;
  onPreset?: (streamId: string, preset: string, perm: Perm) => void;
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
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "0 2px 8px",
        fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)",
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
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{a.name}</span>
                    <RoleChip role={a.role} mute />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                    <PostureBar perm={a.perm} />
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)",
                      whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      {a.owns[0]}{a.owns.length > 1 ? ` +${a.owns.length - 1}` : ""}
                    </span>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-muted)" }}>{a.preset}</span>
                  <span className={"fbadge" + (a.flow.gate === "hard" ? " hard" : "")}>{a.flow.gate}</span>
                </div>
              </div>

              {on && (
                <>
                  <div style={{
                    display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap",
                    padding: "7px 10px", borderTop: "1px solid var(--border-soft)",
                    fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)",
                  }}>
                    <span style={{ color: "var(--info)" }}>⎇ {a.repo}</span>
                    <span style={{ color: "var(--fg-dim)" }}>·</span>
                    <span>owns</span>
                    {a.owns.map((o) => <span key={o} className="glob">{o}</span>)}
                    {a.issues.map((i) => <span key={i} style={{ color: "var(--accent)" }}>{i}</span>)}
                  </div>
                  <AgentEditor a={a} onPerm={onPerm} onPreset={onPreset} onFlow={onFlow} onModel={onModel} />
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
