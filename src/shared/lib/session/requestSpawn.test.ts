import { describe, it, expect } from "vitest";
import { planRequestSpawns, type OpenRequest } from "./requestSpawn";

const req = (id: number, over: Partial<OpenRequest> = {}): OpenRequest => ({
  id,
  surface: "bsc ui",
  cmd: `bsc ui harvest dir-${id}`,
  text: `request ${id}`,
  ...over,
});

const plan = (over: Partial<Parameters<typeof planRequestSpawns>[0]> = {}) =>
  planRequestSpawns({ requests: [], active: [], enabled: true, cap: 2, ...over });

describe("the request→session spawn planner (#3498)", () => {
  it("spawns nothing at all while auto-spawn is off, and says so for EVERY request", () => {
    // The gate is re-applied here, not assumed: a caller that forgot to check still cannot get a plan
    // that spawns anything. And nothing is silently dropped — each request carries the gate's reason.
    const requests = [req(1), req(2)];
    for (const enabled of [false, undefined, null] as const) {
      const p = plan({ requests, enabled });
      expect(p.spawn, `enabled=${String(enabled)}`).toEqual([]);
      expect(p.skipped).toHaveLength(2);
      for (const s of p.skipped) expect(s.reason).toMatch(/disabled|Settings/i);
    }
  });

  it("spawns open requests oldest-first, so the queue drains in filing order", () => {
    const p = plan({ requests: [req(3), req(1), req(2)], cap: 3 });
    expect(p.spawn.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(p.skipped).toEqual([]);
  });

  it("never spawns a request that already has a session", () => {
    const p = plan({ requests: [req(1), req(2)], active: [req(1)], cap: 5 });
    expect(p.spawn.map((r) => r.id)).toEqual([2]);
    expect(p.skipped[0].reason).toMatch(/already has a session/);
  });

  it("collapses duplicate work — same surface + same failing command", () => {
    // The designer re-files when a command keeps failing; without this each retry would be its own
    // session working the identical problem.
    const a = req(1, { cmd: "bsc ui harvest src/shared/ui" });
    const b = req(2, { cmd: "bsc ui harvest src/shared/ui" });
    const p = plan({ requests: [a, b], cap: 5 });
    expect(p.spawn.map((r) => r.id)).toEqual([1]);
    expect(p.skipped[0].reason).toMatch(/duplicate work/);
  });

  it("collapses against an ACTIVE session's work too, not just within the batch", () => {
    const active = req(1, { cmd: "bsc ui harvest x" });
    const incoming = req(2, { cmd: "bsc ui harvest x" });
    const p = plan({ requests: [incoming], active: [active], cap: 5 });
    expect(p.spawn).toEqual([]);
    expect(p.skipped[0].reason).toMatch(/duplicate work/);
  });

  it("treats the same command on a DIFFERENT surface as different work", () => {
    const a = req(1, { surface: "bsc ui", cmd: "harvest x" });
    const b = req(2, { surface: "bsc graph", cmd: "harvest x" });
    expect(plan({ requests: [a, b], cap: 5 }).spawn.map((r) => r.id)).toEqual([1, 2]);
  });

  it("falls back to the TEXT for dedup when no command is cited", () => {
    const a = req(1, { cmd: null, text: "the deny list blocks every path" });
    const b = req(2, { cmd: null, text: "the deny list blocks every path" });
    const p = plan({ requests: [a, b], cap: 5 });
    expect(p.spawn.map((r) => r.id)).toEqual([1]);
    expect(p.skipped[0].reason).toMatch(/duplicate work/);
  });

  it("caps concurrency COUNTING the active sessions, and says the rest are capped", () => {
    const p = plan({ requests: [req(1), req(2), req(3)], active: [req(9)], cap: 2 });
    expect(p.spawn.map((r) => r.id), "one slot left of two").toEqual([1]);
    expect(p.skipped.map((s) => s.request.id)).toEqual([2, 3]);
    for (const s of p.skipped) expect(s.reason).toMatch(/concurrency cap \(2\)/);
  });

  it("spawns nothing when the cap is already met or is zero/negative", () => {
    expect(plan({ requests: [req(1)], active: [req(8), req(9)], cap: 2 }).spawn).toEqual([]);
    expect(plan({ requests: [req(1)], cap: 0 }).spawn).toEqual([]);
    expect(plan({ requests: [req(1)], cap: -5 }).spawn).toEqual([]);
  });

  it("accounts for EVERY request — spawned + skipped is always the whole input", () => {
    // The property that makes silent non-work impossible: nothing may vanish from the plan.
    const requests = [req(1), req(2), req(3, { cmd: "dup" }), req(4, { cmd: "dup" }), req(5)];
    for (const cap of [0, 1, 3, 99]) {
      for (const enabled of [true, false] as const) {
        const p = plan({ requests, active: [req(2)], enabled, cap });
        const seen = [...p.spawn.map((r) => r.id), ...p.skipped.map((s) => s.request.id)].sort();
        expect(seen, `cap=${cap} enabled=${enabled}`).toEqual([1, 2, 3, 4, 5]);
        for (const s of p.skipped) expect(s.reason.length, "every skip states why").toBeGreaterThan(0);
      }
    }
  });

  it("is stable — planning the same input twice gives the same plan", () => {
    const requests = [req(3), req(1), req(2)];
    expect(plan({ requests, cap: 2 })).toEqual(plan({ requests, cap: 2 }));
  });
});

describe("the plan can only ever name the debugger (#3498)", () => {
  it("stamps role='debugger' on every plan, spawning or not", () => {
    // The launcher READS this rather than choosing a role, so it cannot start a `planner`, `designer`,
    // `worker` or anything else. Asked directly by the maintainer: is auto-spawn debugger-only? This
    // is the assertion that answers it at the type AND value level.
    expect(plan({ requests: [req(1)], cap: 1 }).role).toBe("debugger");
    expect(plan({ requests: [req(1)], enabled: false }).role).toBe("debugger");
    expect(plan({}).role).toBe("debugger");
  });
});
