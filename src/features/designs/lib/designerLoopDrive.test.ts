import { describe, it, expect } from "vitest";
import {
  decideLoopPumpAction,
  pickDesignerLoop,
  whoseTurn,
  DRIVER,
  DESIGNER,
  type LoopRow,
  type LoopTurn,
} from "./designerLoopDrive";

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

describe("decideLoopPumpAction (#3292)", () => {
  it("idle when there is no open loop", () => {
    expect(decideLoopPumpAction({ loop: null, turns: [], now: 0, lastInjectAt: 0, nudgeAfterMs: 1000 }).kind).toBe("idle");
    expect(
      decideLoopPumpAction({ loop: loop({ status: "closed" }), turns: [], now: 0, lastInjectAt: 0, nudgeAfterMs: 1000 }).kind,
    ).toBe("idle");
  });

  it("continues on the DRIVER's turn (post + inject the next-change prompt)", () => {
    // No turns yet → it's the driver's turn (a first) → kick off.
    const a1 = decideLoopPumpAction({ loop: loop(), turns: [], now: 0, lastInjectAt: 0, nudgeAfterMs: 1000 });
    expect(a1.kind).toBe("continue");
    expect(a1.kind === "continue" && a1.prompt).toMatch(/Design loop #1/);
    // Designer recorded (driver, designer) → driver's turn again → continue.
    expect(decideLoopPumpAction({ loop: loop(), turns: turns(DRIVER, DESIGNER), now: 0, lastInjectAt: 0, nudgeAfterMs: 1000 }).kind).toBe("continue");
  });

  it("WAITS on the designer's turn (the designer is working) — it never floods", () => {
    // Driver posted its turn → designer's turn → wait (within the nudge window).
    const a = decideLoopPumpAction({ loop: loop(), turns: turns(DRIVER), now: 5000, lastInjectAt: 5000, nudgeAfterMs: 90_000 });
    expect(a.kind).toBe("wait");
  });

  it("NUDGES once the designer has stalled past the nudge timeout", () => {
    const a = decideLoopPumpAction({ loop: loop(), turns: turns(DRIVER), now: 200_000, lastInjectAt: 5000, nudgeAfterMs: 90_000 });
    expect(a.kind).toBe("nudge");
    expect(a.kind === "nudge" && a.prompt).toMatch(/record your last change/);
  });

  it("the injected prompts are single-line (injectPrompt submits on CR)", () => {
    const a = decideLoopPumpAction({ loop: loop(), turns: [], now: 0, lastInjectAt: 0, nudgeAfterMs: 1000 });
    expect(a.kind === "continue" && a.prompt.includes("\n")).toBe(false);
  });
});
