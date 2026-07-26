// The design-loop banner's TRIGGER + kill switch (#3304 over #3292). The banner is the whole user-facing
// surface of an autonomous, token-spending run, so the properties asserted here are: the run is OPT-IN
// (a click, never automatic), the Stop is always reachable while a loop is open, and stopping an overnight
// run goes through the store action (which keeps retrying) rather than a fire-and-forget CLI call.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "7"),
  bscRun: vi.fn(async () => undefined),
  bscJson: vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback),
  bscWrite: vi.fn(async () => undefined),
}));

import { bscRun } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import { DesignerLoopBanner } from "./DesignerLoopBanner";
import { publishDesignerLoopState } from "./useDesignerLoopState";

// Two tests swap a store ACTION for a spy. Captured up-front and restored per test, so the swap can't
// leak into a later test and make this file order-dependent.
const REAL_ACTIONS = {
  startDesignerOvernight: useAppStore.getState().startDesignerOvernight,
  stopDesignerOvernight: useAppStore.getState().stopDesignerOvernight,
};

/** Publish the loop the banner should render (#3850). The banner makes NO `bsc` calls now — the pump owns
 *  the read and publishes; this stands in for the pump. `null` is the idle (no open loop) state. */
function showLoop(loop: { id: number; changes: number; cost: number } | null) {
  publishDesignerLoopState(loop);
}

/** Render and let the immediate poll settle. */
async function mount() {
  const r = render(<DesignerLoopBanner />);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return r;
}

describe("DesignerLoopBanner (#3292/#3304)", () => {
  beforeEach(() => {
    vi.mocked(bscRun).mockReset().mockResolvedValue(undefined);
    useAppStore.setState({ designerOvernight: null, ...REAL_ACTIONS });
    showLoop(null);
  });

  it("offers the opt-in trigger when idle — and starts NOTHING on its own", async () => {
    await mount();

    expect(screen.getByRole("button", { name: /auto-improve/i })).toBeInTheDocument();
    expect(useAppStore.getState().designerOvernight).toBeNull(); // mounting never starts a run
    expect(bscRun).not.toHaveBeenCalled();
  });

  it("starts the overnight run only on a click", async () => {
    const start = vi.fn(async () => undefined);
    useAppStore.setState({ startDesignerOvernight: start });
    await mount();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /auto-improve/i })); });

    expect(start).toHaveBeenCalledTimes(1);
  });

  it("shows the live run — id, change count, cost — with the reachable Stop", async () => {
    showLoop({ id: 7, changes: 1, cost: 1.5 }); // one designer turn = one shot-paired change
    await mount();

    expect(screen.getByText(/design loop #7/)).toBeInTheDocument();
    expect(screen.getByText(/1 change · \$1\.50/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^stop$/i })).toBeInTheDocument();
  });

  it("surfaces the overnight run's progress against its ceiling", async () => {
    showLoop({ id: 7, changes: 0, cost: 0.25 });
    useAppStore.setState({
      designerOvernight: { loopId: 7, maxTurns: 40, budget: 10, cursor: 3, queue: [], stopping: false, startedAt: 1 },
    });
    await mount();

    expect(screen.getByText(/auto 3\/40/)).toBeInTheDocument();
  });

  it("stops a plain interactive loop out-of-band via `bsc loop stop`", async () => {
    showLoop({ id: 7, changes: 0, cost: 0 });
    await mount();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^stop$/i })); });

    expect(bscRun).toHaveBeenCalledWith(null, ["loop", "stop", "7"]);
  });

  it("stops an OVERNIGHT run through the store action, so the halt is retried until it lands", async () => {
    const stop = vi.fn(async () => undefined);
    showLoop({ id: 7, changes: 0, cost: 0 });
    useAppStore.setState({
      designerOvernight: { loopId: 7, maxTurns: 40, budget: 10, cursor: 1, queue: [], stopping: false, startedAt: 1 },
      stopDesignerOvernight: stop,
    });
    await mount();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^stop$/i })); });

    expect(stop).toHaveBeenCalledTimes(1);
    // NOT the raw fire-and-forget stop — that path drops the retry the store action owns.
    expect(bscRun).not.toHaveBeenCalledWith(null, ["loop", "stop", "7"]);
  });

  it("reports a pending halt and disables Stop, so the run isn't claimed gone before it is", async () => {
    showLoop({ id: 7, changes: 0, cost: 0 });
    useAppStore.setState({
      designerOvernight: { loopId: 7, maxTurns: 40, budget: 10, cursor: 1, queue: [], stopping: true, startedAt: 1 },
    });
    await mount();

    const btn = screen.getByRole("button", { name: /stopping/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/design loop #7/)).toBeInTheDocument(); // still shown — not yet observed gone
  });
});
