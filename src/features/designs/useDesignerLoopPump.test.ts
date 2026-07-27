// The designer-loop pump's QUEUE / OVERNIGHT mode (#3304, epic #3260) — the wiring that makes the pure
// core (`buildDesignerQueue` + `decideOvernightAction`) actually drive the live session. The interactive
// mode (#3292) is covered here too as a regression: opting into overnight must not change it.
//
// The load-bearing assertions are the ones about STOPPING, because this loop spends tokens unattended:
// a stopping run dispatches nothing and keeps retrying the halt, a ceiling reached requests the halt, and
// a vanished loop tears the mode down.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/shared/lib/core/bsc", () => ({
  bsc: vi.fn(async () => "7"),
  bscRun: vi.fn(async () => undefined),
  bscJson: vi.fn(async (_k: unknown, _a: unknown, fallback: unknown) => fallback),
  bscWrite: vi.fn(async () => undefined),
}));
vi.mock("@/shared/lib/fleet/paneInject", () => ({ injectPrompt: vi.fn(async () => undefined) }));

import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { useAppStore } from "@/store";
import { useDesignerLoopPump } from "./useDesignerLoopPump";
import type { DesignDirective } from "./lib/designerQueue";

const LOOP = { id: 7, a: "driver", b: "designer", status: "open" };

/** Turn lists that put the loop on a given side: `a` speaks first, strict alternation. */
const DRIVERS_TURN: { participant: string }[] = []; //                    nothing said yet → driver
const DESIGNERS_TURN = [{ participant: "driver" }]; //                    driver spoke     → designer

const directive = (id: string, kind: DesignDirective["kind"] = "polish"): DesignDirective => ({
  id, kind, title: `T ${id}`, detail: `D ${id}`,
});

interface Responses {
  loops?: unknown;
  turns?: { participant: string }[];
  coverage?: unknown;
  resolve?: unknown;
  shot?: unknown;
}

/** Route each `bscJson` call by the subcommand the pump asked for. */
function routeBsc(r: Responses) {
  vi.mocked(bscJson).mockImplementation(async (_key: unknown, args: unknown, fallback: unknown) => {
    const a = args as string[];
    if (a[0] === "loop" && a[1] === "list") return r.loops ?? [LOOP];
    if (a[0] === "loop" && a[1] === "show") return { turns: r.turns ?? DRIVERS_TURN, total_cost: 0 };
    if (a[0] === "ui" && a[1] === "components") return r.coverage ?? null;
    if (a[0] === "ui" && a[1] === "resolve") return r.resolve ?? null;
    // `in`, not `??` — an EXPLICIT `shot: null` is the failed-capture case, not "use the default".
    if (a[0] === "shot") return "shot" in r ? r.shot : { path: "/shots/a.png", w: 10, h: 10 };
    return fallback;
  });
}

/** Mount the pump and let its immediate first tick settle. */
async function tick() {
  const h = renderHook(() => useDesignerLoopPump());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
  h.unmount();
}

/** The `bsc loop say` calls the pump posted, as arg arrays. */
const sayCalls = () =>
  vi.mocked(bscRun).mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === "loop" && a[1] === "say");
const stopCalls = () =>
  vi.mocked(bscRun).mock.calls.map((c) => c[1] as string[]).filter((a) => a[0] === "loop" && a[1] === "stop");

function setRun(over: Partial<{ maxTurns: number; cursor: number; queue: DesignDirective[]; stopping: boolean; loopId: number }>) {
  useAppStore.setState({
    designerOvernight: {
      loopId: 7, maxTurns: 40, budget: 10, cursor: 0, queue: [], stopping: false, startedAt: 1, ...over,
    },
  });
}

describe("useDesignerLoopPump — overnight/queue mode (#3304)", () => {
  beforeEach(() => {
    vi.mocked(bscRun).mockReset().mockResolvedValue(undefined);
    vi.mocked(injectPrompt).mockReset().mockResolvedValue(undefined);
    vi.mocked(bscJson).mockReset();
    useAppStore.setState({ designerOvernight: null, components: [], designsKitId: "k" });
    routeBsc({});
  });

  it("does NOT drive an ORPHAN loop — one this app never started (#3850)", async () => {
    // #3304's fourth brake is that run state is never persisted, so a run cannot survive a restart. An
    // open loop with no run state is therefore either CLI-created or the leftover of a restart, and
    // adopting it would resume spending money after exactly the event the brake exists for. The banner
    // still shows it with a reachable Stop; the pump must leave it alone.
    useAppStore.setState({ designerOvernight: null });
    await tick();
    expect(sayCalls()).toEqual([]);
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(stopCalls()).toEqual([]); // …and it is not force-stopped either — the human owns that call
  });

  it("dispatches the directive at the cursor: shot → driver turn (shot attached) → inject → advance", async () => {
    setRun({ queue: [directive("a"), directive("b")], cursor: 1 });
    await tick();

    // Grounded FIRST — the shot records the state the directive is given against.
    expect(bscJson).toHaveBeenCalledWith(null, ["shot", "preview"], null);

    const say = sayCalls()[0];
    expect(say.slice(0, 5)).toEqual(["loop", "say", "7", "--as", "driver"]);
    expect(say[5]).toBe("[polish] T b"); //          `driverSay` of the directive AT THE CURSOR, not queue[0]
    expect(say.slice(6)).toEqual(["--shot", "/shots/a.png"]);

    const prompt = vi.mocked(injectPrompt).mock.calls[0][1];
    expect(prompt).toContain("T b");
    expect(prompt).toContain("D b");
    expect(useAppStore.getState().designerOvernight?.cursor).toBe(2); // one directive dispatched
  });

  it("grounds a MOTION directive with a --frames burst and reads the burst's first frame", async () => {
    setRun({ queue: [directive("m", "motion")] });
    routeBsc({ shot: { frames: [{ path: "/shots/m-01.png" }, { path: "/shots/m-02.png" }] } });
    await tick();

    expect(bscJson).toHaveBeenCalledWith(null, ["shot", "preview", "--frames", "6"], null);
    expect(sayCalls()[0].slice(6)).toEqual(["--shot", "/shots/m-01.png"]);
  });

  it("still dispatches when the shot fails — an ungrounded turn beats a stalled run", async () => {
    setRun({ queue: [directive("a")] });
    routeBsc({ shot: null });
    await tick();

    expect(sayCalls()[0]).not.toContain("--shot");
    expect(injectPrompt).toHaveBeenCalled();
  });

  it("builds the queue ONCE from the measured gaps before the first dispatch, and waits a tick", async () => {
    setRun({ queue: [] });
    useAppStore.setState({
      components: [{ id: "c1", name: "Button", kitId: "k", role: "control" }] as never,
      designsKitId: "k",
    });
    routeBsc({
      coverage: { leakCandidates: [{ file: "src/a.tsx", count: 3 }], zeroConsumers: [], components: [] },
      resolve: { theme: "t", themeMisses: [], uncontracted: ["--x"], complete: false },
    });
    await tick();

    const q = useAppStore.getState().designerOvernight?.queue ?? [];
    expect(q[0]).toMatchObject({ kind: "leak", target: "src/a.tsx" }); // ground truth ranks first
    expect(q.some((d) => d.kind === "uncontracted")).toBe(true);
    expect(q.some((d) => d.kind === "motion" && d.target === "Button")).toBe(true);
    // Building is not dispatching — the directive goes out on the NEXT tick, against the installed queue.
    expect(sayCalls()).toHaveLength(0);
    expect(injectPrompt).not.toHaveBeenCalled();
  });

  it("never dispatches out of turn — the designer's turn consumes no directive", async () => {
    setRun({ queue: [directive("a")] });
    routeBsc({ turns: DESIGNERS_TURN });
    await tick();

    expect(sayCalls()).toHaveLength(0); //                                       no driver turn posted
    expect(useAppStore.getState().designerOvernight?.cursor).toBe(0); //         no directive consumed
    // A freshly mounted pump has no inject clock, so this reads as a stall and re-prompts the designer to
    // record — the nudge path, which deliberately does NOT post a turn (it must not skew the transcript).
    expect(vi.mocked(injectPrompt).mock.calls[0][1]).toContain("record your last change now");
  });

  // ── the stop paths ────────────────────────────────────────────────────────────────────────────────
  it("requests the halt once the directive ceiling is reached, and dispatches nothing more", async () => {
    setRun({ queue: [directive("a"), directive("b")], cursor: 2, maxTurns: 2 });
    await tick();

    expect(stopCalls()).toEqual([["loop", "stop", "7"]]);
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(useAppStore.getState().designerOvernight?.stopping).toBe(true);
  });

  it("requests the halt when the queue drains (a good end: nothing left to improve)", async () => {
    setRun({ queue: [directive("a")], cursor: 1, maxTurns: 40 });
    await tick();

    expect(stopCalls()).toEqual([["loop", "stop", "7"]]);
    expect(injectPrompt).not.toHaveBeenCalled();
  });

  it("a STOPPING run dispatches nothing and RE-ISSUES the halt, so a swallowed failure retries", async () => {
    setRun({ queue: [directive("a")], stopping: true });
    await tick();

    expect(stopCalls()).toEqual([["loop", "stop", "7"]]); // retried against the still-open loop
    expect(sayCalls()).toHaveLength(0);
    expect(injectPrompt).not.toHaveBeenCalled();
    expect(useAppStore.getState().designerOvernight).not.toBeNull(); // still pending — not yet observed gone
  });

  it("leaves overnight mode once the loop is observably gone", async () => {
    setRun({ queue: [directive("a")], stopping: true });
    routeBsc({ loops: [] });
    await tick();

    expect(useAppStore.getState().designerOvernight).toBeNull();
    expect(injectPrompt).not.toHaveBeenCalled();
  });

  it("leaves overnight mode when the open loop is a DIFFERENT loop than the run's", async () => {
    setRun({ queue: [directive("a")], loopId: 99 });
    await tick();

    expect(useAppStore.getState().designerOvernight).toBeNull();
  });

  it("survives absent coverage/resolve reports — the polish tail still sustains the run", async () => {
    setRun({ queue: [] });
    useAppStore.setState({ components: [], designsKitId: "k" });
    routeBsc({ coverage: null, resolve: null }); // both reports unavailable (old `bsc`, bridge absent)

    await tick();

    // The tolerant parsers yield `null` rather than throwing, and the rotating polish directives keep the
    // queue non-empty — so a missing report degrades the run's GROUNDING, never crashes the pump.
    const q = useAppStore.getState().designerOvernight?.queue ?? [];
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((d) => d.kind === "polish")).toBe(true);
  });

  // ── the interactive mode must be untouched ────────────────────────────────────────────────────────
  it("is dormant when no designer loop is open", async () => {
    routeBsc({ loops: [] });
    await tick();

    expect(bscRun).not.toHaveBeenCalled();
    expect(injectPrompt).not.toHaveBeenCalled();
  });
});
