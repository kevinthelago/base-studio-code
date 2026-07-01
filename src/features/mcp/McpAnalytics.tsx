import { useEffect, useMemo, useState } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { parseMcpLog, aggregateMcpTelemetry, type McpAnalytics, type McpCall } from "./lib/mcpTelemetry";
import { StatCard, StackedDayBars, TelemetryPanel, ItemBars, SplitBar } from "@/shared/ui/charts";

// MCP Analytics tab (#879) — KPI cards + 3 charts + a call-results log over the MCP tool-call
// telemetry (~/.base-studio-code/mcp.log via read_mcp_log + mcpTelemetry.ts). The over-time chart +
// KPI cards are shared primitives (StackedDayBars / StatCard); the per-server/results charts stay local.
// Transport per server is joined from the live extensions store; the rest comes from the parsed log.
// Empty until the bsc-mcp hook pair emits calls (PR 2) — renders a clean zero state.

const DAYS = 14;

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

  const maxServerCalls = Math.max(1, ...an.perServer.map((s) => s.calls));
  const errCount = an.recent.filter((c) => c.outcome === "fail").length;

  return (
    <div style={{ padding: "4px 0 12px" }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 12 }}>
        <StatCard k="Total calls" v={an.total} sub={`last ${DAYS} days`} />
        <StatCard k="Errors" v={an.errors} sub="failed calls" tone="danger" />
        <StatCard k="Success rate" v={`${an.successRate}%`} sub={`${an.ok} ok`} tone="success" />
        <StatCard k="Active servers" v={an.activeServers} sub={`${an.healthyServers} healthy`} />
      </div>

      {/* Calls over time */}
      <StackedDayBars
        data={an.daily.map((d) => ({ day: d.day, upper: d.ok, lower: d.error }))}
        title="Calls over time" subtitle="daily tool calls · ok vs error"
        upperLabel="ok" lowerLabel="error"
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        {/* Calls per server */}
        <TelemetryPanel
          title="Calls per server"
          right={<>
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9.5, color: "var(--fg-muted)" }}><ColorSwatch color="var(--info)" />http</span>
            <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 9.5, color: "var(--fg-muted)" }}><ColorSwatch color="var(--violet, oklch(0.70 0.12 300))" />stdio</span>
          </>}
        >
          <ItemBars
            rows={an.perServer.map((s) => {
              const transport = transportByServer[s.server] ?? "stdio";
              return {
                key: s.server, label: s.server, meta: transport, value: s.calls, fraction: s.calls / maxServerCalls,
                color: transport === "http" ? "var(--info)" : "var(--violet, oklch(0.70 0.12 300))",
              };
            })}
            empty={<span className="hint">No MCP calls recorded yet.</span>}
          />
        </TelemetryPanel>

        {/* Success vs errors */}
        <TelemetryPanel title="Success vs errors" hint="per server">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {an.perServerSplit.length === 0 && <span className="hint">No calls yet.</span>}
            {an.perServerSplit.map((p) => (
              <SplitBar key={p.server} label={p.server} a={p.ok} b={p.errors} aLabel="ok" bLabel="err" />
            ))}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <span className="mono" style={{ color: "var(--fg-muted)" }}>~/.base-studio-code/mcp.log</span> via <span className="mono" style={{ color: "var(--fg-muted)" }}>mcpTelemetry.ts</span> — one line per call (ts · server · tool · outcome · ms).
          </div>
        </TelemetryPanel>
      </div>

      {/* Call results log */}
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
          <h3 className="mono" style={{ margin: 0, fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Call results</h3>
          <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>what servers returned to agents</span>
          <div style={{ flex: 1 }} />
          {errCount > 0 && <span className="mono" style={{ fontSize: 10, color: "var(--danger)" }}>{errCount} errors</span>}
          <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
            {(["all", "ok", "errors"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className="mono"
                style={{
                  fontSize: 10, padding: "3px 9px", border: 0, cursor: "pointer",
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
    <div className="mono" style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderTop: "1px solid var(--border-soft)", fontSize: 10.5 }}>
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
