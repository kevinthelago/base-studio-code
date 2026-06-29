// The focused MCP Servers stage (#878, split from FocusedBodies.tsx #1757): the project's MCP
// servers as one expandable card each — transport + install status, an enable toggle, the launch
// command, and the fleet scope it's granted to. A first-party server downloads on assign; its
// "build" button runs the toolchain build (uv/pnpm) before the fleet can use it. An enabled,
// project-scoped server reaches the director AND every worker.
import { useState } from "react";
import { useExpandable } from "@/shared/hooks/useExpandable";
import type { McpServer } from "@/features/planner/pane/projectPaneData";
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

export function FocusedMcpBody({ servers, onToggle, onBuild, onAdd, onRemove }: McpHandlers & {
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
      <div style={{ fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, color: c ?? "var(--fg)" }}>{v}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em", marginTop: 1 }}>{k}</div>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {tile(<>{ready}<span style={{ fontSize: 11, color: "var(--fg-dim)" }}> / {list.length}</span></>, "ready", "var(--success)")}
        {tile(list.filter((s) => s.enabled).length, "enabled")}
        {tile(errored, errored === 1 ? "needs attention" : "need attention", errored ? "var(--danger)" : undefined)}
      </div>

      {list.length === 0 && (
        <div className="empty-state"><span className="empty-icon">⊕</span><span>No MCP servers yet — assign one below or have the planner add it</span></div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
                <span style={{
                  width: 24, height: 24, borderRadius: 6, display: "grid", placeItems: "center", flex: "0 0 24px",
                  fontFamily: "var(--mono)", fontSize: 12, color: tr.c,
                  border: `1px solid color-mix(in oklch, ${tr.c}, transparent 55%)`,
                }}>{(s.name[0] ?? "?").toUpperCase()}</span>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0, cursor: "pointer" }} onClick={() => toggleOpen(s.id)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{s.name}</span>
                    {s.official && <span className="chip" style={{ fontSize: 8 }}>official</span>}
                    {!s.official && s.downloadable && <span className="chip" style={{ fontSize: 8 }}>first-party</span>}
                    <span className="chip" style={{ fontSize: 8, color: tr.c, borderColor: `color-mix(in oklch, ${tr.c}, transparent 70%)` }}>{tr.label}</span>
                  </span>
                  {s.desc && <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.desc}</span>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <span className={"sdot " + stat.dot} style={s.status === "error" ? { background: "var(--danger)" } : undefined} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: stat.c }}>{stat.label}</span>
                  </span>
                  <span className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "granted to the fleet" : "disabled"} onClick={() => onToggle?.(s.id)} />
                </div>
              </div>

              {isErr && s.err && (
                <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "0 12px 10px" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--danger)" }}>⚠ {s.err}</span>
                  <span style={{ flex: 1 }} />
                  <button className="mini" onClick={() => onBuild?.(s)}>retry build</button>
                </div>
              )}

              {isOpen && (
                <div style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginBottom: 4 }}>command</div>
                  <div style={{
                    fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", background: "var(--bg-elev)",
                    border: "1px solid var(--border-soft)", borderRadius: 6, padding: "6px 9px", marginBottom: 11,
                    overflowX: "auto", whiteSpace: "nowrap",
                  }}><span style={{ color: "var(--accent)" }}>$ </span>{s.cmd || "—"}</div>

                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", marginBottom: 6 }}>scope · {s.scope}</div>
                  {s.agents.length > 0 ? (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 11 }}>
                      {s.agents.map((id) => (
                        <span key={id} style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg)", padding: "2px 8px", borderRadius: 99, background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>@{id}</span>
                      ))}
                    </div>
                  ) : (
                    <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", marginBottom: 11 }}>not wired yet — enable to grant the fleet access</div>
                  )}

                  <div style={{ display: "flex", gap: 7 }}>
                    {s.downloadable && s.status !== "ready" && (
                      <button className="mini accent" disabled={busy(s)} onClick={() => onBuild?.(s)}>
                        {s.status === "downloading" ? "downloading…" : s.status === "building" ? "building…" : s.status === "available" ? "download + build" : "build"}
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button className="mini" onClick={() => onRemove?.(s.id)}>remove</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 7 }}>
        <input
          className="input"
          placeholder="＋ add an MCP server — catalog name, command, or remote URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}
          style={{ flex: 1, height: 28, fontSize: 10.5 }}
        />
        <button className="mini accent" disabled={!draft.trim()} onClick={() => { if (draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}>add</button>
      </div>
    </div>
  );
}
