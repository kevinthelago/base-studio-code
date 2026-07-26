import { describe, it, expect } from "vitest";
import {
  decideOvernightAction,
  pickDesignerLoop,
  whoseTurn,
  DRIVER,
  DESIGNER,
  type LoopRow,
  type LoopTurn,
} from "./designerLoopDrive";
import type { DesignDirective } from "./designerQueue";

const loop = (over: Partial<LoopRow> = {}): LoopRow => ({ id: 1, a: DRIVER, b: DESIGNER, status: "open", ...over });
const turns = (...who: string[]): LoopTurn[] => who.map((participant) => ({ participant }));

describe("pickDesignerLoop (#3292)", () => {
  it("picks the OPEN driver↔designer loop, ignoring closed or unrelated loops", () => {
    const loops: LoopRow[] = [
      { id: 5, a: "x", b: "y", status: "open" }, // not a designer loop
      { id: 6, a: DRIVER, b: DESIGNER, status: "closed" }, // closed
      { id: 7, a: DRIVER, b: DESIGNER, status: "open" }, // the one
    ];
    expect(pickDesignerLoop(loops)?.id).toBe(7);
    expect(pickDesignerLoop([{ id: 6, a: DRIVER, b: DESIGNER, status: "closed" }])).toBeNull();
  });
});

describe("whoseTurn (#3292) — a first, strict alternation", () => {
  it("a speaks first, then alternates off the last turn", () => {
    expect(whoseTurn(DRIVER, DESIGNER, turns())).toBe(DRIVER); // no turns → a
    expect(whoseTurn(DRIVER, DESIGNER, turns(DRIVER))).toBe(DESIGNER); // driver spoke → designer
    expect(whoseTurn(DRIVER, DESIGNER, turns(DRIVER, DESIGNER))).toBe(DRIVER); // designer recorded → driver
  });
});


describe("decideOvernightAction (#3311) — the auto-queue variant", () => {
  const dir = (over: Partial<DesignDirective> = {}): DesignDirective => ({ id: "d", kind: "polish", title: "T", detail: "do it.", ...over });
  const q: DesignDirective[] = [dir({ id: "a" }), dir({ id: "b" }), dir({ id: "c" })];
  const base = { turns: [] as LoopTurn[], now: 0, lastInjectAt: 0, nudgeAfterMs: 90_000, queue: q, cursor: 0, maxTurns: 40 };

  it("idle when there is no open loop", () => {
    expect(decideOvernightAction({ ...base, loop: null }).kind).toBe("idle");
  });

  it("DISPATCHES the directive at `cursor` on the driver's turn — single-line, bsc shot preview", () => {
    const a = decideOvernightAction({ ...base, loop: loop(), cursor: 1 });
    expect(a.kind).toBe("direct");
    if (a.kind === "direct") {
      expect(a.directive.id).toBe("b"); // queue[cursor=1]
      expect(a.burst).toBe(false); // polish → a single shot
      expect(a.prompt).toMatch(/Design loop #1/);
      expect(a.prompt.includes("\n")).toBe(false);
      expect(a.prompt).toContain("bsc shot preview");
    }
  });

  it("marks a MOTION directive as a burst (--frames)", () => {
    const a = decideOvernightAction({ ...base, loop: loop(), queue: [dir({ kind: "motion" })], cursor: 0 });
    expect(a.kind === "direct" && a.burst).toBe(true);
    expect(a.kind === "direct" && a.prompt).toContain("bsc shot preview --frames");
  });

  it("STOPS on the budget (maxTurns) — checked before the drain", () => {
    const a = decideOvernightAction({ ...base, loop: loop(), cursor: 40, maxTurns: 40 });
    expect(a.kind).toBe("stop");
    expect(a.kind === "stop" && a.reason).toMatch(/budget/);
  });

  it("STOPS when the queue is drained (a good, finite end — nothing left to improve)", () => {
    const a = decideOvernightAction({ ...base, loop: loop(), cursor: 3, maxTurns: 40 }); // cursor == queue.length
    expect(a.kind).toBe("stop");
    expect(a.kind === "stop" && a.reason).toMatch(/drained/);
  });

  it("WAITS on the designer's turn, NUDGES after a stall (same signal as the interactive loop)", () => {
    expect(decideOvernightAction({ ...base, loop: loop(), turns: turns(DRIVER), now: 5000, lastInjectAt: 5000 }).kind).toBe("wait");
    expect(decideOvernightAction({ ...base, loop: loop(), turns: turns(DRIVER), now: 200_000, lastInjectAt: 5000 }).kind).toBe("nudge");
  });
});
