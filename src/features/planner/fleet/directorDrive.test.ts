import { describe, it, expect } from "vitest";
import {
  normalizeDirectorDrive, resolveDirectorDrive, DEFAULT_DIRECTOR_DRIVE,
  askKey, requestKey, shouldRemind,
} from "@/features/planner/fleet/directorDrive";

describe("normalizeDirectorDrive", () => {
  it("accepts the four canonical modes", () => {
    for (const v of ["event", "heartbeat", "manual", "off"] as const) {
      expect(normalizeDirectorDrive(v)).toBe(v);
    }
  });
  it("maps the event-driven alias to event", () => {
    expect(normalizeDirectorDrive("event-driven")).toBe("event");
    expect(normalizeDirectorDrive("EVENT-DRIVEN")).toBe("event");
  });
  it("falls back to the default for junk / non-strings", () => {
    expect(normalizeDirectorDrive("nonsense")).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(normalizeDirectorDrive(undefined)).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(normalizeDirectorDrive(42)).toBe(DEFAULT_DIRECTOR_DRIVE);
  });
  it("resolveDirectorDrive applies the default when unset", () => {
    expect(resolveDirectorDrive(undefined)).toBe(DEFAULT_DIRECTOR_DRIVE);
    expect(resolveDirectorDrive("off")).toBe("off");
  });
});

describe("the dedupe keys + the idle predicate (the surviving surface)", () => {
  // What is left of this module after #coord-prefix-names-the-sender: the drive-mode config, the two
  // once-guard keys, and `shouldRemind`. The prompt builders and `decideDirectorAction` are deleted,
  // so every suite that drove them went with them.
  it("askKey is stable per session + timestamp", () => {
    expect(askKey({ session: "t0p2", at: 5 })).toBe("t0p2@5");
    expect(askKey({ session: "t0p2", at: 6 })).not.toBe(askKey({ session: "t0p2", at: 5 }));
  });

  it("requestKey keys on the row id, not session+time — the id is what `request-resolved` carries", () => {
    expect(requestKey({ id: "7" })).toBe("req:7");
    expect(requestKey({ id: "7" })).toBe(requestKey({ id: "7" }));
  });

  it("shouldRemind fires for an idle director with work, and never for a busy one", () => {
    const base = { pending: 2, now: 10_000, lastRemindAt: 0, everyMs: 1000 };
    expect(shouldRemind({ ...base, idle: true })).toBe(true);
    expect(shouldRemind({ ...base, idle: false })).toBe(false);
    expect(shouldRemind({ ...base, idle: true, pending: 0 })).toBe(false);
  });

  it("shouldRemind rate-limits, then reminds again", () => {
    const base = { idle: true, pending: 1, everyMs: 1000 };
    expect(shouldRemind({ ...base, now: 1500, lastRemindAt: 1000 })).toBe(false);
    expect(shouldRemind({ ...base, now: 2000, lastRemindAt: 1000 })).toBe(true);
  });
});
