import { describe, it, expect } from "vitest";
import { timeAgo, timeAgoShort, timeAgoMs, loginColor, hueFor } from "./format";

describe("timeAgo", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  it("renders seconds / minutes / hours / days / months", () => {
    expect(timeAgo(at(5_000))).toMatch(/^\d+s ago$/);
    expect(timeAgo(at(3 * 60_000))).toBe("3m ago");
    expect(timeAgo(at(2 * 3_600_000))).toBe("2h ago");
    expect(timeAgo(at(4 * 86_400_000))).toBe("4d ago");
    expect(timeAgo(at(60 * 86_400_000))).toBe("2mo ago");
  });

  it("guards empty, non-finite, and future timestamps to \"\"", () => {
    expect(timeAgo("")).toBe("");
    expect(timeAgo("not-a-date")).toBe("");
    expect(timeAgo(at(-10_000))).toBe(""); // future
  });
});

describe("timeAgoShort", () => {
  const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  it("drops the trailing \" ago\"", () => {
    expect(timeAgoShort(at(5_000))).toMatch(/^\d+s$/);
    expect(timeAgoShort(at(2 * 3_600_000))).toBe("2h");
    expect(timeAgoShort(at(60 * 86_400_000))).toBe("2mo");
    expect(timeAgoShort("")).toBe("");
  });
});

describe("timeAgoMs", () => {
  it("renders from epoch millis and dashes a non-positive input", () => {
    expect(timeAgoMs(Date.now() - 2 * 3_600_000)).toBe("2h ago");
    expect(timeAgoMs(0)).toBe("—");
  });
});

describe("hueFor", () => {
  it("is deterministic and in [0, 360)", () => {
    expect(hueFor("alpha")).toBe(hueFor("alpha"));
    const h = hueFor("some-gist-id");
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it("differs across distinct strings", () => {
    expect(hueFor("alice")).not.toBe(hueFor("bob"));
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
