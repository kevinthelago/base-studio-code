import { describe, it, expect } from "vitest";
import { applyStallHealth, projectKeyOfSession, STALL_WARN_MS, type WaitLite } from "./agentStall";
import type { ProjectLite } from "./glanceData";

const T0 = 1_720_000_000_000; // a fixed "now" base
const projects: ProjectLite[] = [
  { id: "alpha", name: "Alpha", health: "healthy", activity: "building" },
  { id: "beta", name: "Beta", health: "idle", activity: "building" },
];

describe("projectKeyOfSession", () => {
  it("takes the plan key prefix before the first ':' (worker / director / triage pane ids)", () => {
    expect(projectKeyOfSession("alpha:auth")).toBe("alpha");
    expect(projectKeyOfSession("alpha:director")).toBe("alpha");
    expect(projectKeyOfSession("alpha:own/web:triage")).toBe("alpha");
    expect(projectKeyOfSession("bare")).toBe("bare"); // no colon → whole id
  });
});

describe("applyStallHealth (#2541 watchdog)", () => {
  it("a FRESH wait is calm — activity 'waiting', health untouched", () => {
    const waiting: WaitLite[] = [{ session: "alpha:auth", reason: "awaiting review", at: T0 - 60_000 }]; // 1m
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "alpha")).toMatchObject({ activity: "waiting", health: "healthy" });
    expect(out.find((p) => p.id === "beta")).toEqual(projects[1]); // no wait → untouched
  });

  it("an OVERSTAYED wait escalates to a 'warning' with a duration reason", () => {
    const waiting: WaitLite[] = [{ session: "beta:worker", reason: "no instructions", at: T0 - 12 * 60_000 }]; // 12m
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")).toMatchObject({ activity: "waiting", health: "warning", reason: "no instructions · 12m" });
  });

  it("falls back to a default note when the wait reason is empty", () => {
    const waiting: WaitLite[] = [{ session: "beta:worker", reason: "  ", at: T0 - STALL_WARN_MS - 1 }];
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")?.reason).toMatch(/^no instructions · \d+m$/);
  });

  it("uses the OLDEST outstanding wait per project (longest stall wins)", () => {
    const waiting: WaitLite[] = [
      { session: "beta:w1", reason: "recent", at: T0 - 2 * 60_000 },
      { session: "beta:w2", reason: "stuck", at: T0 - 30 * 60_000 }, // oldest → decides
    ];
    const out = applyStallHealth(projects, waiting, T0);
    expect(out.find((p) => p.id === "beta")).toMatchObject({ health: "warning", reason: "stuck · 30m" });
  });

  it("never DOWNGRADES an already-error project (error beats a stall)", () => {
    const errored: ProjectLite[] = [{ id: "beta", name: "Beta", health: "error", activity: "building", reason: "boom" }];
    const waiting: WaitLite[] = [{ session: "beta:w", reason: "waiting", at: T0 - 20 * 60_000 }];
    const out = applyStallHealth(errored, waiting, T0);
    expect(out[0].health).toBe("error"); // kept; only escalates, never downgrades
  });

  it("no waiting sessions → the input is returned untouched", () => {
    expect(applyStallHealth(projects, [], T0)).toBe(projects);
  });
});
