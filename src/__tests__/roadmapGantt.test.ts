import { describe, it, expect } from "vitest";
import {
  buildGantt, windowStartFrom, weeksBetween, tickIntervalWeeks,
  type GhMilestone,
} from "../screens/projects/roadmapGantt";

const NOW = new Date("2026-06-01T00:00:00Z");
const WEEK = 7 * 24 * 3600 * 1000;

const ms = (over: Partial<GhMilestone>): GhMilestone => ({
  number: 1, title: "M", description: null, state: "open",
  due_on: null, created_at: "2026-05-01T00:00:00Z",
  open_issues: 0, closed_issues: 0, creator: null, ...over,
});

describe("weeksBetween / tickIntervalWeeks", () => {
  it("counts whole weeks forward, clamped at 0", () => {
    expect(weeksBetween(new Date("2026-01-01"), new Date("2026-01-15"))).toBe(2);
    expect(weeksBetween(new Date("2026-02-01"), new Date("2026-01-01"))).toBe(0);
  });

  it("widens the tick interval as the span grows", () => {
    expect(tickIntervalWeeks(8)).toBe(1);
    expect(tickIntervalWeeks(40)).toBe(4);
    expect(tickIntervalWeeks(200)).toBe(13);
  });
});

describe("windowStartFrom", () => {
  it("returns null for the all-time window", () => {
    expect(windowStartFrom(null)).toBeNull();
  });
  it("returns now minus N weeks", () => {
    expect(windowStartFrom(4, NOW)!.getTime()).toBe(NOW.getTime() - 4 * WEEK);
  });
});

describe("buildGantt", () => {
  it("returns an empty model when there are no milestones", () => {
    const m = buildGantt([], null, NOW);
    expect(m.rows).toEqual([]);
    expect(m.totalWeeks).toBe(8);
  });

  it("excludes milestones that ended before the window", () => {
    const wStart = windowStartFrom(28, NOW); // ~2025-11-17
    const old = ms({ number: 1, created_at: "2025-01-01T00:00:00Z", due_on: "2025-03-01T00:00:00Z" });
    const recent = ms({ number: 2, created_at: "2026-05-01T00:00:00Z", due_on: "2026-05-20T00:00:00Z" });
    const { rows } = buildGantt([old, recent], wStart, NOW);
    expect(rows.map(r => r.id)).toEqual(["2"]);
  });

  it("pins the origin to the window edge and clamps an earlier-starting bar", () => {
    const wStart = windowStartFrom(28, NOW)!;
    const spanning = ms({ number: 2, created_at: "2025-10-01T00:00:00Z", due_on: "2026-07-01T00:00:00Z" });
    const { rows, origin } = buildGantt([spanning], wStart, NOW);
    expect(origin.getTime()).toBe(wStart.getTime());
    expect(rows[0].startWeek).toBe(0); // began before the window → clamped to the left edge
  });

  it("keeps everything and origins at the earliest start for the all-time window", () => {
    const old = ms({ number: 1, created_at: "2025-01-01T00:00:00Z", due_on: "2025-03-01T00:00:00Z" });
    const recent = ms({ number: 2, created_at: "2026-05-01T00:00:00Z", due_on: "2026-05-20T00:00:00Z" });
    const { rows, origin } = buildGantt([old, recent], null, NOW);
    expect(rows.map(r => r.id).sort()).toEqual(["1", "2"]);
    expect(origin.getTime()).toBe(new Date("2025-01-01T00:00:00Z").getTime());
  });

  it("marks a closed milestone done with full progress", () => {
    const closed = ms({ number: 3, state: "closed", open_issues: 0, closed_issues: 5,
      created_at: "2026-05-01T00:00:00Z", due_on: "2026-05-10T00:00:00Z" });
    const { rows } = buildGantt([closed], null, NOW);
    expect(rows[0].state).toBe("done");
    expect(rows[0].pct).toBe(1);
  });
});
