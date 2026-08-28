/**
 * @vitest-environment jsdom
 *
 * Under `src/**\/lib/**` the project environment is `node`, on the rule that a `lib/` module is pure,
 * React-free domain logic. Half of this one is — `terminalOwnsWheel` is a predicate over three numbers —
 * but the other half is the event wiring, and EVENT PROPAGATION is precisely what the bug is about. A
 * `node` run would assert the predicate and never touch the thing that regressed twice.
 */
// Regression test for "a terminal at the end of its scrollback still zooms the Glance graph".
//
// This one CAN be a jsdom test, and it is worth saying why, because the sibling guard it replaces could
// not be. `graphViewportWheel.test.ts` has to drive `overScrollableChild` with hand-built element stubs:
// it asks about LAYOUT (`scrollHeight > clientHeight`), and jsdom reports every layout metric as 0. What
// is under test here is EVENT PROPAGATION, which jsdom implements for real — so the assertion is the
// actual thing the bug is about ("did the ancestor's zoom listener hear this wheel?") rather than a proxy
// for it.
//
// The shape below is the real one: a graph canvas with a wheel-to-zoom listener, the terminal slot inside
// it, and the wheel dispatched from a node inside xterm's `.xterm-screen` — which is where a real wheel
// over terminal text lands, and which is NOT a descendant of `.xterm-viewport`.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { containTerminalWheel, terminalOwnsWheel, type TerminalWheelState } from "@/app/console/lib/terminalWheel";

/** A terminal with `scrollback` lines of history above a `rows`-tall viewport. */
function term(opts: { rows?: number; scrollback?: number; alternate?: boolean } = {}): TerminalWheelState {
  const rows = opts.rows ?? 24;
  return {
    rows,
    buffer: { active: { length: rows + (opts.scrollback ?? 0), type: opts.alternate ? "alternate" : "normal" } },
  };
}

describe("terminalOwnsWheel — when the terminal claims the gesture", () => {
  it("claims it while there is scrollback", () => {
    expect(terminalOwnsWheel(term({ scrollback: 500 }))).toBe(true);
  });

  it("STILL claims it at the very end of the scrollback — the bug", () => {
    // Nothing about this predicate changes as the user scrolls: scrollback either exists or it does not.
    // That is the point. A direction-aware guard flipped to false on the last line and handed the rest of
    // one continuous gesture to the canvas.
    expect(terminalOwnsWheel(term({ scrollback: 500 }))).toBe(true);
  });

  it("claims it for a full-screen application, which has no scrollback at all", () => {
    expect(terminalOwnsWheel(term({ alternate: true }))).toBe(true);
  });

  it("does NOT claim it for a short log — a pane with nothing to scroll still zooms the canvas", () => {
    expect(terminalOwnsWheel(term({ scrollback: 0 }))).toBe(false);
  });
});

/** A wheel listener spy. Typed, because a bare `vi.fn()` is `Mock<Procedure | Constructable>` and does not
 *  satisfy `addEventListener`'s listener overloads. */
const wheelSpy = () => vi.fn<(e: WheelEvent) => void>();

describe("containTerminalWheel — the canvas ancestor never hears a contained wheel", () => {
  let canvas: HTMLDivElement;
  let slot: HTMLDivElement;
  let screen: HTMLDivElement;
  let zoom: ReturnType<typeof wheelSpy>;
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    // graph canvas → terminal slot → .xterm → .xterm-screen → the row the pointer is over
    canvas = document.createElement("div");
    slot = document.createElement("div");
    const xterm = document.createElement("div");
    xterm.className = "xterm";
    screen = document.createElement("div");
    screen.className = "xterm-screen";
    // The element xterm's own scrolling uses. A SIBLING of the screen, exactly as xterm builds it — which
    // is half of why the canvas-side ancestor walk could never find it.
    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    xterm.append(viewport, screen);
    slot.appendChild(xterm);
    canvas.appendChild(slot);
    document.body.appendChild(canvas);

    zoom = wheelSpy();
    canvas.addEventListener("wheel", zoom); // the graph canvas's zoom listener
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    canvas.remove();
  });

  const wheel = () => screen.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: 120 }));

  it("without containment the wheel reaches the canvas — the reported bug", () => {
    wheel();
    expect(zoom).toHaveBeenCalledTimes(1);
  });

  it("contains a wheel over a terminal with scrollback", () => {
    dispose = containTerminalWheel(slot, term({ scrollback: 500 }));
    wheel();
    expect(zoom).not.toHaveBeenCalled();
  });

  it("lets a wheel over a scrollback-less pane through to the canvas", () => {
    dispose = containTerminalWheel(slot, term({ scrollback: 0 }));
    wheel();
    expect(zoom).toHaveBeenCalledTimes(1);
  });

  it("does not swallow the event from other listeners on the slot itself", () => {
    // stopPropagation, not stopImmediatePropagation: the clipboard/focus listeners on this same element
    // still need the event.
    const sibling = wheelSpy();
    slot.addEventListener("wheel", sibling);
    dispose = containTerminalWheel(slot, term({ scrollback: 500 }));
    wheel();
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(zoom).not.toHaveBeenCalled();
  });

  it("re-exposes the canvas once disposed — a torn-down pane leaves no listener behind", () => {
    const off = containTerminalWheel(slot, term({ scrollback: 500 }));
    off();
    wheel();
    expect(zoom).toHaveBeenCalledTimes(1);
  });
});
