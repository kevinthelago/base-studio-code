// The overnight designer-loop STORE actions (#3304, epic #3260) — the mode/budget flag the pump and the
// banner both drive. The properties under test are the SAFETY ones: it never auto-starts, it never stacks
// two runs, it refuses to enter the mode without a real loop behind it, and a stop is a request that stays
// pending (so the pump keeps retrying) rather than a local flag flip that could strand a live loop.
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "7"),
  bscRun: vi.fn(async () => undefined),
  bscJson: vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback),
  bscWrite: vi.fn(async () => undefined),
}));

import { bsc, bscRun } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { DEFAULT_MAX_TURNS } from "./lib/designerLoopDrive";
import type { DesignDirective } from "./lib/designerQueue";

const directive = (id: string): DesignDirective => ({ id, kind: "polish", title: `T ${id}`, detail: `D ${id}` });

/** The args of the last `bsc` call (the tests assert flags order-independently). */
const lastBscArgs = (): string[] => {
  const calls = vi.mocked(bsc).mock.calls;
  return calls.length ? calls[calls.length - 1][1] : [];
};

describe("overnight designer-loop store actions (#3304)", () => {
  beforeEach(() => {
    vi.mocked(bsc).mockReset().mockResolvedValue("7");
    vi.mocked(bscRun).mockReset().mockResolvedValue(undefined);
    useAppStore.setState({ designerOvernight: null });
  });

  it("is OFF at rest — the mode never starts on its own", () => {
    expect(useAppStore.getState().designerOvernight).toBeNull();
  });

  it("opens a `--until false` loop carrying BOTH ceilings, then enters the mode", async () => {
    await useAppStore.getState().startDesignerOvernight({ maxTurns: 5, budget: 3 });

    const args = lastBscArgs();
    expect(args.slice(0, 4)).toEqual(["loop", "new", "driver", "designer"]);
    expect(args).toContain("--until");
    expect(args[args.indexOf("--until") + 1]).toBe("false");
    // The loop store's turn cap counts EVERY turn (driver + designer ≈ 2 per directive), so it is passed
    // looser than the pump's directive ceiling — the backstop must not fire before the pump does.
    expect(Number(args[args.indexOf("--max-turns") + 1])).toBeGreaterThan(5 * 2);
    expect(args[args.indexOf("--budget") + 1]).toBe("3");

    const run = useAppStore.getState().designerOvernight;
    expect(run).toMatchObject({ loopId: 7, maxTurns: 5, budget: 3, cursor: 0, queue: [], stopping: false });
  });

  it("defaults to the core's turn ceiling when none is given", async () => {
    await useAppStore.getState().startDesignerOvernight();
    expect(useAppStore.getState().designerOvernight?.maxTurns).toBe(DEFAULT_MAX_TURNS);
  });

  it("omits --budget when the budget is 0 (unlimited), keeping the turn ceiling", async () => {
    await useAppStore.getState().startDesignerOvernight({ budget: 0 });
    const args = lastBscArgs();
    expect(args).not.toContain("--budget");
    expect(args).toContain("--max-turns");
  });

  it("stays OFF when `bsc loop new` fails — a run with no loop behind it would drive nothing", async () => {
    vi.mocked(bsc).mockRejectedValue(new Error("bridge absent"));
    await useAppStore.getState().startDesignerOvernight();
    expect(useAppStore.getState().designerOvernight).toBeNull();
  });

  it("stays OFF when `bsc loop new` prints no id", async () => {
    vi.mocked(bsc).mockResolvedValue("not-an-id");
    await useAppStore.getState().startDesignerOvernight();
    expect(useAppStore.getState().designerOvernight).toBeNull();
  });

  it("never stacks a second run onto the same designer session", async () => {
    await useAppStore.getState().startDesignerOvernight({ maxTurns: 5 });
    vi.mocked(bsc).mockClear();
    await useAppStore.getState().startDesignerOvernight({ maxTurns: 99 });

    expect(bsc).not.toHaveBeenCalled(); // no second loop opened
    expect(useAppStore.getState().designerOvernight?.maxTurns).toBe(5); // the first run is untouched
  });

  it("stop FLAGS the run and issues the halt, but keeps the run pending so the pump retries", async () => {
    await useAppStore.getState().startDesignerOvernight();
    await useAppStore.getState().stopDesignerOvernight();

    expect(bscRun).toHaveBeenCalledWith(null, ["loop", "stop", "7"]);
    // Deliberately NOT cleared: the pump owns the teardown, once the loop is observably gone. Clearing
    // here on a swallowed CLI failure would hand a still-open loop back to the ceiling-less path.
    expect(useAppStore.getState().designerOvernight).toMatchObject({ loopId: 7, stopping: true });
  });

  it("stop is a safe no-op when nothing is running", async () => {
    await useAppStore.getState().stopDesignerOvernight();
    expect(bscRun).not.toHaveBeenCalled();
  });

  it("endDesignerOvernight leaves the mode (the pump's teardown once the loop is gone)", async () => {
    await useAppStore.getState().startDesignerOvernight();
    useAppStore.getState().endDesignerOvernight();
    expect(useAppStore.getState().designerOvernight).toBeNull();
  });

  it("installs the queue and advances the cursor one directive at a time", async () => {
    await useAppStore.getState().startDesignerOvernight({ maxTurns: 3 });
    useAppStore.getState().setDesignerOvernightQueue([directive("a"), directive("b")]);
    expect(useAppStore.getState().designerOvernight?.queue).toHaveLength(2);

    useAppStore.getState().advanceDesignerOvernight();
    useAppStore.getState().advanceDesignerOvernight();
    expect(useAppStore.getState().designerOvernight?.cursor).toBe(2);
  });

  it("queue/cursor writes are no-ops when no run is active (a late tick after a stop)", () => {
    useAppStore.getState().setDesignerOvernightQueue([directive("a")]);
    useAppStore.getState().advanceDesignerOvernight();
    expect(useAppStore.getState().designerOvernight).toBeNull();
  });
});
