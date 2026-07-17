// The debug-window `?debug=1` predicate (#3298) — pure, so the search string is injectable.
import { describe, it, expect } from "vitest";
import { detachedDebug } from "./debugWindow";

describe("detachedDebug (#3298)", () => {
  it("is true only for ?debug=1", () => {
    expect(detachedDebug("?debug=1")).toBe(true);
    expect(detachedDebug("?debug=1&foo=bar")).toBe(true);
  });

  it("is false for anything else (empty, other values, other tear-off markers)", () => {
    for (const s of ["", "?debug=0", "?debug=true", "?debug", "?detachTab=foo", "?detach=github&section=repos"]) {
      expect(detachedDebug(s)).toBe(false);
    }
  });
});
