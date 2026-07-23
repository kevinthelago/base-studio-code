import { useEffect, useMemo, useState } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { logsTail } from "@/shared/lib/core/logsBridge";
import { useAppStore } from "@/store";
import { parseMcpLog, aggregateMcpTelemetry, type McpAnalytics, type McpCall } from "./lib/mcpTelemetry";
import { StatCard, StackedDayBars, TelemetryPanel, ItemBars, SplitBar } from "@/shared/ui/charts";
import { Grid } from "@/shared/ui/layout/Grid";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Skeleton, SkeletonChart } from "@/shared/ui/feedback/Skeleton";
import { CardEmpty } from "@/shared/ui/feedback/CardStates";
import { fmtClock } from "@/shared/lib/core/format";

// MCP Analytics tab (#879) — KPI cards + 3 charts + a call-results log over the MCP tool-call
// telemetry (~/.base-studio-code/mcp.log via `bsc logs tail mcp` + mcpTelemetry.ts). The over-time chart +
// KPI cards are shared primitives (StackedDayBars / StatCard); the per-server/results charts stay local.
// Transport per server is joined from the live extensions store; the rest comes from the parsed log.
// Empty until the bsc-mcp hook pair emits calls (PR 2) — renders a clean zero state.

const DAYS = 14;

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`);

/** A stack of shimmer bar-rows (label line + track) — a loading placeholder for a per-server bar card (#2246). */
function SkeletonBars({ rows = 4 }: { rows?: number }) {
  return (
    <Stack gap={14}>
      {Array.from({ length: rows }).map((_, i) => (
        <Box key={i}>
          <Skeleton h={11} w="40%" style={{ marginBottom: 6 }} />
          <Skeleton h={8} radius={4} />
        </Box>
      ))}
    </Stack>
  );
}

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
    logsTail("mcp", 8000)
      .then((lines) => { if (!cancelled) setAn(aggregateMcpTelemetry(parseMcpLog((lines ?? []).join("\n")), new Date(), DAYS)); });
    return () => { cancelled = true; };
  }, []);

  const recent = useMemo(() => {
    const list = an?.recent ?? [];
    if (filter === "errors") return list.filter((c) => c.outcome === "fail");
    if (filter === "ok") return list.filter((c) => c.outcome !== "fail");
    return list;
  }, [an, filter]);

  // The card LAYOUT always renders (#2246) — each async card body shows a loading skeleton (while the
  // log query is in flight) or a compact empty state (no telemetry yet), rather than a page-wide
  // "Loading…" line that hides the whole surface.
  const loading = an === null;
  const maxServerCalls = an ? Math.max(1, ...an.perServer.map((s) => s.calls)) : 1;
  const errCount = an ? an.recent.filter((c) => c.outcome === "fail").length : 0;

  return (
    <Box style={{ padding: "4px 0 12px" }}>
      {/* KPI cards */}
      <Grid cols={4} gap={8} style={{ marginBottom: 12 }}>
        <StatCard k="Total calls" v={an?.total ?? 0} sub={`last ${DAYS} days`} loading={loading} />
        <StatCard k="Errors" v={an?.errors ?? 0} sub="failed calls" tone="danger" loading={loading} />
        <StatCard k="Success rate" v={`${an?.successRate ?? 0}%`} sub={`${an?.ok ?? 0} ok`} tone="success" loading={loading} />
        <StatCard k="Active servers" v={an?.activeServers ?? 0} sub={`${an?.healthyServers ?? 0} healthy`} loading={loading} />
      </Grid>

      {/* Calls over time */}
      {loading ? (
        <Box style={{ marginBottom: 10 }}>
          <TelemetryPanel title="Calls over time" hint="daily tool calls · ok vs error"><SkeletonChart height={160} /></TelemetryPanel>
        </Box>
      ) : an.total === 0 ? (
        <Box style={{ marginBottom: 10 }}>
          <TelemetryPanel title="Calls over time" hint="daily tool calls · ok vs error">
            <CardEmpty title="No calls yet" hint="Daily tool-call volume appears once agents use these servers." />
          </TelemetryPanel>
        </Box>
      ) : (
        <StackedDayBars
          data={an.daily.map((d) => ({ day: d.day, upper: d.ok, lower: d.error }))}
          title="Calls over time" subtitle="daily tool calls · ok vs error"
          upperLabel="ok" lowerLabel="error"
        />
      )}

      <Grid cols={2} gap={10} style={{ marginBottom: 10 }}>
        {/* Calls per server */}
        <TelemetryPanel
          title="Calls per server"
          right={<>
            <Row inline gap={5} className="mono" style={{ fontSize: 9.5, color: "var(--fg-muted)" }}><ColorSwatch color="var(--info)" />http</Row>
            <Row inline gap={5} className="mono" style={{ fontSize: 9.5, color: "var(--fg-muted)" }}><ColorSwatch color="var(--violet, oklch(0.70 0.12 300))" />stdio</Row>
          </>}
        >
          {loading ? <SkeletonBars /> : (
            <ItemBars
              rows={an.perServer.map((s) => {
                const transport = transportByServer[s.server] ?? "stdio";
                return {
                  key: s.server, label: s.server, meta: transport, value: s.calls, fraction: s.calls / maxServerCalls,
                  color: transport === "http" ? "var(--info)" : "var(--violet, oklch(0.70 0.12 300))",
                };
              })}
              empty={<Text as="span" className="hint">No MCP calls recorded yet.</Text>}
            />
          )}
        </TelemetryPanel>

        {/* Success vs errors */}
        <TelemetryPanel title="Success vs errors" hint="per server">
          {loading ? <SkeletonBars rows={3} /> : (
            <Stack gap={14}>
              {an.perServerSplit.length === 0 && <Text as="span" className="hint">No calls yet.</Text>}
              {an.perServerSplit.map((p) => (
                <SplitBar key={p.server} label={p.server} a={p.ok} b={p.errors} aLabel="ok" bLabel="err" />
              ))}
            </Stack>
          )}
          <Box style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <Text as="span" mono tone="muted">~/.base-studio-code/mcp.log</Text> via <Text as="span" mono tone="muted">mcpTelemetry.ts</Text> — one line per call (ts · server · tool · outcome · ms).
          </Box>
        </TelemetryPanel>
      </Grid>

      {/* Call results log */}
      <Box pad={[14, 16]} bg="var(--bg-panel)" border="soft" radius={8}>
        <Row align="baseline" gap={10} style={{ marginBottom: 12 }}>
          <Text as="h3" mono size="sm" weight={600} style={{ margin: 0, color: "var(--fg)" }}>Call results</Text>
          <Text as="span" size={10.5} tone="dim">what servers returned to agents</Text>
          <Spacer />
          {errCount > 0 && <Text as="span" mono size={10} tone="danger">{errCount} errors</Text>}
          <Row inline align="stretch" style={{ border: "1px solid var(--border-soft)", borderRadius: 6, overflow: "hidden" }}>
            {(["all", "ok", "errors"] as const).map((f) => (
              // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled segmented filter (custom bg/color/border container); Button or SegmentedControl would change the rendering
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
          </Row>
        </Row>
        {loading ? (
          <Stack gap={6}>
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={22} radius={5} />)}
          </Stack>
        ) : recent.length === 0 ? (
          <Text as="span" className="hint">No calls recorded yet — the MCP call log fills as agents use these servers.</Text>
        ) : (
          <Stack>
            {recent.map((c, i) => <CallRow key={i} c={c} />)}
          </Stack>
        )}
      </Box>
    </Box>
  );
}

function CallRow({ c }: { c: McpCall }) {
  const dot = c.outcome === "fail" ? "var(--danger)" : c.outcome === "warn" ? "var(--accent)" : "var(--success)";
  const label = c.outcome === "fail" ? "fail" : c.outcome === "warn" ? "warn" : "ok";
  return (
    <Row className="mono" gap={10} style={{ padding: "6px 0", borderTop: "1px solid var(--border-soft)", fontSize: 10.5 }}>
      <Box as="span" style={{ color: "var(--fg-dim)", width: 56 }}>{fmtClock(c.ts, { seconds: true })}</Box>
      <Box as="span" style={{ color: "var(--fg)", whiteSpace: "nowrap" }}>{c.server}<Text as="span" tone="muted">.{c.tool}</Text></Box>
      <Box as="span" style={{ flex: 1, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.detail && `→ ${c.detail}`}</Box>
      <Text as="span" tone="muted">{c.ms ? fmtMs(c.ms) : "—"}</Text>
      <Row inline justify="end" gap={5} style={{ color: dot, width: 44 }}>
        <Box as="span" bg={dot} radius={99} style={{ width: 6, height: 6}} />{label}
      </Row>
    </Row>
  );
}
