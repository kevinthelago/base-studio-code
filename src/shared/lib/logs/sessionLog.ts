// Per-session log drill-down — pure shaping for the `bsc logs` reads (#1607 slice 3).
//
// The unified log engine lives in `crates/logs` and is reached the SAME way every other frontend log
// surface reaches it: `bsc logs …` over the `bsc` bridge (#2144), never a per-verb Tauri command. This
// module owns only the pure (React-free, unit-testable) shaping of two of those reads —
// `bsc logs sessions --json` (the session picker) and `bsc logs session <id> --json` (one session's
// full, time-merged story across tools/skills/mcp/hooks/perm/coord/activity/done + its cost rollup) —
// so the drill-down card stays a thin renderer. The JSON shapes mirror the crate's serde structs
// (snake_case field names, no `rename_all`): `SessionRow`, `LogEvent`, `Cost`, and the `session`
// command's `{ session, role, events, cost }` envelope.

/** One row of `bsc logs sessions --json` — the crate's `SessionRow` (snake_case). */
export interface LogSessionRow {
  session: string;
  role: string;
  tools: number;
  skills: number;
  mcp: number;
  coord: number;
  cost_usd: number;
  activity: string;
}

/** One normalized event — the crate's `LogEvent`. `stream` is the canonical category key. */
export interface SessionLogEvent {
  ts_ms: number;
  session: string;
  stream: string;
  summary: string;
  fields: string[];
}

/** The token/cost rollup — the crate's `Cost` (snake_case). */
export interface SessionCost {
  session: string;
  model: string;
  input: number;
  output: number;
  cache_creation: number;
  cache_read: number;
  cost_usd: number;
}

/** `bsc logs session <id> --json` — the merged story envelope. `cost` is null when untracked. */
export interface SessionStory {
  session: string;
  role: string;
  events: SessionLogEvent[];
  cost: SessionCost | null;
}

/** The event-category streams a session drill-down surfaces, in display order. Mirrors the crate's
 *  `canonical_stream` targets (minus the writer-only `tokens`, surfaced as the cost rollup instead). */
export const SESSION_STREAMS = [
  "tool",
  "skill",
  "mcp",
  "hook",
  "perm",
  "coord",
  "activity",
  "done",
] as const;
export type SessionStreamKey = (typeof SESSION_STREAMS)[number];

/** Short display label per stream key (the drill-down filter chips + timeline tag). */
export const STREAM_LABEL: Record<string, string> = {
  tool: "Tools",
  skill: "Skills",
  mcp: "MCP",
  hook: "Hooks",
  perm: "Denials",
  coord: "Coord",
  activity: "Activity",
  done: "Done",
};

/** A token per stream key so the timeline + chips read as one system. `perm` (a denial) reads as a
 *  warning; the rest map onto the shared semantic tokens. Unknown keys fall back to the muted tone. */
export const STREAM_TONE: Record<string, string> = {
  tool: "var(--accent)",
  skill: "var(--info)",
  mcp: "var(--success)",
  hook: "var(--fg-muted)",
  perm: "var(--danger)",
  coord: "var(--warning)",
  activity: "var(--fg-dim)",
  done: "var(--success)",
};

export function streamLabel(key: string): string {
  return STREAM_LABEL[key] ?? key;
}

export function streamTone(key: string): string {
  return STREAM_TONE[key] ?? "var(--fg-muted)";
}

/** `ts_ms` → `HH:MM:SS` (UTC), matching the crate CLI's lean-TSV `hms`. A negative/NaN ts clamps to
 *  `00:00:00` rather than throwing, so a malformed row still renders. */
export function eventTime(tsMs: number): string {
  // `trunc` (toward zero), not `floor`, so a small negative ts matches the crate CLI's Rust integer
  // division (`ms/1000`) exactly rather than wrapping to 23:59:59.
  const total = Math.trunc((Number.isFinite(tsMs) ? tsMs : 0) / 1000);
  const s = ((total % 86400) + 86400) % 86400;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** Count events per stream key (every `SESSION_STREAMS` key present, zero-filled). Drives the filter
 *  chip badges + the header summary. */
export function streamCounts(events: SessionLogEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of SESSION_STREAMS) out[k] = 0;
  for (const e of events) out[e.stream] = (out[e.stream] ?? 0) + 1;
  return out;
}

/** Events for the selected stream, newest first (a drill-down reads top-down); `null` ⇒ all streams.
 *  The crate emits ascending-by-time, so we reverse a shallow copy without mutating the input. */
export function filterEvents(events: SessionLogEvent[], stream: string | null): SessionLogEvent[] {
  const kept = stream ? events.filter((e) => e.stream === stream) : events.slice();
  return kept.reverse();
}

/** Total tokens (in + out + both cache buckets) for the cost rollup, or 0 when untracked. */
export function totalTokens(cost: SessionCost | null): number {
  if (!cost) return 0;
  return cost.input + cost.output + cost.cache_creation + cost.cache_read;
}

/** A one-glance rollup of a story: role, total event count, per-stream counts, and USD cost. */
export function summarizeStory(story: SessionStory | null): {
  role: string;
  total: number;
  byStream: Record<string, number>;
  costUsd: number;
  tokens: number;
} {
  const events = story?.events ?? [];
  return {
    role: story?.role ?? "session",
    total: events.length,
    byStream: streamCounts(events),
    costUsd: story?.cost?.cost_usd ?? 0,
    tokens: totalTokens(story?.cost ?? null),
  };
}
