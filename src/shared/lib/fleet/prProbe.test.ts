// #an-unmerged-ended-pane-is-polled-against-github-forever
import { describe, it, expect } from "vitest";
import {
  verdictFromPulls, planNextProbe, isDue,
  PROBE_BASE_MS, PROBE_MAX_MS, NO_PR_ATTEMPTS,
} from "./prProbe";

describe("verdictFromPulls", () => {
  it("reads a merged PR, an open one, and none at all", () => {
    expect(verdictFromPulls([{ merged_at: "2026-08-29T00:00:00Z" }])).toBe("merged");
    expect(verdictFromPulls([{ merged_at: null }])).toBe("open");
    expect(verdictFromPulls([])).toBe("none");
  });

  it("treats a FAILED request as unknown, never as 'no PR'", () => {
    // `safeInvoke` returns its fallback on failure. Reading that as "no PR exists" is what would
    // retire a pane for being briefly offline — and its PR might merge an hour later.
    expect(verdictFromPulls(null)).toBe("unknown");
    expect(verdictFromPulls(undefined)).toBe("unknown");
    expect(verdictFromPulls({ message: "Bad credentials" })).toBe("unknown");
  });
});

describe("planNextProbe", () => {
  it("stops permanently once merged", () => {
    expect(planNextProbe("merged", 0).retryInMs).toBeNull();
  });

  it("backs off an open PR instead of asking every minute", () => {
    // THE BUG, as a test: the old code re-asked at a flat 60s forever.
    expect(planNextProbe("open", 0).retryInMs).toBe(PROBE_BASE_MS);
    expect(planNextProbe("open", 1).retryInMs).toBe(PROBE_BASE_MS * 2);
    expect(planNextProbe("open", 3).retryInMs).toBe(PROBE_BASE_MS * 8);
  });

  it("caps the backoff so a long-lived PR is still checked eventually", () => {
    expect(planNextProbe("open", 40).retryInMs).toBe(PROBE_MAX_MS);
  });

  it("gives up on a branch with no PR after a bounded number of answers", () => {
    for (let a = 0; a < NO_PR_ATTEMPTS - 1; a++) {
      expect(planNextProbe("none", a).retryInMs, `attempt ${a} should still retry`).not.toBeNull();
    }
    expect(planNextProbe("none", NO_PR_ATTEMPTS - 1).retryInMs).toBeNull();
  });

  it("does NOT spend an attempt on a failed request", () => {
    // Otherwise an outage lasting NO_PR_ATTEMPTS polls would permanently retire every pane, and the
    // worktrees they own would never be reclaimed.
    const p = planNextProbe("unknown", 0);
    expect(p.countsAsAttempt).toBe(false);
    expect(p.retryInMs).toBe(PROBE_BASE_MS);
    for (const v of ["merged", "open", "none"] as const) {
      expect(planNextProbe(v, 0).countsAsAttempt, `${v} is an answer`).toBe(true);
    }
  });

  it("every verdict yields a decision", () => {
    // No verdict may fall through to `undefined` — that would read as "retry immediately, forever".
    for (const v of ["merged", "open", "none", "unknown"] as const) {
      expect(planNextProbe(v, 0)).toHaveProperty("retryInMs");
    }
  });
});

describe("isDue", () => {
  it("treats a pane with no record as due", () => {
    expect(isDue(undefined, 1000)).toBe(true);
  });

  it("waits until the scheduled time", () => {
    expect(isDue(2000, 1999)).toBe(false);
    expect(isDue(2000, 2000)).toBe(true);
  });
});
