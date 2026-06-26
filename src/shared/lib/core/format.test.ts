import { describe, it, expect } from "vitest";
import { timeAgo, loginColor } from "./format";

describe("timeAgo", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("renders seconds / minutes / hours / days", () => {
    expect(timeAgo(at(5_000))).toMatch(/^\d+s ago$/);
    expect(timeAgo(at(3 * 60_000))).toBe("3m ago");
    expect(timeAgo(at(2 * 3_600_000))).toBe("2h ago");
    expect(timeAgo(at(4 * 86_400_000))).toBe("4d ago");
  });
});

describe("loginColor", () => {
  it("is deterministic for a login and an in-range oklch hue", () => {
    const a = loginColor("octocat");
    expect(a).toBe(loginColor("octocat"));      // stable
    const hue = Number(a.match(/oklch\(0\.68 0\.12 (\d+)\)/)![1]);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThan(360);
  });

  it("differs across distinct logins (no trivial collision)", () => {
    expect(loginColor("alice")).not.toBe(loginColor("bob"));
  });
});
