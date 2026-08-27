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

// The OTHER half of the fix, and it is a separate mechanism rather than a belt-and-braces duplicate.
//
// Declining to zoom (above) means the canvas handler returns WITHOUT `preventDefault`, so the browser
// then handles the wheel natively — and native scroll chaining would walk the gesture up to whatever
// ancestor can scroll. `overscroll-behavior: contain` is what stops that walk at the terminal. Neither
// half is sufficient alone: without the guard the canvas zooms before the browser ever gets the event,
// and without this the browser scrolls something behind the pane after the guard has stepped aside.
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
