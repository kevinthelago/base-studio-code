// Telemetry · cost view (#1181) — an INSPECT panel for a console pane, mirroring the
// Console-Shell design's `telemetryBody`: a COST + TOKENS card pair over a rollup table.
// Unlike the design's mock numbers, this reads the pane's REAL per-session totals from the
// `read_token_usage` command (see `usePaneTokenUsage`) — model, tokens in/out, cache, cost.

import type { PaneTokenUsage } from "@/app/console/lib/usePaneTokenUsage";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";

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
      <Box pad={[12, 13]} style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.7 }}>
        <Text as="div" style={grpLabel}>TELEMETRY</Text>
        <Text as="div" tone="dim" style={{ marginTop: 8 }}>
          No session telemetry yet — tokens and cost appear here once the agent takes a turn in this pane.
        </Text>
      </Box>
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
    <Box pad={11} bg="var(--bg-canvas)" border="soft" radius={8}>
      <Text as="div" style={grpLabel}>{label}</Text>
      <Text as="div" size={20} weight={600} style={{ color: "var(--fg)", marginTop: 3 }}>{value}</Text>
    </Box>
  );

  return (
    <Box pad={[12, 13]} style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)" }}>
      <Grid cols={2} gap={8} style={{ marginBottom: 10 }}>
        {card("COST", cost)}
        {card("TOKENS", fmtTok(sessionTok))}
      </Grid>
      {rows.map(([k, v]) => (
        <Row key={k} justify="between" gap={12} align="stretch" style={{ padding: "5px 2px", borderBottom: "1px solid var(--border-soft)" }}>
          <Text tone="muted">{k}</Text>
          <Text style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</Text>
        </Row>
      ))}
    </Box>
  );
}
