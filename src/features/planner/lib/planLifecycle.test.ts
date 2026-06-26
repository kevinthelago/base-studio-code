import { describe, it, expect } from "vitest";
import {
  deriveLifecycleState,
  LIFECYCLE_LABEL,
  type LifecycleSignals,
} from "./planLifecycle";

// ── deriveLifecycleState ──────────────────────────────────────────────────────

describe("deriveLifecycleState (#458 lifecycle state)", () => {
  const active   = (overrides?: Partial<LifecycleSignals>): LifecycleSignals =>
    ({ isExisting: true, totalIssues: 10, closedIssues: 0, ...overrides });

  it("returns 'new' when the project is not yet published", () => {
    expect(deriveLifecycleState({ isExisting: false, totalIssues: 20, closedIssues: 15 })).toBe("new");
  });

  it("returns 'active' for an existing project below the near-complete threshold", () => {
    expect(deriveLifecycleState(active({ closedIssues: 4 }))).toBe("active"); // 40%
    expect(deriveLifecycleState(active({ closedIssues: 7, totalIssues: 10 }))).toBe("active"); // 70%
  });

  it("returns 'near-complete' when ≥75% of issues are closed", () => {
    expect(deriveLifecycleState(active({ closedIssues: 8 }))).toBe("near-complete");  // 80%
    expect(deriveLifecycleState(active({ closedIssues: 7, totalIssues: 9 }))).toBe("near-complete"); // ~78%
    expect(deriveLifecycleState(active({ closedIssues: 75, totalIssues: 100 }))).toBe("near-complete"); // 75%
  });

  it("returns 'active' for a plan with no issues (ratio = 0)", () => {
    expect(deriveLifecycleState(active({ totalIssues: 0, closedIssues: 0 }))).toBe("active");
  });

  it("LIFECYCLE_LABEL maps all states", () => {
    expect(LIFECYCLE_LABEL["new"]).toBe("drafting");
    expect(LIFECYCLE_LABEL["active"]).toBe("expanding");
    expect(LIFECYCLE_LABEL["near-complete"]).toBe("near-complete");
  });
});
