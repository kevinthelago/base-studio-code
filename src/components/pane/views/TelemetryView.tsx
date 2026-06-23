// Telemetry · cost view (#1181) — an INSPECT panel for a console pane, mirroring the
// Console-Shell design's `telemetryBody`: a COST + TOKENS card pair over a rollup table.
// Unlike the design's mock numbers, this reads the pane's REAL per-session totals from the
// `read_token_usage` command (see `usePaneTokenUsage`) — model, tokens in/out, cache, cost.

import type { PaneTokenUsage } from "../../../lib/console/usePaneTokenUsage";

const MONO = "var(--mono)";
const grpLabel: React.CSSProperties = {
  color: "var(--fg-dim)", fontSize: 9.5, letterSpacing: ".08em", fontFamily: MONO,
};

/** Compact a token count: 1_234_567 ⇒ "1.2M", 231_000 ⇒ "231K", 412 ⇒ "412". */
function fmtTok(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "K";
  return String(n);
}

export function TelemetryView({ usage, small }: { usage?: PaneTokenUsage; small?: boolean }) {
  void small;
  // No transcript recorded yet (pane idle, or the agent hasn't taken a turn).
  if (!usage) {
    return (
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 13px", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.7 }}>
        <div style={grpLabel}>TELEMETRY</div>
        <div style={{ marginTop: 8, color: "var(--fg-dim)" }}>
          No session telemetry yet — tokens and cost appear here once the agent takes a turn in this pane.
        </div>
      </div>
    );
  }

  const sessionTok = usage.input_tokens + usage.output_tokens;
  const cost = `$${usage.cost_usd.toFixed(2)}`;
  const rows: [string, string][] = [
    ["Model", usage.model || "—"],
    ["Tokens in", fmtTok(usage.input_tokens)],
    ["Tokens out", fmtTok(usage.output_tokens)],
    ["Cache write", fmtTok(usage.cache_creation_tokens)],
    ["Cache read", fmtTok(usage.cache_read_tokens)],
    ["Session tokens", fmtTok(sessionTok)],
    ["Cost", cost],
  ];

  const card = (label: string, value: string) => (
    <div style={{ padding: 11, background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: 8 }}>
      <div style={grpLabel}>{label}</div>
      <div style={{ color: "var(--fg)", fontSize: 20, fontWeight: 600, marginTop: 3 }}>{value}</div>
    </div>
  );

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 13px", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
        {card("COST", cost)}
        {card("TOKENS", fmtTok(sessionTok))}
      </div>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "5px 2px", borderBottom: "1px solid var(--border-soft)" }}>
          <span style={{ color: "var(--fg-muted)" }}>{k}</span>
          <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}
