// #measure-where-the-components-graph-spends-its-commit — the cull reading, and when it is worth a line.
//
// This is diagnostic output, so the thing under test is its SIGNAL-TO-NOISE: it has to say something on
// the readings that answer "is culling engaging at this zoom", and stay silent on the ones that do not.
// A diagnostic that logs on every pan buries the phase timings it was added to sit beside.
import { describe, it, expect } from "vitest";
import { cullSummary, worthReporting, type CullReading } from "@/shared/lib/graph/cullReport";

const read = (shown: number, total: number, scale = 1): CullReading => ({ shown, total, scale });

describe("cullSummary", () => {
  it("reports the count, the percentage and the ZOOM — the variable that decides culling's reach", () => {
    expect(cullSummary(read(231, 459, 1))).toBe("[perf] graph cull: 231/459 nodes mounted (50%) at 100% zoom");
  });

  it("says nothing when NOTHING was culled — the fit-zoom case carries no information", () => {
    // At a zoom that fits the whole graph every node genuinely is visible, so this fires constantly and
    // means nothing. Silence there is what keeps the interesting readings readable.
    expect(cullSummary(read(459, 459, 0.2))).toBeNull();
  });

  it("says nothing for an empty graph rather than dividing by zero", () => {
    expect(cullSummary(read(0, 0, 1))).toBeNull();
  });

  it("reports the extreme case — culled to almost nothing is exactly when you want to know", () => {
    expect(cullSummary(read(3, 459, 2.5))).toContain("3/459");
    expect(cullSummary(read(3, 459, 2.5))).toContain("250% zoom");
  });
});

describe("worthReporting", () => {
  it("always reports the FIRST reading — there is nothing to compare it against", () => {
    expect(worthReporting(null, read(200, 459))).toBe(true);
  });

  it("stays quiet through a small pan — a few nodes in or out is not news", () => {
    expect(worthReporting(read(200, 459), read(205, 459))).toBe(false);
    expect(worthReporting(read(200, 459), read(195, 459))).toBe(false);
  });

  it("reports a material change in what is mounted", () => {
    expect(worthReporting(read(200, 459), read(240, 459))).toBe(true);
    expect(worthReporting(read(200, 459), read(120, 459))).toBe(true);
  });

  it("ALWAYS reports crossing into or out of 'nothing culled' — the answer we are after", () => {
    // This transition is the whole question: at what zoom does culling stop doing anything? It must be
    // reported even when the node delta is tiny, which a pure delta rule would have swallowed.
    expect(worthReporting(read(458, 459), read(459, 459))).toBe(true);   // culling → not culling
    expect(worthReporting(read(459, 459), read(458, 459))).toBe(true);   // not culling → culling
  });
});
