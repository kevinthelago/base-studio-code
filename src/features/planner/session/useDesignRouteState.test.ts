import { describe, it, expect } from "vitest";
import { uiNeedsRouting, type DesignRouteState } from "./useDesignRouteState";

const design = (over: Partial<DesignRouteState> = {}): DesignRouteState => ({ hasFiles: false, changed: false, ...over });

describe("uiNeedsRouting (#2860)", () => {
  it("is FALSE when no files are staged — the fresh UI stage no longer offers a dead route button", () => {
    // The regression: a fresh UI stage (ui unconfirmed) used to offer "route design to project" with
    // nothing to route. With no staged files it must be false regardless of confirmation.
    expect(uiNeedsRouting(true, false, design({ hasFiles: false }))).toBe(false);
    expect(uiNeedsRouting(true, true, design({ hasFiles: false }))).toBe(false);
  });

  it("is TRUE when files are staged and the design isn't routed yet, or a staged file changed", () => {
    expect(uiNeedsRouting(true, false, design({ hasFiles: true }))).toBe(true);                 // unrouted
    expect(uiNeedsRouting(true, true, design({ hasFiles: true, changed: true }))).toBe(true);   // routed but stale
  });

  it("is FALSE once files are staged, routed, and unchanged (→ approve & continue)", () => {
    expect(uiNeedsRouting(true, true, design({ hasFiles: true, changed: false }))).toBe(false);
  });

  it("is FALSE when the project needs no UI at all", () => {
    expect(uiNeedsRouting(false, false, design({ hasFiles: true, changed: true }))).toBe(false);
  });
});
