// Unit tests for the full-gate lock's staleness rules. These pin the conditions under which one
// session may TAKE OVER another's lock — the rule that decides between "the fleet wedges after the
// first crash" and "a killed gate frees its slot".
import { describe, expect, it } from "vitest";
import { lockIsStale, slotCount } from "./gate-lock-plan.mjs";

describe("lockIsStale", () => {
  const HOUR = 3600_000;

  it("is stale when the holder is gone — the normal crash/Ctrl-C case", () => {
    // The gate releases in a plain statement, so any kill skips it. If a dead holder's lock were
    // permanent, the first crashed agent would block every future full gate in the fleet.
    expect(lockIsStale({ pidAlive: false, ageMs: 10, maxAgeMs: HOUR })).toBe(true);
  });

  it("is NOT stale while a live holder is inside the time budget", () => {
    expect(lockIsStale({ pidAlive: true, ageMs: 60_000, maxAgeMs: HOUR })).toBe(false);
  });

  it("is stale when a LIVE holder has exceeded the budget", () => {
    // Two cases this catches: a wedged holder (hung linker, paused process), and PID reuse — where
    // some unrelated process now owns that number and would otherwise look alive forever.
    expect(lockIsStale({ pidAlive: true, ageMs: HOUR + 1, maxAgeMs: HOUR })).toBe(true);
  });

  it("treats the boundary as still held, so a gate is never interrupted at exactly the limit", () => {
    expect(lockIsStale({ pidAlive: true, ageMs: HOUR, maxAgeMs: HOUR })).toBe(false);
  });
});

describe("slotCount", () => {
  it("defaults to 2 — one gate is ~8 GB and this box has ~16 GB free", () => {
    expect(slotCount(undefined)).toBe(2);
  });

  it("honours an explicit limit, for a bigger machine or a deliberately serial run", () => {
    expect(slotCount("1")).toBe(1);
    expect(slotCount("6")).toBe(6);
  });

  /** `0` would mean "no gate may ever run", which is never what someone meant to type — and a lock
   *  that can be configured into deadlock is worse than no lock. */
  it("falls back rather than allowing a value that could never let a gate run", () => {
    for (const bad of ["0", "-1", "", "abc", "2.5"]) {
      expect(slotCount(bad), bad).toBe(2);
    }
  });
});
