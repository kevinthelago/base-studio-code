// The focused MCP Servers stage (#878, split from FocusedBodies.tsx #1757): the project's MCP
// servers as one expandable card each — transport + install status, an enable toggle, the launch
// command, and the fleet scope it's granted to. A first-party server downloads on assign; its
// "build" button runs the toolchain build (uv/pnpm) before the fleet can use it. An enabled,
// project-scoped server reaches the director AND every worker.
import { useState } from "react";
import { useExpandable } from "@/shared/hooks/useExpandable";
import type { McpServer } from "@/features/planner/pane/projectPaneData";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import type { McpHandlers } from "./focusedHandlers";

const MCP_TRANSPORT: Record<string, { c: string; label: string }> = {
  stdio: { c: "oklch(0.72 0.10 230)", label: "stdio" },
  http:  { c: "oklch(0.80 0.14 70)",  label: "http" },
};
const MCP_STATUS: Record<McpServer["status"], { c: string; dot: string; label: string }> = {
  ready:       { c: "var(--success)", dot: "on",   label: "ready" },
  downloaded:  { c: "var(--fg-muted)", dot: "idle", label: "downloaded · build to run" },
  available:   { c: "var(--fg-dim)",  dot: "idle", label: "available · download to run" },
  downloading: { c: "var(--info)",    dot: "run",  label: "downloading…" },
  building:    { c: "var(--info)",    dot: "run",  label: "building…" },
  error:       { c: "var(--danger)",  dot: "",     label: "build failed" },
};

export function McpsBody({ servers, onToggle, onBuild, onAdd, onRemove }: McpHandlers & {
  servers?: McpServer[];
}) {
  const list = servers ?? [];
  const { open, toggle: toggleOpen } = useExpandable();
  const [draft, setDraft] = useState("");

  const ready = list.filter((s) => s.enabled && s.status === "ready").length;
  const errored = list.filter((s) => s.enabled && s.status === "error").length;
  const busy = (s: McpServer) => s.status === "downloading" || s.status === "building";

  const tile = (v: React.ReactNode, k: string, c?: string) => (
    <div style={{ flex: 1, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "8px 11px" }}>
      <div className="mono" style={{ fontSize: 18, fontWeight: 600, color: c ?? "var(--fg)" }}>{v}</div>
      <div className="mono" style={{ fontSize: 9, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em", marginTop: 1 }}>{k}</div>
    </div>
  );

  return (
    <Stack gap={12}>
      <Row gap={8} align="stretch">
        {tile(<>{ready}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}> / {list.length}</span></>, "ready", "var(--success)")}
        {tile(list.filter((s) => s.enabled).length, "enabled")}
        {tile(errored, errored === 1 ? "needs attention" : "need attention", errored ? "var(--danger)" : undefined)}
      </Row>

      {list.length === 0 && (
        <div className="empty-state"><span className="empty-icon">⊕</span><span>No MCP servers yet — assign one below or have the planner add it</span></div>
      )}

      <Stack gap={8}>
        {list.map((s) => {
          const tr = MCP_TRANSPORT[s.transport] ?? MCP_TRANSPORT.stdio;
          const stat = MCP_STATUS[s.status];
          const isOpen = open.has(s.id);
          const isErr = s.enabled && s.status === "error";
          return (
            <div key={s.id} style={{
              borderRadius: 9, background: "var(--bg-canvas)", overflow: "hidden",
              border: "1px solid " + (isErr ? "color-mix(in oklch, var(--danger), transparent 60%)" : isOpen ? "var(--border)" : "var(--border-soft)"),
              opacity: s.enabled ? 1 : 0.72,
            }}>
              <Row gap={10} style={{ padding: "10px 12px" }}>
                <span className="mono" style={{
                  width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", flex: "0 0 24px",
                  fontSize: 12, color: tr.c,
                  border: `1px solid color-mix(in oklch, ${tr.c}, transparent 55%)`,
                }}>{(s.name[0] ?? "?").toUpperCase()}</span>
                <Stack gap={3} onClick={() => toggleOpen(s.id)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                  <Row gap={7}>
                    <span className="mono-value">{s.name}</span>
                    {s.official && <span className="chip" style={{ fontSize: 8 }}>official</span>}
                    {!s.official && s.downloadable && <span className="chip" style={{ fontSize: 8 }}>first-party</span>}
                    <span className="chip" style={{ fontSize: 8, color: tr.c, borderColor: `color-mix(in oklch, ${tr.c}, transparent 70%)` }}>{tr.label}</span>
                  </Row>
                  {s.desc && <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.desc}</span>}
                </Stack>
                <Stack align="end" gap={5}>
                  <Row gap={5}>
                    <span className={"sdot " + stat.dot} style={s.status === "error" ? { background: "var(--danger)" } : undefined} />
                    <span className="mono" style={{ fontSize: 9.5, color: stat.c }}>{stat.label}</span>
                  </Row>
                  <span className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "granted to the fleet" : "disabled"} onClick={() => onToggle?.(s.id)} />
                </Stack>
              </Row>

              {isErr && s.err && (
                <Row gap={7} style={{ padding: "0 12px 10px" }}>
                  <span className="mono" style={{ fontSize: 9.5, color: "var(--danger)" }}>⚠ {s.err}</span>
                  <Spacer />
                  <button className="mini" onClick={() => onBuild?.(s)}>retry build</button>
                </Row>
              )}

              {isOpen && (
                <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div className="mono" style={{ fontSize: 9, color: "var(--fg-dim)", marginBottom: 4 }}>command</div>
                  <div className="mono" style={{
                    fontSize: 10, color: "var(--fg-muted)", background: "var(--bg-elev)",
                    border: "1px solid var(--border-soft)", borderRadius: 6, padding: "6px 9px", marginBottom: 11,
                    overflowX: "auto", whiteSpace: "nowrap",
                  }}><span style={{ color: "var(--accent)" }}>$ </span>{s.cmd || "—"}</div>

                  <div className="mono" style={{ fontSize: 9, color: "var(--fg-dim)", marginBottom: 6 }}>scope · {s.scope}</div>
                  {s.agents.length > 0 ? (
                    <Row gap={6} wrap align="stretch" style={{ marginBottom: 11 }}>
                      {s.agents.map((id) => (
                        <span key={id} className="mono" style={{ fontSize: 9.5, color: "var(--fg)", padding: "2px 8px", borderRadius: 99, background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>@{id}</span>
                      ))}
                    </Row>
                  ) : (
                    <div className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 11 }}>not wired yet — enable to grant the fleet access</div>
                  )}

                  <Row gap={7} align="stretch">
                    {s.downloadable && s.status !== "ready" && (
                      <button className="mini accent" disabled={busy(s)} onClick={() => onBuild?.(s)}>
                        {s.status === "downloading" ? "downloading…" : s.status === "building" ? "building…" : s.status === "available" ? "download + build" : "build"}
                      </button>
                    )}
                    <Spacer />
                    <button className="mini" onClick={() => onRemove?.(s.id)}>remove</button>
                  </Row>
                </div>
              )}
            </div>
          );
        })}
      </Stack>

      <Row gap={7} align="stretch">
        <input
          className="input"
          placeholder="＋ add an MCP server — catalog name, command, or remote URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}
          style={{ flex: 1, height: 28, fontSize: 10.5 }}
        />
        <button className="mini accent" disabled={!draft.trim()} onClick={() => { if (draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}>add</button>
      </Row>
    </Stack>
  );
}
