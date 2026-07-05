import { describe, it, expect } from "vitest";
import {
  SESSION_STREAMS,
  eventTime,
  filterEvents,
  streamCounts,
  streamLabel,
  streamTone,
  summarizeStory,
  totalTokens,
  type SessionCost,
  type SessionLogEvent,
  type SessionStory,
} from "./sessionLog";

function ev(ts_ms: number, stream: string, summary = "x"): SessionLogEvent {
  return { ts_ms, session: "k:web", stream, summary, fields: [] };
}

describe("eventTime", () => {
  it("renders epoch-ms as HH:MM:SS UTC (matching the crate CLI's hms)", () => {
    // 1970-01-01T01:02:03Z = (1*3600 + 2*60 + 3) * 1000 ms.
    expect(eventTime((3600 + 120 + 3) * 1000)).toBe("01:02:03");
    expect(eventTime(0)).toBe("00:00:00");
  });
  it("wraps by day and never throws on a malformed ts", () => {
    // 25h wraps to 01:00:00; NaN / negative clamp to 00:00:00 rather than throwing.
    expect(eventTime(25 * 3600 * 1000)).toBe("01:00:00");
    expect(eventTime(Number.NaN)).toBe("00:00:00");
    expect(eventTime(-5)).toBe("00:00:00");
  });
});

describe("streamCounts", () => {
  it("zero-fills every SESSION_STREAMS key and counts present events", () => {
    const counts = streamCounts([ev(1, "tool"), ev(2, "tool"), ev(3, "perm"), ev(4, "coord")]);
    expect(counts.tool).toBe(2);
    expect(counts.perm).toBe(1);
    expect(counts.coord).toBe(1);
    // Absent streams are present as 0, so the chip badges render for the whole set.
    for (const k of SESSION_STREAMS) expect(counts[k]).toBeGreaterThanOrEqual(0);
    expect(counts.skill).toBe(0);
  });
});

describe("filterEvents", () => {
  const events = [ev(10, "tool", "a"), ev(20, "perm", "b"), ev(30, "tool", "c")];
  it("returns all events newest-first when stream is null, without mutating input", () => {
    const out = filterEvents(events, null);
    expect(out.map((e) => e.summary)).toEqual(["c", "b", "a"]);
    // input order preserved (ascending) — the crate emits ascending, we only reverse a copy.
    expect(events.map((e) => e.summary)).toEqual(["a", "b", "c"]);
  });
  it("filters to one stream, newest-first", () => {
    expect(filterEvents(events, "tool").map((e) => e.summary)).toEqual(["c", "a"]);
    expect(filterEvents(events, "perm").map((e) => e.summary)).toEqual(["b"]);
    expect(filterEvents(events, "mcp")).toEqual([]);
  });
});

describe("totalTokens", () => {
  it("sums in/out/both cache buckets, 0 when untracked", () => {
    const cost: SessionCost = { session: "k", model: "m", input: 100, output: 50, cache_creation: 10, cache_read: 5, cost_usd: 0.12 };
    expect(totalTokens(cost)).toBe(165);
    expect(totalTokens(null)).toBe(0);
  });
});

describe("summarizeStory", () => {
  it("rolls up role, total, per-stream counts, cost, and tokens", () => {
    const story: SessionStory = {
      session: "k:web",
      role: "worker",
      events: [ev(1, "tool"), ev(2, "skill"), ev(3, "tool")],
      cost: { session: "k:web", model: "sonnet", input: 200, output: 100, cache_creation: 0, cache_read: 0, cost_usd: 0.34 },
    };
    const s = summarizeStory(story);
    expect(s.role).toBe("worker");
    expect(s.total).toBe(3);
    expect(s.byStream.tool).toBe(2);
    expect(s.byStream.skill).toBe(1);
    expect(s.costUsd).toBeCloseTo(0.34);
    expect(s.tokens).toBe(300);
  });
  it("degrades to a safe empty rollup for a null story (untracked/absent session)", () => {
    const s = summarizeStory(null);
    expect(s).toEqual({ role: "session", total: 0, byStream: streamCounts([]), costUsd: 0, tokens: 0 });
  });
});

describe("stream display metadata", () => {
  it("labels every stream and falls back to the raw key", () => {
    expect(streamLabel("perm")).toBe("Denials");
    expect(streamLabel("tool")).toBe("Tools");
    expect(streamLabel("mystery")).toBe("mystery");
  });
  it("tones every stream with a CSS var and falls back to the muted token", () => {
    expect(streamTone("perm")).toBe("var(--danger)");
    expect(streamTone("mystery")).toBe("var(--fg-muted)");
    // Every canonical stream resolves to a design-token CSS var (no bare colors).
    for (const k of SESSION_STREAMS) expect(streamTone(k)).toMatch(/^var\(--[\w-]+\)$/);
  });
});
