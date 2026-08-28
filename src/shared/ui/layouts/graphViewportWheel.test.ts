// Who owns a wheel gesture inside a graph canvas — the scroller under the pointer, or the canvas?
//
// The canvas zooms on a NON-PASSIVE native `wheel` listener attached to the viewport element
// (`useGraphViewport`). That placement is why this cannot be solved from the child's side: React attaches
// synthetic handlers at the root container, ABOVE the viewport, so a child calling `stopPropagation()` in
// an `onWheel` runs after the viewport's own listener has already zoomed. The decision has to be made
// inside the canvas handler, which is what `overScrollableChild` is for.
//
// `overScrollableChild` is exported precisely so it can be tested here: jsdom reports every layout metric
// as 0, so no amount of rendering can exercise it — the element stubs below supply the metrics instead.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE DEBUGGING "THE GRAPH STILL ZOOMS OVER A TERMINAL". Two claims elsewhere in this file
// were wrong, cost two rounds of fixes, and are corrected here rather than deleted, so the next reader
// does not re-derive them:
//
//  1. **This guard does NOT cover xterm.** It was written believing "an ancestor that scrolls" reaches
//     xterm's viewport "without naming it". It does not. xterm 6 scrolls SYNTHETICALLY — VS Code's
//     `SmoothScrollableElement` (`.xterm-scrollable-element`) with a drawn scrollbar — so no ancestor of
//     a wheel over terminal text ever reports `scrollHeight > clientHeight`, and this predicate returns
//     false every time. `.xterm-viewport`, the one element that still declares an overflow, is a SIBLING
//     of `.xterm-screen` where the wheel actually lands, so the ancestor walk cannot reach it either.
//     What made it LOOK covered: xterm consumes a wheel (preventDefault + stopPropagation) only when it
//     actually scrolled, so mid-scroll this handler never runs at all — and at the END of the scrollback
//     it does, and zooms. The `overlay` case below is a real property of the predicate; its mention of
//     xterm is provenance for why the branch exists, not evidence that this path is exercised.
//
//  2. **"This cannot be solved from the child's side" is true only of REACT handlers.** React attaches
//     synthetic `onWheel` at the root container, above the viewport, so a synthetic `stopPropagation`
//     does run too late. A NATIVE `addEventListener` on a descendant does not: it fires before this
//     viewport listener in the same bubble phase. That is how the terminal is fixed —
//     `containTerminalWheel` in `@/app/console/lib/terminalWheel`, wired by `TerminalView`, with
//     `terminalWheel.test.ts` asserting the real propagation rather than stubs.
//
// This guard is still correct and still needed for children that DO scroll natively. It is simply not
// the thing that keeps a terminal's wheel out of the canvas.
// ─────────────────────────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, vi, afterEach } from "vitest";
import { overScrollableChild } from "@/shared/ui/layouts/useGraphViewport";

/** An element stub with the three metrics the guard reads, plus a parent chain. */
function el(opts: { overflowY: string; scrollHeight: number; clientHeight: number; scrollTop?: number; parent?: Element | null }) {
  const node = Object.create(Element.prototype) as Element & { parentElement: Element | null };
  Object.defineProperties(node, {
    scrollHeight: { value: opts.scrollHeight },
    clientHeight: { value: opts.clientHeight },
    scrollTop: { value: opts.scrollTop ?? 0, writable: true },
    parentElement: { value: opts.parent ?? null, writable: true },
  });
  STYLES.set(node, opts.overflowY);
  return node;
}

const STYLES = new Map<Element, string>();
const stubStyles = () =>
  vi.stubGlobal("getComputedStyle", (e: Element) => ({ overflowY: STYLES.get(e) ?? "visible" }));

afterEach(() => { vi.unstubAllGlobals(); STYLES.clear(); });

describe("overScrollableChild — the canvas hands the wheel to a scrolling child", () => {
  it("claims the wheel for a scroller AT ITS BOTTOM — the reason this exists", () => {
    // THE BUG. The guard used to require room left in the wheel's direction, so a terminal read down to
    // its last line handed the wheel back and the canvas zoomed — mid-gesture, without the user changing
    // anything about what they were doing. Reading to the end of a session must not throw the graph.
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const term = el({ overflowY: "auto", scrollHeight: 900, clientHeight: 300, scrollTop: 600, parent: viewport });
    expect(overScrollableChild(term, viewport)).toBe(true);
  });

  it("claims it at the TOP too, scrolling further up", () => {
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const term = el({ overflowY: "auto", scrollHeight: 900, clientHeight: 300, scrollTop: 0, parent: viewport });
    expect(overScrollableChild(term, viewport)).toBe(true);
  });

  it("does NOT claim it for a child that does not overflow — a short log still zooms the canvas", () => {
    // The case the direction check was mistakenly credited with protecting. It is the OVERFLOW test that
    // protects it, and that test is untouched: a pane with nothing to scroll never owns the wheel.
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const shortLog = el({ overflowY: "auto", scrollHeight: 200, clientHeight: 300, parent: viewport });
    expect(overScrollableChild(shortLog, viewport)).toBe(false);
  });

  it("does NOT claim it for an overflowing child that cannot scroll (overflow hidden)", () => {
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const clipped = el({ overflowY: "hidden", scrollHeight: 900, clientHeight: 300, parent: viewport });
    expect(overScrollableChild(clipped, viewport)).toBe(false);
  });

  it("finds a scroller ANY distance up the chain, not just the direct target", () => {
    // The wheel's target is whatever text node's element the pointer is over — xterm renders rows deep
    // inside its viewport, so the scroller is never the target itself.
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const term = el({ overflowY: "scroll", scrollHeight: 900, clientHeight: 300, parent: viewport });
    const row = el({ overflowY: "visible", scrollHeight: 0, clientHeight: 0, parent: term });
    const span = el({ overflowY: "visible", scrollHeight: 0, clientHeight: 0, parent: row });
    expect(overScrollableChild(span, viewport)).toBe(true);
  });

  it("STOPS at the viewport — the canvas's own scrollability is not a reason to decline", () => {
    // Walking past `stopAt` would let the viewport (or the page) qualify as "a scrollable child" and the
    // canvas would never zoom at all.
    stubStyles();
    const viewport = el({ overflowY: "auto", scrollHeight: 5000, clientHeight: 500 });
    const plain = el({ overflowY: "visible", scrollHeight: 0, clientHeight: 0, parent: viewport });
    expect(overScrollableChild(plain, viewport)).toBe(false);
  });

  it("is false for a non-Element target rather than throwing", () => {
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    expect(overScrollableChild(null, viewport)).toBe(false);
    expect(overScrollableChild(new EventTarget(), viewport)).toBe(false);
  });

  it("treats `overlay` as scrollable — xterm's viewport uses it on some platforms", () => {
    stubStyles();
    const viewport = el({ overflowY: "hidden", scrollHeight: 0, clientHeight: 0 });
    const term = el({ overflowY: "overlay", scrollHeight: 900, clientHeight: 300, scrollTop: 600, parent: viewport });
    expect(overScrollableChild(term, viewport)).toBe(true);
  });
});

// This rule was written as "the OTHER half of the fix" — the reasoning being that once the canvas
// declines to zoom, the browser handles the wheel natively and would chain it to an ancestor, which
// `overscroll-behavior: contain` stops.
//
// THE PREMISE DOES NOT HOLD FOR XTERM, per point 1 at the top of this file: xterm 6 scrolls
// synthetically, so on `.xterm-viewport` there is no native scroll for the browser to chain and the
// declaration is inert for that purpose. It is kept — it costs nothing and is correct for whatever
// native scrolling does happen here — but it is NOT what keeps the graph still. That is
// `containTerminalWheel`, and this assertion is pinned only so the rule is not removed as dead.
describe("the terminal viewport does not chain its scroll outward", () => {
  it("declares overscroll-behavior: contain", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("src/styles/tokens.css", "utf8");
    const rule = css.slice(css.indexOf(".app .xterm .xterm-viewport"));
    const body = rule.slice(0, rule.indexOf("}"));
    expect(body).toMatch(/overscroll-behavior:\s*contain/);
    // The scroller itself must still exist, or there is nothing to contain.
    expect(body).toMatch(/overflow-y:\s*auto/);
  });
});
