import { describe, it, expect, vi, afterEach } from "vitest";
import { overScrollableChild } from "@/shared/ui/layouts/useGraphViewport";

// jsdom gives every element scrollHeight/clientHeight of 0 and no real cascade, so this behaviour is
// structurally unobservable through a render — the #3251 lesson, one layer down. Drive it with explicit
// stubs instead, which is the only way to state "this element scrolls and has room left".

type Stub = { overflowY: string; scrollHeight: number; clientHeight: number; scrollTop: number };

/** Build a target → … → viewport chain (target first) with a computed-style stub for each. */
function chain(...nodes: (Stub | null)[]) {
  const styles = new Map<Element, { overflowY: string }>();
  // Define OWN data properties rather than `Object.assign`-ing them. `parentElement`, `scrollHeight`,
  // `clientHeight` and `scrollTop` are getter-only accessors inherited from `Node`/`Element.prototype`, and
  // assignment writes THROUGH the prototype accessor — `TypeError: Cannot set property parentElement of
  // [object Node] which has only a getter`, thrown while building the fixture, before any assertion runs.
  // An own property shadows the accessor instead. (That threw for every case from the day this file was
  // written, which is why these five had never actually executed.)
  const own = (el: object, values: Record<string, unknown>) => {
    for (const [k, value] of Object.entries(values)) {
      Object.defineProperty(el, k, { value, writable: true, configurable: true });
    }
  };
  const built = nodes.map((n) => {
    const el = Object.create(Element.prototype) as Element;
    own(el, {
      parentElement: null,
      scrollHeight: n?.scrollHeight ?? 0,
      clientHeight: n?.clientHeight ?? 0,
      scrollTop: n?.scrollTop ?? 0,
    });
    styles.set(el, { overflowY: n?.overflowY ?? "visible" });
    return el;
  });
  built.forEach((el, i) => { own(el, { parentElement: built[i + 1] ?? null }); });
  vi.stubGlobal("getComputedStyle", (el: Element) => styles.get(el) ?? { overflowY: "visible" });
  return { target: built[0], viewport: built[built.length - 1] };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("overScrollableChild — the canvas yields the wheel to a child that can scroll", () => {
  it("yields when a scrollable ancestor has room to scroll DOWN", () => {
    const { target, viewport } = chain(
      null,                                                                   // the wheel's target
      { overflowY: "auto", scrollHeight: 1000, clientHeight: 300, scrollTop: 0 }, // a terminal viewport
      null,                                                                   // the canvas viewport
    );
    expect(overScrollableChild(target, viewport, 120)).toBe(true);
  });

  it("does NOT yield over the bare canvas — zoom is unchanged where nothing wants the wheel", () => {
    const { target, viewport } = chain(null, null, null);
    expect(overScrollableChild(target, viewport, 120)).toBe(false);
  });

  it("does NOT yield for an element that declares overflow but does not actually overflow", () => {
    // A node card with `overflow: auto` and short content is not asking for the wheel.
    const { target, viewport } = chain(
      null,
      { overflowY: "auto", scrollHeight: 200, clientHeight: 200, scrollTop: 0 },
      null,
    );
    expect(overScrollableChild(target, viewport, 120)).toBe(false);
  });

  it("hands the wheel BACK at the end of the child's range, so the gesture never dead-ends", () => {
    const atBottom = { overflowY: "auto", scrollHeight: 1000, clientHeight: 300, scrollTop: 700 };
    const { target, viewport } = chain(null, atBottom, null);
    expect(overScrollableChild(target, viewport, 120)).toBe(false); // further down → canvas zooms
    expect(overScrollableChild(target, viewport, -120)).toBe(true); // back up → still the child's
  });

  it("stops at the viewport — a scrollable ancestor ABOVE the canvas is not a reason to yield", () => {
    // The page shell may scroll; that must not disable canvas zoom.
    const { target, viewport } = chain(null, null, null);
    (viewport as unknown as Stub & Element).scrollHeight = 5000;
    expect(overScrollableChild(target, viewport, 120)).toBe(false);
  });
});
