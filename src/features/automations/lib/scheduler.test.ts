import { describe, it, expect } from "vitest";
import {
  computeNextRun, resolveTargetPane, dispatchPayload, dueAutomations, appendRun, MAX_RUNS, suggestionToAutomation,
  type Automation, type AutomationRun,
} from "./scheduler";

const DAY = 86_400_000;

function mkAuto(over: Partial<Automation> = {}): Automation {
  return {
    id: "a1", name: "n", armed: true,
    when: { kind: "simple", every: "day", at: "09:00" },
    targetTab: "T", targetPaneIdx: 0,
    action: "command", command: "echo hi",
    lastRunAt: null, nextRunAt: null, runs: [],
    ...over,
  };
}

describe("computeNextRun", () => {
  it("minute → next whole-minute boundary, within 60s", () => {
    const from = Date.now();
    const next = computeNextRun({ kind: "simple", every: "minute", at: "" }, from)!;
    expect(next % 60000).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(60000);
  });

  it("hour → the given minute, within the next hour", () => {
    const from = new Date(2026, 4, 27, 14, 20, 0).getTime();
    const next = computeNextRun({ kind: "simple", every: "hour", at: ":15" }, from)!;
    const d = new Date(next);
    expect(d.getMinutes()).toBe(15);
    expect(d.getSeconds()).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(3600_000);
  });

  it("day → the given time, within 24h, strictly after `from`", () => {
    const from = new Date(2026, 4, 27, 14, 0, 0).getTime();
    const next = computeNextRun({ kind: "simple", every: "day", at: "09:00" }, from)!;
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(from);
    expect(next - from).toBeLessThanOrEqual(DAY);
  });

  it("day → later today when the time hasn't passed yet", () => {
    const from = new Date(2026, 4, 27, 6, 0, 0).getTime();
    const next = computeNextRun({ kind: "simple", every: "day", at: "09:00" }, from)!;
    expect(next - from).toBe(3 * 3600_000); // 06:00 → 09:00 same day
  });

  it("weekday → never lands on a weekend", () => {
    // 2022-01-01 is a Saturday; from 10:00, a 09:00 daily would roll to Sunday,
    // which weekday must skip to Monday.
    const sat = new Date(2022, 0, 1, 10, 0, 0).getTime();
    const next = computeNextRun({ kind: "simple", every: "weekday", at: "09:00" }, sat)!;
    const day = new Date(next).getDay();
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(5);
  });

  it("returns null for unsupported specs", () => {
    // @ts-expect-error — exercising the unsupported branch
    expect(computeNextRun({ kind: "simple", every: "month", at: "09:00" }, Date.now())).toBeNull();
  });

  it("cron → delegates to the cron engine", () => {
    const from = new Date(2026, 4, 27, 10, 0, 0).getTime();
    const d = new Date(computeNextRun({ kind: "cron", expr: "0 9 * * *" }, from)!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });
});

describe("resolveTargetPane", () => {
  const tabs = [{ name: "orchestrator", layout: "2×2" }, { name: "feat/tunnel", layout: "1×1" }];

  it("resolves a live (tab name, pane index) to t{tab}p{pane}", () => {
    expect(resolveTargetPane("orchestrator", 3, tabs, {})).toBe("t0p3");
    expect(resolveTargetPane("feat/tunnel", 0, tabs, {})).toBe("t1p0");
  });
  it("returns null when the tab is missing", () => {
    expect(resolveTargetPane("nope", 0, tabs, {})).toBeNull();
  });
  it("returns null when the pane index is outside the tab's layout", () => {
    expect(resolveTargetPane("orchestrator", 4, tabs, {})).toBeNull(); // 2×2 → 0..3
    expect(resolveTargetPane("feat/tunnel", 1, tabs, {})).toBeNull();  // 1×1 → only 0
  });
  it("returns null when the resolved pane is disabled", () => {
    expect(resolveTargetPane("orchestrator", 1, tabs, { t0p1: true })).toBeNull();
  });
});

describe("dispatchPayload", () => {
  it("returns the trimmed command for a command action", () => {
    expect(dispatchPayload(mkAuto({ action: "command", command: "  ls -la  " }))).toBe("ls -la");
  });
  it("returns null for an empty command", () => {
    expect(dispatchPayload(mkAuto({ action: "command", command: "   " }))).toBeNull();
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

describe("suggestionToAutomation (#174)", () => {
  it("a scheduled suggestion becomes an armed cron automation targeting the tab", () => {
    const a = suggestionToAutomation(
      { name: "Daily audit", command: "npm audit", schedule: "0 9 * * 1-5" },
      "proj · triage",
    );
    expect(a).toMatchObject({
      name: "Daily audit",
      armed: true,
      when: { kind: "cron", expr: "0 9 * * 1-5" },
      targetTab: "proj · triage",
      targetPaneIdx: 0,
      action: "command",
      command: "npm audit",
    });
  });

  it("an on-demand suggestion (no schedule) is saved unarmed", () => {
    const a = suggestionToAutomation({ name: "Typecheck", command: "npm run typecheck" }, "proj · build");
    expect(a.armed).toBe(false);
    expect(a.when.kind).toBe("simple");
    expect(a.command).toBe("npm run typecheck");
  });
});
