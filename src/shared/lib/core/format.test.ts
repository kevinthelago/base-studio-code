import { describe, it, expect } from "vitest";
import { timeAgo, timeAgoShort, timeAgoMs, loginColor, hueFor, truncate, slugify, fmtClock, dayKey } from "./format";

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

// ── #2421 consolidated helpers — each test pins the edge behavior of the former copies ─────────

describe("truncate", () => {
  it("returns the string unchanged at or under max", () => {
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 600)).toBe("hi");
    expect(truncate("", 10)).toBe("");
  });

  it("hard-cap shape (keep = max): the issue-body previews (600/800)", () => {
    const body = "x".repeat(601);
    expect(truncate(body, 600)).toBe("x".repeat(600) + "…");
    // Exactly max → untouched (the former `slice(0,600) + (len>600 ? "…" : "")` also kept it whole).
    expect(truncate("x".repeat(600), 600)).toBe("x".repeat(600));
  });

  it("display-budget shape (keep < max): the label sites (64/61, 32/30, 20/18)", () => {
    const s65 = "a".repeat(65);
    expect(truncate(s65, 64, 61)).toBe("a".repeat(61) + "…"); // lessonTitle
    // In the (max, max-2] band the string passes through whole — longer than the truncated form,
    // exactly like the former `len > 64 ? slice(0,61)+… : s` copies.
    expect(truncate("a".repeat(64), 64, 61)).toBe("a".repeat(64));
    expect(truncate("b".repeat(33), 32, 30)).toBe("b".repeat(30) + "…"); // prettyGist
    expect(truncate("feature/very-long-name", 20, 18)).toBe("feature/very-long-".slice(0, 18) + "…"); // BranchGraph lane
  });
});

describe("slugify", () => {
  it("lowercases, collapses non-alphanumeric runs to '-', and strips edge dashes", () => {
    expect(slugify("Invite Teammates")).toBe("invite-teammates");
    expect(slugify("  Salesforce (prod) → v2!  ")).toBe("salesforce-prod-v2");
    expect(slugify("--already--sluggy--")).toBe("already-sluggy");
  });

  it("returns '' when nothing survives (callers apply their own fallback)", () => {
    expect(slugify("")).toBe("");
    expect(slugify("→ ★ !!!")).toBe("");
    expect(slugify("→ ★ !!!", 40) || "source").toBe("source"); // the FocusedSourceBody shape
  });

  it("caps at max AFTER edge-stripping (matching the former featureList/source copies)", () => {
    expect(slugify("a".repeat(80), 60)).toBe("a".repeat(60));
    // A cut on a word boundary can leave a trailing dash — the former copies did too.
    expect(slugify("ab cd", 3)).toBe("ab-");
  });

  it("supports the DesignsWorkbench first-two-words derivation", () => {
    expect(slugify("A Sleek Primary Button!").split("-").filter(Boolean).slice(0, 2).join("-")).toBe("a-sleek");
  });
});

describe("fmtClock", () => {
  it("renders HH:MM, padded (the automations shape)", () => {
    expect(fmtClock(new Date(2026, 0, 1, 2, 0).getTime())).toBe("02:00");
    expect(fmtClock(new Date(2026, 5, 15, 23, 59).getTime())).toBe("23:59");
  });
  it("renders an em dash for null", () => {
    expect(fmtClock(null)).toBe("—");
  });
  it("renders HH:MM:SS with { seconds: true } (the MCP Analytics shape)", () => {
    expect(fmtClock(new Date(2026, 0, 1, 2, 0, 7).getTime(), { seconds: true })).toBe("02:00:07");
  });
});

describe("dayKey", () => {
  it("renders the LOCAL zero-padded YYYY-MM-DD (the telemetry daily-bucket key)", () => {
    expect(dayKey(new Date(2026, 0, 5).getTime())).toBe("2026-01-05");
    expect(dayKey(new Date(2026, 10, 30, 23, 59, 59).getTime())).toBe("2026-11-30");
  });
  it("buckets two timestamps on the same local day identically", () => {
    expect(dayKey(new Date(2026, 3, 2, 0, 0, 1).getTime())).toBe(dayKey(new Date(2026, 3, 2, 23, 30).getTime()));
  });
});
