// #3437 — the decisions behind `bsc debug`. Every capability jsdom cannot provide (hit-testing, real
// rects) is injected, so the logic that MATTERS is pinned here rather than only in a browser.
import { describe, it, expect, vi } from "vitest";
import { inspectDebug, describeElement, labelOf, type InspectDeps } from "./debugBridge";
import type { PreviewFrameEntry } from "@/features/designs";

/** A DOM tree built in jsdom; rects + hit-testing come from the injected deps, not from jsdom.
 *
 *  The body is CLEARED first, and that is load-bearing rather than tidiness: jsdom resolves a scoped
 *  `element.querySelector("#id")` through a document-wide id lookup, so a leftover element carrying the
 *  same id from an earlier test makes the scoped query return **null** — the fixture silently vanishes
 *  and the failure looks like a bug in the code under test. */
function tree(html: string): HTMLElement {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

function deps(over: Partial<InspectDeps> = {}): InspectDeps {
  return {
    at: () => null,
    rectOf: () => ({ x: 10, y: 20, width: 200, height: 100 }),
    stylesOf: () => ({ "pointer-events": "auto", "z-index": "auto", opacity: "1" }),
    query: (sel) => Array.from(document.querySelectorAll(sel)),
    frames: () => [],
    probeEngine: async () => null,
    ...over,
  };
}

describe("labelOf", () => {
  it("identifies an element without dumping the DOM", () => {
    const host = tree(`<div id="a" class="one two three four"></div>`);
    const el = host.querySelector("#a")!;
    // Capped at three classes: this is read by a human mid-debug, not parsed.
    expect(labelOf(el)).toBe("div#a.one.two.three");
    expect(labelOf(tree(`<iframe></iframe>`).querySelector("iframe")!)).toBe("iframe");
  });
});

describe("describeElement — the covered question (#3437)", () => {
  it("is topmost when the hit-test returns the element itself", () => {
    const host = tree(`<div id="target"></div>`);
    const el = host.querySelector("#target")!;
    const info = describeElement(el, deps({ at: () => el }));
    expect(info.topmost_at_centre).toBe(true);
    expect(info.covered_by).toBeUndefined();
  });

  it("is topmost when the hit-test returns a DESCENDANT — the click still reaches this subtree", () => {
    const host = tree(`<div id="target"><span id="kid">x</span></div>`);
    const el = host.querySelector("#target")!;
    const kid = host.querySelector("#kid")!;
    expect(describeElement(el, deps({ at: () => kid })).topmost_at_centre).toBe(true);
  });

  it("is COVERED when something unrelated hit-tests on top, and names it", () => {
    // THE failure this verb exists for: correct rect, correct styles, and the click lands elsewhere.
    const host = tree(`<div id="target"></div><div id="scrim" class="overlay"></div>`);
    const el = host.querySelector("#target")!;
    const scrim = host.querySelector("#scrim")!;
    const info = describeElement(el, deps({ at: () => scrim }));
    expect(info.topmost_at_centre).toBe(false);
    expect(info.covered_by).toBe("div#scrim.overlay");
  });

  it("is COVERED when an ANCESTOR hit-tests instead — the element is transparent to the pointer", () => {
    // `pointer-events: none` makes the hit-test fall through to the parent. That is not "reachable".
    const host = tree(`<div id="parent"><div id="target"></div></div>`);
    const el = host.querySelector("#target")!;
    const parent = host.querySelector("#parent")!;
    const info = describeElement(el, deps({ at: () => parent }));
    expect(info.topmost_at_centre).toBe(false);
    expect(info.covered_by).toBe("div#parent");
  });

  it("reports a ZERO-AREA rect as its own cause, not as an overlay", () => {
    // A collapsed element would hit-test to whatever is behind it, which reads as "covered" and sends
    // the reader hunting for a non-existent overlay. The rect IS the bug; say so.
    const host = tree(`<div id="target"></div>`);
    const el = host.querySelector("#target")!;
    const info = describeElement(el, deps({ rectOf: () => ({ x: 0, y: 0, width: 0, height: 0 }), at: () => el }));
    expect(info.topmost_at_centre).toBe(false);
    expect(info.covered_by).toBe("(zero-area rect)");
  });
});

describe("inspectDebug — hit", () => {
  it("walks the ancestor chain outward from the topmost element", async () => {
    const host = tree(`<div id="outer"><div id="mid"><div id="inner"></div></div></div>`);
    const inner = host.querySelector("#inner")!;
    const res = await inspectDebug({ op: "hit", x: 5, y: 5 }, deps({ at: () => inner }));
    expect("hit" in res).toBe(true);
    const labels = (res as { hit: { chain: { label: string }[] } }).hit.chain.map((e) => e.label);
    expect(labels[0]).toBe("div#inner");
    expect(labels.slice(1, 3)).toEqual(["div#mid", "div#outer"]);
    expect(labels[labels.length - 1]).toBe("html"); // walks all the way out
  });

  it("returns an EMPTY chain when nothing is at the point", async () => {
    const res = await inspectDebug({ op: "hit", x: -1, y: -1 }, deps({ at: () => null }));
    expect(res).toEqual({ hit: { chain: [] } });
  });
});

describe("inspectDebug — probe", () => {
  it("returns the first match by default and every match with --all", async () => {
    tree(`<p class="x">a</p><p class="x">b</p><p class="x">c</p>`);
    const one = await inspectDebug({ op: "probe", selector: "p.x" }, deps());
    expect((one as { probe: { matched: unknown[] } }).probe.matched).toHaveLength(1);
    const all = await inspectDebug({ op: "probe", selector: "p.x", all: true }, deps());
    expect((all as { probe: { matched: unknown[] } }).probe.matched).toHaveLength(3);
  });

  it("an empty match is an ANSWER, not an error", async () => {
    const res = await inspectDebug({ op: "probe", selector: ".nothing-matches-this" }, deps());
    expect(res).toEqual({ probe: { matched: [] } });
  });

  it("propagates an invalid selector so the caller is told, not timed out", async () => {
    const bad = deps({ query: () => { throw new Error("invalid selector: ((("); } });
    await expect(inspectDebug({ op: "probe", selector: "(((" }, bad)).rejects.toThrow("invalid selector");
  });
});

describe("inspectDebug — frames", () => {
  const frame = (over: Partial<PreviewFrameEntry> = {}): PreviewFrameEntry => ({
    component: "invoicespage",
    iframe: document.createElement("iframe"),
    engineRequested: true,
    engineInSrcdoc: true,
    ...over,
  });

  it("reports the host pair — requested vs actually in the srcdoc", async () => {
    // Their DISAGREEMENT is a builder bug and is invisible from the DOM, which is why both are carried.
    const res = await inspectDebug(
      { op: "frames" },
      deps({ frames: () => [frame({ engineRequested: true, engineInSrcdoc: false })] }),
    );
    const f = (res as { frames: { frames: { engine_requested: boolean; engine_in_srcdoc: boolean }[] } }).frames.frames[0];
    expect(f.engine_requested).toBe(true);
    expect(f.engine_in_srcdoc).toBe(false);
  });

  it("OMITS the engine when it never answers — silent is distinct from reporting failure", async () => {
    const res = await inspectDebug({ op: "frames" }, deps({ frames: () => [frame()], probeEngine: async () => null }));
    const f = (res as { frames: { frames: { engine?: unknown }[] } }).frames.frames[0];
    expect("engine" in f).toBe(false);
  });

  it("carries the engine's own report when it answers", async () => {
    const probe = { listening: true, transform: "matrix(1,0,0,1,-60,0)", scale: 1.15, pan: [-60, 0] as [number, number] };
    const res = await inspectDebug({ op: "frames" }, deps({ frames: () => [frame()], probeEngine: async () => probe }));
    const f = (res as { frames: { frames: { engine?: typeof probe }[] } }).frames.frames[0];
    expect(f.engine).toEqual(probe);
  });

  it("probes every mounted preview, not just the first", async () => {
    const probeEngine = vi.fn(async () => null);
    await inspectDebug(
      { op: "frames" },
      deps({ frames: () => [frame({ component: "a" }), frame({ component: "b" })], probeEngine }),
    );
    expect(probeEngine).toHaveBeenCalledTimes(2);
  });

  it("no mounted preview is an empty list, not an error", async () => {
    expect(await inspectDebug({ op: "frames" }, deps())).toEqual({ frames: { frames: [] } });
  });
});
