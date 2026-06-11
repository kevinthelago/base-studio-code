import { describe, it, expect } from "vitest";
import { firstUnfinishedSection, launchBlockedMessage, type PlanSection } from "../lib/planReadiness";

const sec = (k: string, state: PlanSection["state"]): PlanSection => ({ k, state });

describe("firstUnfinishedSection", () => {
  it("returns null when all sections are confirmed", () => {
    const sections = [sec("goal", "confirmed"), sec("scope", "confirmed")];
    expect(firstUnfinishedSection(sections)).toBeNull();
  });

  it("returns the key of the first non-confirmed section", () => {
    const sections = [
      sec("goal", "confirmed"),
      sec("scope", "drafted"),
      sec("stack", "pending"),
    ];
    expect(firstUnfinishedSection(sections)).toBe("scope");
  });

  it("returns the first pending section when none are confirmed", () => {
    const sections = [sec("goal", "pending"), sec("scope", "pending")];
    expect(firstUnfinishedSection(sections)).toBe("goal");
  });

  it("skips confirmed sections at the start", () => {
    const sections = [
      sec("goal", "confirmed"),
      sec("scope", "confirmed"),
      sec("stack", "pending"),
    ];
    expect(firstUnfinishedSection(sections)).toBe("stack");
  });

  it("returns null for an empty section list", () => {
    expect(firstUnfinishedSection([])).toBeNull();
  });
});

describe("launchBlockedMessage", () => {
  it("returns an empty string when there is no unfinished section", () => {
    expect(launchBlockedMessage(null)).toBe("");
  });

  it("names the unfinished section in the message", () => {
    const msg = launchBlockedMessage("architecture");
    expect(msg).toMatch(/architecture/);
    expect(msg.length).toBeGreaterThan(0);
  });
});
