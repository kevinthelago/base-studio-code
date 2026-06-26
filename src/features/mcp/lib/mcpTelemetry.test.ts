import { describe, it, expect } from "vitest";
import { parseMcpLog, aggregateMcpTelemetry } from "./mcpTelemetry";

const NOW = new Date("2026-06-15T12:00:00Z");
const day = (n: number) => NOW.getTime() - n * 86_400_000;
const line = (ts: number, server: string, tool: string, outcome: string, ms: number, detail = "") =>
  [ts, server, tool, outcome, ms, detail].filter((_, i) => i < 5 || detail).join("\t");

describe("parseMcpLog", () => {
  it("parses ts/server/tool/outcome/ms + optional detail, skipping malformed lines", () => {
    const text = [
      line(day(0), "GitHub", "list_issues", "ok", 412),
      line(day(0), "Playwright", "navigate", "fail", 30, "spawn npx ENOENT"),
      "",
      "garbage",
      "123\t\tno-server",            // missing server/tool → skipped
    ].join("\n");
    const calls = parseMcpLog(text);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ server: "GitHub", tool: "list_issues", outcome: "ok", ms: 412, detail: "" });
    expect(calls[1]).toMatchObject({ server: "Playwright", tool: "navigate", outcome: "fail", ms: 30, detail: "spawn npx ENOENT" });
  });

  it("coerces an unknown outcome to ok and a bad ms to 0", () => {
    const [c] = parseMcpLog(line(day(0), "S", "t", "weird", Number.NaN));
    expect(c.outcome).toBe("ok");
    expect(c.ms).toBe(0);
  });
});

describe("aggregateMcpTelemetry", () => {
  it("counts totals, errors, and success rate (warn counts as success)", () => {
    const calls = parseMcpLog([
      line(day(1), "GitHub", "a", "ok", 100),
      line(day(1), "GitHub", "b", "warn", 1800, "slow · rate-limited"),
      line(day(1), "Playwright", "c", "fail", 20, "ENOENT"),
      line(day(2), "GitHub", "d", "ok", 90),
    ].join("\n"));
    const an = aggregateMcpTelemetry(calls, NOW);
    expect(an.total).toBe(4);
    expect(an.errors).toBe(1);          // only fail
    expect(an.ok).toBe(3);              // ok + warn
    expect(an.successRate).toBe(75);    // 3/4
  });

  it("drops calls outside the window and zero-fills the daily buckets", () => {
    const calls = parseMcpLog([
      line(day(1), "S", "t", "ok", 10),
      line(day(40), "S", "t", "ok", 10),   // outside 14d
    ].join("\n"));
    const an = aggregateMcpTelemetry(calls, NOW, 14);
    expect(an.total).toBe(1);
    expect(an.daily).toHaveLength(14);
    expect(an.daily.reduce((s, d) => s + d.ok + d.error, 0)).toBe(1);
  });

  it("ranks calls per server and splits ok vs errors", () => {
    const calls = parseMcpLog([
      ...Array(5).fill(0).map(() => line(day(1), "GitHub", "x", "ok", 10)),
      line(day(1), "GitHub", "x", "fail", 10),
      line(day(1), "Sentry", "y", "ok", 10),
    ].join("\n"));
    const an = aggregateMcpTelemetry(calls, NOW);
    expect(an.perServer.map((s) => [s.server, s.calls])).toEqual([["GitHub", 6], ["Sentry", 1]]);
    const gh = an.perServerSplit.find((s) => s.server === "GitHub")!;
    expect(gh).toMatchObject({ ok: 5, errors: 1 });
  });

  it("counts active and healthy servers (≤10% error rate = healthy)", () => {
    const calls = parseMcpLog([
      ...Array(9).fill(0).map(() => line(day(1), "GitHub", "x", "ok", 10)),
      line(day(1), "GitHub", "x", "fail", 10),         // 1/10 = 10% → healthy
      line(day(1), "Playwright", "y", "fail", 10),     // 1/1 = 100% → unhealthy
    ].join("\n"));
    const an = aggregateMcpTelemetry(calls, NOW);
    expect(an.activeServers).toBe(2);
    expect(an.healthyServers).toBe(1);
  });

  it("returns recent calls newest-first for the call log", () => {
    const calls = parseMcpLog([
      line(day(3), "A", "t", "ok", 1),
      line(day(1), "B", "t", "ok", 1),
      line(day(2), "C", "t", "ok", 1),
    ].join("\n"));
    const an = aggregateMcpTelemetry(calls, NOW);
    expect(an.recent.map((c) => c.server)).toEqual(["B", "C", "A"]);
  });

  it("is all-zero / 100% on an empty log", () => {
    const an = aggregateMcpTelemetry([], NOW);
    expect(an).toMatchObject({ total: 0, errors: 0, ok: 0, successRate: 100, activeServers: 0, healthyServers: 0 });
    expect(an.daily).toHaveLength(14);
  });
});
