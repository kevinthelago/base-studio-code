import { describe, it, expect } from "vitest";
import {
  computeNextRun, resolvePersonaPane, duePersonaSchedules, scheduleKey, suggestionToAutomation,
  type CarriedSchedule,
} from "@/features/automations/lib/scheduler";

const DAY = 86_400_000;

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

describe("resolvePersonaPane", () => {
  it("finds the pane running the carrier", () => {
    expect(resolvePersonaPane("p1", { t0p3: "p1", t1p0: "p2" }, {})).toBe("t0p3");
  });

  it("returns null when the carrier is not running anywhere", () => {
    expect(resolvePersonaPane("p1", { t0p0: "other" }, {})).toBeNull();
    expect(resolvePersonaPane("p1", {}, {})).toBeNull();
  });

  it("treats a disabled pane as not running", () => {
    expect(resolvePersonaPane("p1", { t0p3: "p1" }, { t0p3: true })).toBeNull();
  });

  it("resolves by IDENTITY, so a pane at a different position still matches", () => {
    // The point of moving off (tab name, pane index): the index did not survive a reorder.
    expect(resolvePersonaPane("p1", { t9p7: "p1" }, {})).toBe("t9p7");
  });
});

describe("duePersonaSchedules", () => {
  const NOW = Date.parse("2026-08-20T12:00:00Z");
  const carried = (over: Partial<CarriedSchedule> = {}): CarriedSchedule => ({
    personaId: "p1", name: "gc", when: { kind: "simple", every: "minute", at: "" }, command: "x", ...over,
  });

  it("is due when the next run after its LAST fire has passed", () => {
    const last = { [scheduleKey("p1", "gc")]: NOW - 120_000 };   // 2 minutes ago, every minute
    expect(duePersonaSchedules([carried()], last, NOW)).toHaveLength(1);
  });

  it("is NOT due when the next run is still ahead", () => {
    // A DAILY job, run an hour ago: the next 09:00 is tomorrow. Deliberately not an every-minute
    // job — one that ran a second ago is genuinely due again at the next minute boundary, so it
    // would prove nothing here.
    const daily = carried({ when: { kind: "simple", every: "day", at: "09:00" } });
    const last = { [scheduleKey("p1", "gc")]: NOW - 3_600_000 };
    expect(duePersonaSchedules([daily], last, NOW)).toHaveLength(0);
  });

  it("a schedule that has NEVER fired is not due — it is anchored forward, not decades overdue", () => {
    // Anchoring an unseen job at the epoch would make every newly-authored schedule fire the
    // instant it was saved. A daily 02:00 job written at 10:00 should first run at 02:00 tomorrow.
    expect(duePersonaSchedules([carried()], {}, NOW)).toEqual([]);
  });

  it("keys each schedule by persona AND name, so two agents carrying the same job are independent", () => {
    const both = [carried({ personaId: "p1" }), carried({ personaId: "p2" })];
    const onlyP1 = { [scheduleKey("p1", "gc")]: NOW - 120_000 };
    expect(duePersonaSchedules(both, onlyP1, NOW).map((c) => c.personaId)).toEqual(["p1"]);
  });

  it("drops a schedule whose spec cannot produce a next run", () => {
    const bad = carried({ when: { kind: "simple", every: "fortnight" } as never });
    expect(duePersonaSchedules([bad], { [scheduleKey("p1", "gc")]: 0 }, NOW)).toEqual([]);
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
