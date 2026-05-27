import { describe, it, expect } from "vitest";
import { parseCron, nextCronRun, isValidCron } from "../lib/cron";

describe("parseCron / isValidCron", () => {
  it("accepts valid 5-field expressions", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/15 * * * *")).toBe(true);
    expect(isValidCron("0 0 1,15 * 1-5")).toBe(true);
    expect(isValidCron("0 9 * * 7")).toBe(true);   // 7 = Sunday
    expect(isValidCron("5/15 * * * *")).toBe(true); // 5,20,35,50
  });
  it("rejects malformed expressions", () => {
    expect(isValidCron("0 9 * *")).toBe(false);     // 4 fields
    expect(isValidCron("0 9 * * * *")).toBe(false); // 6 fields
    expect(isValidCron("60 * * * *")).toBe(false);  // minute out of range
    expect(isValidCron("* 24 * * *")).toBe(false);  // hour out of range
    expect(isValidCron("x * * * *")).toBe(false);
    expect(isValidCron("*/0 * * * *")).toBe(false); // bad step
    expect(parseCron("")).toBeNull();
  });
});

describe("nextCronRun", () => {
  it("daily at 09:00", () => {
    const from = new Date(2026, 4, 27, 14, 0, 0).getTime();
    const d = new Date(nextCronRun("0 9 * * *", from)!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(d.getTime()).toBeGreaterThan(from);
  });
  it("every 15 minutes", () => {
    const from = new Date(2026, 4, 27, 14, 7, 0).getTime();
    const next = nextCronRun("*/15 * * * *", from)!;
    expect(new Date(next).getMinutes() % 15).toBe(0);
    expect(next - from).toBeLessThanOrEqual(15 * 60000);
  });
  it("specific minute + hour (14:15)", () => {
    const from = new Date(2026, 4, 27, 10, 0, 0).getTime();
    const d = new Date(nextCronRun("15 14 * * *", from)!);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(15);
  });
  it("weekly on Monday at 09:00", () => {
    const from = new Date(2026, 4, 27, 14, 0, 0).getTime();
    const d = new Date(nextCronRun("0 9 * * 1", from)!);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
  });
  it("yearly Jan 1 00:00", () => {
    const from = new Date(2026, 4, 27, 0, 0, 0).getTime();
    const d = new Date(nextCronRun("0 0 1 1 *", from)!);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
  });
  it("DOM-or-DOW semantics (1st of month OR Monday)", () => {
    const from = new Date(2026, 4, 27, 12, 0, 0).getTime();
    const d = new Date(nextCronRun("0 0 1 * 1", from)!);
    expect(d.getDate() === 1 || d.getDay() === 1).toBe(true);
    expect(d.getHours()).toBe(0);
  });
  it("returns null for invalid expressions", () => {
    expect(nextCronRun("nope", Date.now())).toBeNull();
    expect(nextCronRun("0 9 * *", Date.now())).toBeNull();
  });
});
