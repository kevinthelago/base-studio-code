// Unit tests for the app-staleness verdict. Tier 1 (`--no-watch`) trades a loud interruption for a
// quiet staleness, so this verdict is the only thing that answers "am I running current code?".
import { describe, expect, it } from "vitest";
import { judgeAppBinary } from "./app-status.mjs";

const s = (over: Record<string, unknown> = {}) => ({
  binaryExists: true,
  binaryMs: 1000,
  headMs: 1000,
  behind: 0,
  ...over,
});

describe("judgeAppBinary", () => {
  it("reports current when the binary matches main", () => {
    expect(judgeAppBinary(s())).toEqual({ state: "current", reason: "up-to-date" });
  });

  it("reports absent before anything is built", () => {
    expect(judgeAppBinary(s({ binaryExists: false })).state).toBe("absent");
  });

  it("reports stale when main has commits the binary cannot contain", () => {
    expect(judgeAppBinary(s({ behind: 3 })).state).toBe("stale");
  });

  /// COMMIT COUNT OUTRANKS MTIME. A rebuild touches the mtime without changing what it was built
  /// from, so mtime alone would call a fresh rebuild of old code "current" — the reassuring-but-wrong
  /// answer this whole file exists to avoid.
  it("still reports stale when the binary is NEWER than head but commits were missed", () => {
    expect(judgeAppBinary(s({ binaryMs: 9999, headMs: 1000, behind: 2 })).state).toBe("stale");
  });

  it("catches a head newer than the binary even when the count is unavailable", () => {
    expect(judgeAppBinary(s({ binaryMs: 1000, headMs: 5000, behind: 0 })).state).toBe("stale");
  });

  it("is inert on a malformed state rather than claiming current", () => {
    expect(judgeAppBinary(undefined as never).state).toBe("absent");
  });
});
