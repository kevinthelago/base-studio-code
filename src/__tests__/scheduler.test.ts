import { describe, it, expect } from "vitest";
import {
  computeNextRun, resolveTargetPane, dispatchPayload, dueAutomations, appendRun, MAX_RUNS,
  type Automation, type AutomationRun,
} from "../lib/scheduler";

const DAY = 86_400_000;

function mkAuto(over: Partial<Automation> = {}): Automation {
  return {
    id: "a1", name: "n", armed: true,
    when: { every: "day", at: "09:00" },
    targetTab: "T", targetPane: "P",
    action: "command", command: "echo hi",
    lastRunAt: null, nextRunAt: null, runs: [],
    ...over,
  };
}

describe("computeNextRun", () => {
  it("minute → next whole-minute boundary, within 60s", () => {
    const from = Date.now();
    const next = computeNextRun({ every: "minute", at: "" }, from)!;
    expect(next % 60000).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(60000);
  });

  it("hour → the given minute, within the next hour", () => {
    const from = new Date(2026, 4, 27, 14, 20, 0).getTime();
    const next = computeNextRun({ every: "hour", at: ":15" }, from)!;
    const d = new Date(next);
    expect(d.getMinutes()).toBe(15);
    expect(d.getSeconds()).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(3600_000);
  });

  it("day → the given time, within 24h, strictly after `from`", () => {
    const from = new Date(2026, 4, 27, 14, 0, 0).getTime();
    const next = computeNextRun({ every: "day", at: "09:00" }, from)!;
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(DAY);
  });

  it("day → later today when the time hasn't passed yet", () => {
    const from = new Date(2026, 4, 27, 6, 0, 0).getTime();
    const next = computeNextRun({ every: "day", at: "09:00" }, from)!;
    expect(next - from).toBe(3 * 3600_000); // 06:00 → 09:00 same day
  });

  it("weekday → never lands on a weekend", () => {
    // 2022-01-01 is a Saturday; from 10:00, a 09:00 daily would roll to Sunday,
    // which weekday must skip to Monday.
    const sat = new Date(2022, 0, 1, 10, 0, 0).getTime();
    const next = computeNextRun({ every: "weekday", at: "09:00" }, sat)!;
    const day = new Date(next).getDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
  });

  it("returns null for unsupported specs", () => {
    // @ts-expect-error — exercising the unsupported branch
    expect(computeNextRun({ every: "month", at: "09:00" }, Date.now())).toBeNull();
  });
});

describe("resolveTargetPane", () => {
  const tabs = [{ name: "orchestrator" }, { name: "feat/tunnel" }];
  const paneNames = { 0: { 0: "@scratch", 1: "@reviewer" }, 1: { 0: "@scratch" } };

  it("resolves a live target to t{tab}p{pane}", () => {
    expect(resolveTargetPane("orchestrator", "@reviewer", tabs, paneNames, {})).toBe("t0p1");
    expect(resolveTargetPane("feat/tunnel", "@scratch", tabs, paneNames, {})).toBe("t1p0");
  });
  it("returns null when the tab or pane is missing", () => {
    expect(resolveTargetPane("nope", "@reviewer", tabs, paneNames, {})).toBeNull();
    expect(resolveTargetPane("orchestrator", "@ghost", tabs, paneNames, {})).toBeNull();
  });
  it("returns null when the resolved pane is disabled", () => {
    expect(resolveTargetPane("orchestrator", "@reviewer", tabs, paneNames, { t0p1: true })).toBeNull();
  });
});

describe("dispatchPayload", () => {
  const blocks = [{ id: "blk_1", content: "# policy\nrules" }, { id: "blk_empty", content: "  " }];
  it("returns the trimmed command for a command action", () => {
    expect(dispatchPayload(mkAuto({ action: "command", command: "  ls -la  " }), blocks)).toBe("ls -la");
  });
  it("returns null for an empty command", () => {
    expect(dispatchPayload(mkAuto({ action: "command", command: "   " }), blocks)).toBeNull();
  });
  it("returns the block content for a knowledge action", () => {
    expect(dispatchPayload(mkAuto({ action: "knowledge", blockId: "blk_1" }), blocks)).toBe("# policy\nrules");
  });
  it("returns null when the block is missing or empty", () => {
    expect(dispatchPayload(mkAuto({ action: "knowledge", blockId: "nope" }), blocks)).toBeNull();
    expect(dispatchPayload(mkAuto({ action: "knowledge", blockId: "blk_empty" }), blocks)).toBeNull();
  });
});

describe("dueAutomations", () => {
  it("returns only armed automations whose nextRunAt has passed", () => {
    const now = 1_000_000;
    const list = [
      mkAuto({ id: "due", armed: true, nextRunAt: now - 1 }),
      mkAuto({ id: "future", armed: true, nextRunAt: now + 1000 }),
      mkAuto({ id: "disarmed", armed: false, nextRunAt: now - 1 }),
      mkAuto({ id: "unscheduled", armed: true, nextRunAt: null }),
    ];
    expect(dueAutomations(list, now).map(a => a.id)).toEqual(["due"]);
  });
});

describe("appendRun", () => {
  it("prepends newest and caps at MAX_RUNS", () => {
    let runs: AutomationRun[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i++) runs = appendRun(runs, { at: i, status: "ok", note: String(i) });
    expect(runs.length).toBe(MAX_RUNS);
    expect(runs[0].note).toBe(String(MAX_RUNS + 4)); // newest first
  });
});
