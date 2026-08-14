import { describe, it, expect } from "vitest";
import { recoveryLadder, hasRecoveryPath } from "@/shared/lib/runtime/recoveryLadder";
import type { ChangeEntry } from "@/features/designs/lib/model";

/** A history entry, with only the fields the ladder reads. */
const entry = (rev: number, prevSrc?: string): ChangeEntry => ({
  rev,
  at: `2026-08-14T0${rev}:00:00Z`,
  by: "designer",
  changed: prevSrc ? ["srcText"] : ["folder"],
  ...(prevSrc ? { prevSrc } : {}),
});

describe("recoveryLadder", () => {
  it("returns the retained earlier sources newest-first", () => {
    // History is stored oldest-first; the runtime wants the most recent version that worked FIRST, so a
    // single bad write costs one extra compile rather than walking back to the record's beginning.
    const history = [entry(1), entry(2, "v1"), entry(3, "v2")];
    expect(recoveryLadder(history)).toEqual(["v2", "v1"]);
  });

  it("is empty for the cases that have no way back", () => {
    expect(recoveryLadder(undefined)).toEqual([]);
    expect(recoveryLadder([])).toEqual([]);
    // A record written once: the create replaced nothing, so there is no earlier version.
    expect(recoveryLadder([entry(1)])).toEqual([]);
    // A retained-but-blank source is not a rung — mounting an empty module is not a recovery.
    expect(recoveryLadder([entry(1), entry(2, "   ")])).toEqual([]);
  });

  it("excludes the current source and de-duplicates repeats", () => {
    // The ladder is what to try INSTEAD of what just failed; offering the failing version back spends a
    // compile to reach the same error. A record edited to X, away, and back to X repeats a rung.
    const history = [entry(1, "a"), entry(2, "b"), entry(3, "a")];
    expect(recoveryLadder(history, "b")).toEqual(["a"]);
    expect(recoveryLadder(history)).toEqual(["a", "b"]);
  });

  it("skips metadata-only writes rather than treating them as rungs", () => {
    // A refolder between two source edits carries no `prevSrc`. It must not shorten the ladder or insert
    // an undefined rung — both of which would cost the runtime its next-best version.
    const history = [entry(1, "good"), entry(2), entry(3), entry(4, "worse")];
    expect(recoveryLadder(history)).toEqual(["worse", "good"]);
  });
});

describe("hasRecoveryPath", () => {
  it("is true for a packaged builtin, which re-seeds", () => {
    expect(hasRecoveryPath({ builtin: true })).toBe(true);
  });

  it("is true once a write has retained the version it replaced", () => {
    expect(hasRecoveryPath({ history: [entry(1), entry(2, "good")] })).toBe(true);
  });

  it("is FALSE for the state that made the incident unrecoverable", () => {
    // No seed and no retained earlier source: `graphprimitive`, `kitrenderer` and `insights` were all
    // here, so the designer's 01:39 version became the only copy that had ever existed.
    expect(hasRecoveryPath({ history: [entry(1)] })).toBe(false);
    expect(hasRecoveryPath({})).toBe(false);
  });
});
