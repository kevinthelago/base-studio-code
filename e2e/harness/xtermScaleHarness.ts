// Harness for `the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom` — a REAL xterm under a
// REAL CSS transform, in a real engine.
//
// WHY THIS CANNOT BE A UNIT TEST. xterm resolves a mouse event to a cell by mixing two coordinate
// spaces that a CSS transform separates:
//
//   getCoordsRelativeToElement:  e.clientX - element.getBoundingClientRect().left - padding
//   getMouseReportCoords:        Math.floor(coords[0] / dimensions.css.cell.width)
//   CharSizeService.measure():   this._measureElement.offsetWidth / 32
//
// `getBoundingClientRect()` IS transform-adjusted; `offsetWidth` is NOT. jsdom has neither a cascade
// nor layout and reports every metric as 0, so the mismatch is structurally invisible to vitest. That
// is not a hypothetical: #3524 shipped unit tests asserting the counter-scale MECHANISM, was merged
// with them green, and was reverted eight minutes later because nothing had observed the OUTCOME.
//
// So the harness deliberately reads NOTHING from xterm's internals. It exposes the screen element's
// live (scaled) rect and the public `cols`/`rows`, and lets the spec derive the visual cell size the
// way a user's eye does — rect ÷ grid. The only thing it reports back is what xterm itself SAID the
// click was, decoded from the terminal's own SGR mouse report. That is the same path a TUI uses to
// read a click, so a green spec means Claude's "Yes" button is actually hittable.
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
// The APP's own functions, not copies. The whole point of driving the real chain is that a spec cannot
// pass against geometry the app does not actually paint — so the harness composes exactly the two
// transforms `useGraphViewport.applyView` writes, and a change to either is a change to this test.
import { viewTransform, counterScaleTransform } from "@/shared/ui/layouts/useGraphViewport";

/** A 1-based terminal cell, as the SGR mouse report encodes it. */
export interface ReportedCell { col: number; row: number }

/** The screen element's live bounding rect — SCALED, i.e. what the user sees and aims at. */
export interface ScreenRect { left: number; top: number; width: number; height: number }

declare global {
  interface Window {
    __xtermScaleHarness?: {
      /** Mount a terminal of exactly `cols`×`rows` at world position `(x,y)`, with mouse reporting on.
       *  Resolves once the enabling escape sequence has been parsed, so a click straight after mount is
       *  already reported.
       *
       *  `counterScale` selects which SHAPE is under the terminal: `true` is what Glance ships (the
       *  anchor cancels the world scale, so the terminal's net CSS scale is 1), `false` is the pre-fix
       *  shape with the terminal directly under `scale(view.scale)`. Both are exercised, because a spec
       *  that only ever mounts the fixed shape cannot tell a working counter-scale from a browser that
       *  never needed one. */
      mount(opts: { cols: number; rows: number; x?: number; y?: number; counterScale?: boolean }): Promise<void>;
      /** Paint the view: the world layer's `viewTransform()` and the anchor's `counterScaleTransform()`,
       *  from one value in one call — the same pairing `applyView` guarantees. Separate from `mount` so a
       *  spec can prove the result is independent of whether the scale was applied BEFORE or AFTER xterm
       *  measured itself — `offsetWidth` ignores transforms, so re-measuring neither breaks nor saves it,
       *  and a spec that only ever zoomed-then-mounted would leave that hypothesis alive. */
      setView(v: { tx: number; ty: number; scale: number }): void;
      /** The screen element's rect in VIEWPORT coordinates — transform-adjusted, so this is the box the
       *  user actually sees. Read live; never cached. */
      screenRect(): ScreenRect;
      /** The terminal's public grid size. */
      geometry(): { cols: number; rows: number };
      /** The cell of the most recent mouse PRESS, as xterm reported it. Null until one arrives. */
      lastReport(): ReportedCell | null;
      /** Forget the last report, so a spec can tell "xterm said the wrong cell" from "xterm said
       *  nothing at all" — two very different failures that an un-reset harness conflates. */
      clear(): void;
    };
  }
}

const card = document.getElementById("card") as HTMLDivElement;
const world = document.getElementById("world") as HTMLDivElement;
const anchor = document.getElementById("anchor") as HTMLDivElement;

let term: Terminal | null = null;
let last: ReportedCell | null = null;

/** SGR mouse report: `ESC [ < btn ; col ; row (M|m)`. `M` is the press, `m` the release — we keep the
 *  press, because that is the event a TUI acts on. Both carry 1-BASED coordinates. */
// ESC (0x1b) IS the protocol here. `no-control-regex` guards against a control character typed into a
// regex by accident; this one is the literal first byte of every SGR mouse report, and writing it as
// anything else would only obscure what is being matched.
// eslint-disable-next-line no-control-regex
const SGR = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Whether the anchor cancels the world scale — i.e. whether the SHIPPED shape is mounted. */
let counterScaled = true;

/**
 * Paint both transforms, in the same call and from the same view — which is the invariant the fix
 * depends on, so the harness must not be able to satisfy it in some other order.
 */
function setView(v: { tx: number; ty: number; scale: number }): void {
  world.style.transform = viewTransform(v);
  anchor.style.transform = counterScaled ? counterScaleTransform(v) : "";
}

window.__xtermScaleHarness = {
  async mount({ cols, rows, x = 0, y = 0, counterScale = true }) {
    counterScaled = counterScale;
    term?.dispose();
    card.innerHTML = "";
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    last = null;

    // A FIXED cols×rows, and no fit addon on purpose. The defect is about mapping a point to a cell;
    // letting the grid be derived from a measured box would make the grid itself move with the scale
    // and turn one question into two.
    term = new Terminal({
      cols, rows,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 14,
      lineHeight: 1.4,
      // Deterministic pixels: an animating cursor changes what a screenshot shows and buys nothing here.
      cursorBlink: false,
      allowTransparency: false,
    });
    term.open(card);
    term.onData((d) => {
      SGR.lastIndex = 0;
      for (let m = SGR.exec(d); m; m = SGR.exec(d)) {
        if (m[4] === "M") last = { col: Number(m[2]), row: Number(m[3]) };
      }
    });

    // `?1000h` = report button presses; `?1006h` = encode them as SGR (decimal, so no 223-column
    // ceiling to confuse a wrong answer with a saturated one). This is exactly what Claude Code's TUI
    // turns on, which is why a click that reports the wrong cell misses its "Yes".
    await new Promise<void>((resolve) => term!.write("\x1b[?1000h\x1b[?1006h", resolve));
  },

  setView,

  screenRect() {
    const el = card.querySelector(".xterm-screen") as HTMLElement | null;
    if (!el) throw new Error("no .xterm-screen — mount() first");
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  },

  geometry() {
    if (!term) throw new Error("no terminal — mount() first");
    return { cols: term.cols, rows: term.rows };
  },

  lastReport: () => last,
  clear() { last = null; },
};

// A neutral starting view, so a spec that forgets `setView` gets the identity transform rather than
// whatever the previous test left behind.
setView({ tx: 0, ty: 0, scale: 1 });
