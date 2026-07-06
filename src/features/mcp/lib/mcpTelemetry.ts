// MCP-call telemetry (#879) — parse + aggregate the MCP tool-call log for the MCP Analytics
// tab. Mirrors hookTelemetry.ts. The log lives at ~/.base-studio-code/mcp.log, one TSV line
// per call: `ts \t pane \t server \t tool \t outcome \t ms \t detail` (#1743 prepended the pane
// column). Legacy lines written before #1743 have no pane (`ts \t server \t tool \t outcome \t
// ms [\t detail]`) and are still tolerated — the parser detects the shape by column count.
// Read newest-first via `bsc logs tail mcp`. `outcome` is "ok" | "warn" | "fail"; `ms` is the round-trip latency of the
// call (the agent invoking the MCP tool → the server's response). A "warn" is a successful but
// slow / rate-limited call, so it counts toward SUCCESS (only "fail" is an error). Pure +
// unit-tested; the hook pair that EMITS these lines is wired separately (PR 2).

import { dayKey } from "@/shared/lib/core/format";

export type McpOutcome = "ok" | "warn" | "fail";

export interface McpCall {
  /** epoch ms */
  ts: number;
  /** the MCP server name (the `<server>` in `mcp__<server>__<tool>`) */
  server: string;
  /** the tool name */
  tool: string;
  outcome: McpOutcome;
  /** round-trip latency of the call, in ms */
  ms: number;
  /** optional human detail (error text / "slow · rate-limited") shown in the call log */
  detail: string;
}

/** Parse the TSV MCP-call log into records, skipping malformed lines. */
export function parseMcpLog(text: string): McpCall[] {
  const out: McpCall[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    // #1743: new lines carry a leading pane column (7 fields: ts·pane·server·tool·outcome·ms·detail);
    // legacy lines have none (5–6 fields: ts·server·tool·outcome·ms[·detail]). Detect by column count
    // and offset the field reads so both shapes parse. The pane isn't surfaced here (the analytics
    // don't break down by session), so it's read past, not stored.
    const b = parts.length >= 7 ? 1 : 0;
    const [tsRaw, server, tool, outcomeRaw, msRaw] = [parts[0], parts[b + 1], parts[b + 2], parts[b + 3], parts[b + 4]];
    const ts = Number(tsRaw);
    if (!Number.isFinite(ts) || !server || !tool) continue;
    const outcome: McpOutcome = outcomeRaw === "fail" ? "fail" : outcomeRaw === "warn" ? "warn" : "ok";
    const ms = Number(msRaw);
    out.push({
      ts, server, tool, outcome,
      ms: Number.isFinite(ms) ? ms : 0,
      detail: parts.slice(b + 5).join("\t").trim(),
    });
  }
  return out;
}

export interface McpDayBucket { day: string; ok: number; error: number; }
export interface McpServerCount { server: string; calls: number; }
export interface McpServerSplit { server: string; ok: number; errors: number; }

export interface McpAnalytics {
  /** total calls in the window */
  total: number;
  /** failed calls (outcome === "fail") */
  errors: number;
  /** successful calls (ok + warn) */
  ok: number;
  /** ok / total, 0–100; 100 when there are no calls */
  successRate: number;
  /** distinct servers with at least one call in the window */
  activeServers: number;
  /** active servers whose error rate is at/below the healthy threshold */
  healthyServers: number;
  /** per-day ok (ok + warn) vs error counts, oldest→newest, length === days */
  daily: McpDayBucket[];
  /** calls per server, descending */
  perServer: McpServerCount[];
  /** ok (ok + warn) vs error per server, descending by total */
  perServerSplit: McpServerSplit[];
  /** recent calls, newest first (for the call-results log) */
  recent: McpCall[];
}

const DAY_MS = 86_400_000;
/** A server is "healthy" when at most this fraction of its calls failed. */
const HEALTHY_ERR_RATE = 0.1;

/**
 * Aggregate MCP calls into the analytics the MCP Analytics tab renders. Only calls within the
 * last `days` (relative to `now`) are counted. `daily` always has exactly `days` buckets
 * (zero-filled), oldest→newest, so the chart has a stable x-axis. `recent` is the newest
 * `recentLimit` calls for the call-results log.
 */
export function aggregateMcpTelemetry(calls: McpCall[], now: Date, days = 14, recentLimit = 100): McpAnalytics {
  const end = now.getTime();
  const start = end - days * DAY_MS;
  const inWindow = calls.filter((c) => c.ts >= start && c.ts <= end);

  const daily: McpDayBucket[] = [];
  const idxByDay = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(end - i * DAY_MS);
    idxByDay.set(key, daily.length);
    daily.push({ day: key, ok: 0, error: 0 });
  }

  let errors = 0;
  const perServerMap = new Map<string, McpServerCount>();
  const perSplitMap = new Map<string, McpServerSplit>();

  for (const c of inWindow) {
    const isErr = c.outcome === "fail";
    if (isErr) errors++;

    const bucket = idxByDay.get(dayKey(c.ts));
    if (bucket != null) {
      if (isErr) daily[bucket].error++;
      else daily[bucket].ok++;
    }

    const sc = perServerMap.get(c.server) ?? { server: c.server, calls: 0 };
    sc.calls++;
    perServerMap.set(c.server, sc);

    const sp = perSplitMap.get(c.server) ?? { server: c.server, ok: 0, errors: 0 };
    if (isErr) sp.errors++; else sp.ok++;
    perSplitMap.set(c.server, sp);
  }

  const perServer = [...perServerMap.values()].sort((a, b) => b.calls - a.calls);
  const perServerSplit = [...perSplitMap.values()].sort((a, b) => (b.ok + b.errors) - (a.ok + a.errors));
  const healthyServers = perServerSplit.filter((s) => {
    const t = s.ok + s.errors;
    return t > 0 && s.errors / t <= HEALTHY_ERR_RATE;
  }).length;
  const total = inWindow.length;
  const ok = total - errors;
  // Recent calls newest-first: the log is read newest-first, but guard for any order.
  const recent = [...inWindow].sort((a, b) => b.ts - a.ts).slice(0, recentLimit);

  return {
    total,
    errors,
    ok,
    successRate: total > 0 ? Math.round((ok / total) * 100) : 100,
    activeServers: perServerMap.size,
    healthyServers,
    daily,
    perServer,
    perServerSplit,
    recent,
  };
}
