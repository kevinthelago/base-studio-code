import { describe, it, expect } from "vitest";
import { unlock, isUnlocked, achievementById, ACHIEVEMENTS } from "./achievements";

describe("achievements", () => {
  it("unlock stamps a fresh id once and returns the new map", () => {
    const next = unlock({}, "super-user", 1000);
    expect(next).toEqual({ "super-user": 1000 });
  });

  it("unlock is idempotent — returns null when already unlocked (once ever)", () => {
    const first = unlock({}, "super-user", 1000)!;
    expect(first).not.toBeNull();
    const second = unlock(first, "super-user", 2000);
    expect(second).toBeNull();                 // no re-fire
    expect(first["super-user"]).toBe(1000);    // original timestamp preserved
  });

  it("unlock preserves other achievements", () => {
    const next = unlock({ "other": 5 }, "super-user", 1000);
    expect(next).toEqual({ "other": 5, "super-user": 1000 });
  });

  it("isUnlocked reflects membership, including a 0 timestamp", () => {
    expect(isUnlocked({ "super-user": 1000 }, "super-user")).toBe(true);
    expect(isUnlocked({ "super-user": 0 }, "super-user")).toBe(true);
    expect(isUnlocked({}, "super-user")).toBe(false);
  });

  it("registry defines the super-user achievement — an icon is OPTIONAL (#3939)", () => {
    const a = achievementById("super-user");
    expect(a?.title).toBe("Claude Super User");
    expect(a?.description).toBeTruthy();
    // The toast renders from tokens now, so an achievement needs no bespoke image; `icon` resolves to
    // "" when absent and both surfaces fall back to the shared trophy glyph.
    expect(a?.icon).toBe("");
    expect(ACHIEVEMENTS.length).toBeGreaterThan(0);
  });

  it("ships NO achievement asset — the old toast reproduced Xbox trade dress (#3939)", () => {
    // The guard against it creeping back: every achievement's title + description must be live text
    // the toast can render, not pixels baked into a banner.
    for (const a of ACHIEVEMENTS) {
      expect(a.title, `${a.id} has a title`).toBeTruthy();
      expect(a.description, `${a.id} has a description`).toBeTruthy();
    }
  });
});
