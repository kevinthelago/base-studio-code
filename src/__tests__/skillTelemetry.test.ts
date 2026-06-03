import { describe, it, expect } from "vitest";
import {
  parseSkillLog, aggregateSkillLog, skillStatsFromLog, successRate, emptyStats,
} from "../lib/skillTelemetry";

// A fixed "now": 2026-06-03T12:00:00 local. Build day-relative timestamps off it so
// the test is deterministic regardless of when it runs.
const NOW = new Date(2026, 5, 3, 12, 0, 0).getTime();
const DAY = 86_400_000;
function daysAgo(n: number, h = 10): number {
  const d = new Date(NOW - n * DAY);
  d.setHours(h, 0, 0, 0);
  return d.getTime();
}

describe("parseSkillLog", () => {
  it("parses well-formed lines and drops malformed ones", () => {
    const raw = [
      `${daysAgo(0)} · t0p1 · PreToolUse · open-a-clean-pr`,
      "garbage line with no separators",
      `${daysAgo(0)} · t0p1 · PostToolUse · open-a-clean-pr`,
      "  ", // blank
    ].join("\n");
    const lines = parseSkillLog(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ pane: "t0p1", event: "PreToolUse", skill: "open-a-clean-pr" });
  });

  it("accepts epoch-seconds and ISO timestamps", () => {
    const iso = new Date(NOW).toISOString();
    const raw = `${Math.floor(NOW / 1000)} · p · PreToolUse · a\n${iso} · p · PreToolUse · b`;
    const lines = parseSkillLog(raw);
    expect(lines).toHaveLength(2);
    expect(Math.abs(lines[0].ts - NOW)).toBeLessThan(1000);
  });
});

describe("aggregateSkillLog", () => {
  it("counts invocations (Pre), success (Post), today, and the 7-day trend", () => {
    const raw = [
      `${daysAgo(0)} · p · PreToolUse · pr`,    // today invocation
      `${daysAgo(0)} · p · PostToolUse · pr`,   // today success
      `${daysAgo(0)} · p · PreToolUse · pr`,    // another today invocation
      `${daysAgo(2)} · p · PreToolUse · pr`,    // 2 days ago
      `${daysAgo(9)} · p · PreToolUse · pr`,    // outside the 7-day window
    ].join("\n");
    const stats = aggregateSkillLog(parseSkillLog(raw), NOW);
    const pr = stats["pr"];
    expect(pr.invocations).toBe(4);
    expect(pr.success).toBe(1);
    expect(pr.today).toBe(2);
    // trend length 7, today = last bucket.
    expect(pr.trend).toHaveLength(7);
    expect(pr.trend[6]).toBe(2);  // today
    expect(pr.trend[4]).toBe(1);  // 2 days ago
    // The 9-day-ago invocation is counted in invocations but not the trend window.
    expect(pr.trend.reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("keeps separate buckets per skill", () => {
    const raw = `${daysAgo(0)} · p · PreToolUse · a\n${daysAgo(0)} · p · PreToolUse · b`;
    const stats = aggregateSkillLog(parseSkillLog(raw), NOW);
    expect(stats["a"].invocations).toBe(1);
    expect(stats["b"].invocations).toBe(1);
  });
});

describe("successRate / emptyStats", () => {
  it("is 0 for a never-invoked skill (no NaN)", () => {
    expect(successRate(emptyStats())).toBe(0);
  });
  it("is success/invocations otherwise", () => {
    const s = skillStatsFromLog(
      `${daysAgo(0)} · p · PreToolUse · x\n${daysAgo(0)} · p · PreToolUse · x\n${daysAgo(0)} · p · PostToolUse · x`,
      NOW,
    );
    expect(successRate(s["x"])).toBeCloseTo(0.5);
  });
});
