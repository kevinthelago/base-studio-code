import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { parseMcpLog, aggregateMcpTelemetry, type McpAnalytics, type McpCall } from "../../lib/session/mcpTelemetry";

// MCP Analytics tab (#879) — KPI cards + 3 charts + a call-results log over the MCP tool-call
// telemetry (~/.base-studio-code/mcp.log via read_mcp_log + mcpTelemetry.ts). Charts are
// hand-rolled inline SVG (the house style; cf. HookAnalytics.tsx). Transport per server is
// joined from the live extensions store; the rest comes from the parsed log. Empty until the
// bsc-mcp hook pair emits calls (PR 2) — renders a clean zero state.

const DAYS = 14;

function Kpi({ label, value, sub, color }: { label: string; value: React.ReactNode; sub: string; color?: string }) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: color ?? "var(--fg)", marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);
const fmtClock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

export function McpAnalyticsTab() {
  // Transport per server, joined by name from the live store (the log carries only the name).
  // Derived via useMemo so the selector returns a stable object (a fresh map each render would
  // trip useSyncExternalStore's snapshot-stability check → infinite loop).
  const mcpServers = useAppStore((s) => s.mcpServers);
  const transportByServer = useMemo(() => {
    const m: Record<string, string> = {};
    for (const e of mcpServers) m[e.name] = e.transport ?? "stdio";
    return m;
  }, [mcpServers]);

  const [an, setAn] = useState<McpAnalytics | null>(null);
  const [filter, setFilter] = useState<"all" | "ok" | "errors">("all");
  useEffect(() => {
    let cancelled = false;
    invoke<string[]>("read_mcp_log", { limit: 8000 })
      .then((lines) => { if (!cancelled) setAn(aggregateMcpTelemetry(parseMcpLog((lines ?? []).join("\n")), new Date(), DAYS)); })
      .catch(() => { if (!cancelled) setAn(aggregateMcpTelemetry([], new Date(), DAYS)); });
    return () => { cancelled = true; };
  }, []);

  const recent = useMemo(() => {
    const list = an?.recent ?? [];
    if (filter === "errors") return list.filter((c) => c.outcome === "fail");
    if (filter === "ok") return list.filter((c) => c.outcome !== "fail");
    return list;
  }, [an, filter]);

  if (!an) return <div className="hint" style={{ padding: 16 }}>Loading MCP telemetry…</div>;

  // ── Calls-over-time chart geometry (stacked ok/error bars) ──
  const W = 600, H = 160, x0 = 30, baseY = 140, topY = 12;
  const maxTotal = Math.max(1, ...an.daily.map((d) => d.ok + d.error));
  const bw = (W - x0 - 10) / DAYS;
  const scaleY = (v: number) => (v / maxTotal) * (baseY - topY);
  const gridVals = [0, Math.ceil(maxTotal / 2), maxTotal];

  const maxServerCalls = Math.max(1, ...an.perServer.map((s) => s.calls));
  const errCount = an.recent.filter((c) => c.outcome === "fail").length;

  return (
    <div style={{ padding: "4px 0 12px" }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 12 }}>
        <Kpi label="Total calls" value={an.total} sub={`last ${DAYS} days`} />
        <Kpi label="Errors" value={an.errors} sub="failed calls" color="var(--danger)" />
        <Kpi label="Success rate" value={`${an.successRate}%`} sub={`${an.ok} ok`} color="var(--success)" />
        <Kpi label="Active servers" value={an.activeServers} sub={`${an.healthyServers} healthy`} />
      </div>

      {/* Calls over time */}
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Calls over time</h3>
          <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>daily tool calls · ok vs error</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--accent)" }} />ok</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--danger)" }} />error</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", fontFamily: "var(--mono)" }}>
          {gridVals.map((v, i) => {
            const y = baseY - scaleY(v);
            return (
              <g key={i}>
                <line x1={x0} y1={y} x2={W - 8} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                <text x={x0 - 6} y={y + 3} textAnchor="end" fill="var(--fg-dim)" fontSize={9}>{v}</text>
              </g>
            );
          })}
          {an.daily.map((d, i) => {
            const x = x0 + 4 + i * bw;
            const w = bw - 5;
            const hErr = scaleY(d.error);
            const hOk = scaleY(d.ok);
            const yErr = baseY - hErr;
            const yOk = yErr - hOk;
            const showLabel = i % 3 === 0;
            return (
              <g key={i}>
                {hErr > 0 && <rect x={x} y={yErr} width={w} height={hErr} rx={2} fill="var(--danger)" />}
                {hOk > 0 && <rect x={x} y={yOk} width={w} height={hOk} rx={2} fill="var(--accent)" />}
                {showLabel && <text x={x + w / 2} y={152} textAnchor="middle" fill="var(--fg-dim)" fontSize={8.5}>{d.day.slice(5)}</text>}
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        {/* Calls per server */}
        <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Calls per server</h3>
            <div style={{ flex: 1 }} />
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--info)" }} />http</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--violet, oklch(0.70 0.12 300))" }} />stdio</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {an.perServer.length === 0 && <span className="hint">No MCP calls recorded yet.</span>}
            {an.perServer.map((s) => {
              const transport = transportByServer[s.server] ?? "stdio";
              const c = transport === "http" ? "var(--info)" : "var(--violet, oklch(0.70 0.12 300))";
              return (
                <div key={s.server}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{s.server}</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{transport}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{s.calls}</span>
                  </div>
                  <div style={{ height: 8, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(s.calls / maxServerCalls) * 100}%`, background: c, borderRadius: 99 }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Success vs errors */}
        <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Success vs errors</h3>
            <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>per server</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {an.perServerSplit.length === 0 && <span className="hint">No calls yet.</span>}
            {an.perServerSplit.map((p) => {
              const tot = Math.max(1, p.ok + p.errors);
              return (
                <div key={p.server}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{p.server}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--success)" }}>{p.ok} ok</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{p.errors} err</span>
                  </div>
                  <div style={{ height: 10, borderRadius: 99, overflow: "hidden", display: "flex", background: "var(--bg-elev2)" }}>
                    <div style={{ height: "100%", width: `${(p.ok / tot) * 100}%`, background: "var(--success)" }} />
                    <div style={{ height: "100%", width: `${(p.errors / tot) * 100}%`, background: "var(--danger)" }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>~/.base-studio-code/mcp.log</span> via <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>mcpTelemetry.ts</span> — one line per call (ts · server · tool · outcome · ms).
          </div>
        </div>
      </div>

      {/* Call results log */}
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Call results</h3>
          <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>what servers returned to agents</span>
          <div style={{ flex: 1 }} />
          {errCount > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{errCount} errors</span>}
          <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
            {(["all", "ok", "errors"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  fontFamily: "var(--mono)", fontSize: 10, padding: "3px 9px", border: 0, cursor: "pointer",
                  background: filter === f ? "var(--bg-elev2)" : "transparent",
                  color: filter === f ? "var(--fg)" : "var(--fg-dim)",
                }}
              >{f === "all" ? "All" : f === "ok" ? "OK" : "Errors"}</button>
            ))}
          </div>
        </div>
        {recent.length === 0 ? (
          <span className="hint">No calls recorded yet — the MCP call log fills as agents use these servers.</span>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {recent.map((c, i) => <CallRow key={i} c={c} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function CallRow({ c }: { c: McpCall }) {
  const dot = c.outcome === "fail" ? "var(--danger)" : c.outcome === "warn" ? "var(--accent)" : "var(--success)";
  const label = c.outcome === "fail" ? "fail" : c.outcome === "warn" ? "warn" : "ok";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: "1px solid var(--border-soft)", fontFamily: "var(--mono)", fontSize: 10.5 }}>
      <span style={{ color: "var(--fg-dim)", width: 56 }}>{fmtClock(c.ts)}</span>
      <span style={{ color: "var(--fg)", whiteSpace: "nowrap" }}>{c.server}<span style={{ color: "var(--fg-muted)" }}>.{c.tool}</span></span>
      <span style={{ flex: 1, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.detail && `→ ${c.detail}`}</span>
      <span style={{ color: "var(--fg-muted)" }}>{c.ms ? fmtMs(c.ms) : "—"}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: dot, width: 44, justifyContent: "flex-end" }}>
        <span style={{ width: 6, height: 6, borderRadius: 99, background: dot }} />{label}
      </span>
    </div>
  );
}
