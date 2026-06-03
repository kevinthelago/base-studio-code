import { describe, it, expect } from "vitest";
import { parseSkillLog, aggregateSkillTelemetry } from "../lib/skillTelemetry";

const NOW = new Date("2026-06-02T12:00:00Z"); // today = 2026-06-02; window 05-27..06-02

function log(lines: string[][]): string {
  return lines.map(c => c.join("\t")).join("\n");
}

describe("parseSkillLog", () => {
  it("parses TSV records and skips malformed lines", () => {
    const text = log([
      ["2026-06-02T10:00:00Z", "t0p1", "PreToolUse", "open-a-clean-pr"],
      ["", "", ""],
      ["badline"],
    ]) + "\n   \n";
    const recs = parseSkillLog(text);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toEqual({ ts: "2026-06-02T10:00:00Z", pane: "t0p1", event: "PreToolUse", skill: "open-a-clean-pr" });
  });
});

describe("aggregateSkillTelemetry", () => {
  it("counts invocations, success rate, today, and the 7-day trend", () => {
    const recs = parseSkillLog(log([
      ["2026-06-02T10:00:00Z", "t0p1", "PreToolUse", "open-a-clean-pr"],
      ["2026-06-02T10:01:00Z", "t0p1", "PostToolUse", "open-a-clean-pr"],
      ["2026-06-02T11:00:00Z", "t0p2", "PreToolUse", "open-a-clean-pr"], // 2nd invocation, no success
      ["2026-05-30T09:00:00Z", "t0p1", "PreToolUse", "scaffold-tauri-cmd"],
      ["2026-01-01T00:00:00Z", "t0p1", "PreToolUse", "old-skill"], // outside the 7-day window
    ]));
    const agg = aggregateSkillTelemetry(recs, NOW);

    expect(agg["open-a-clean-pr"]).toEqual({
      invocations: 2, success: 1, successRate: 50, today: 2,
      trend: [0, 0, 0, 0, 0, 0, 2], // last bucket = 2026-06-02
    });
    expect(agg["scaffold-tauri-cmd"]).toMatchObject({ invocations: 1, success: 0, successRate: 0, today: 0 });
    expect(agg["scaffold-tauri-cmd"].trend).toEqual([0, 0, 0, 1, 0, 0, 0]); // 2026-05-30 = index 3
    // Outside the window: still counted in invocations, but not today/trend.
    expect(agg["old-skill"]).toMatchObject({ invocations: 1, today: 0, trend: [0, 0, 0, 0, 0, 0, 0] });
  });

  it("buckets by skill-name slug, so display names and dir slugs merge", () => {
    const agg = aggregateSkillTelemetry(parseSkillLog(log([
      ["2026-06-02T10:00:00Z", "t0p1", "PreToolUse", "Open a clean PR"],
      ["2026-06-02T10:05:00Z", "t0p1", "PreToolUse", "open-a-clean-pr"],
    ])), NOW);
    expect(Object.keys(agg)).toEqual(["open-a-clean-pr"]);
    expect(agg["open-a-clean-pr"].invocations).toBe(2);
  });

  it("clamps success to invocations so the rate never exceeds 100%", () => {
    const agg = aggregateSkillTelemetry(parseSkillLog(log([
      ["2026-06-02T10:00:00Z", "t0p1", "PreToolUse", "x"],
      ["2026-06-02T10:01:00Z", "t0p1", "PostToolUse", "x"],
      ["2026-06-02T10:02:00Z", "t0p1", "PostToolUse", "x"], // stray extra success
    ])), NOW);
    expect(agg["x"].successRate).toBe(100);
    expect(agg["x"].success).toBe(1);
  });
});
