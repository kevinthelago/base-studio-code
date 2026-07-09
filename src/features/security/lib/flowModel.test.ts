import { describe, it, expect } from "vitest";
import { flowSummary, depColor } from "./flowModel";
import type { BlockedView, Waiter } from "@/shared/lib/fleet/coordination";

const view = (over: Partial<BlockedView>): BlockedView => ({
  session: "t0p0", deps: [], stalled: false, deadlocked: false, ...over,
});
const waiter = (session: string): Waiter => ({ session, deps: [], registeredAt: 0 });

describe("flowSummary (#1643)", () => {
  it("counts stalled + deadlocked and is idle when nothing is in flight", () => {
    expect(flowSummary([], [])).toEqual({ stalled: 0, deadlocked: 0, idle: true });
  });

  it("tallies stalled/deadlocked views and is not idle", () => {
    const views = [view({ stalled: true }), view({ session: "t0p1", deadlocked: true })];
    const s = flowSummary(views, [waiter("t0p2")]);
    expect(s.stalled).toBe(1);
    expect(s.deadlocked).toBe(1);
    expect(s.idle).toBe(false);
  });
});

describe("depColor (#1643)", () => {
  it("maps dependency status to a color token", () => {
    expect(depColor("satisfied")).toBe("var(--success)");
    expect(depColor("failed")).toBe("var(--danger)");
    expect(depColor("pending")).toBe("var(--fg-dim)");
  });
});
