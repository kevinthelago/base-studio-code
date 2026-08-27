// The graph canvas may not run a NON-COMPOSITABLE animation, and this is a memory guard rather than a
// style rule.
//
// WHAT HAPPENED. A cycle edge carried `animation: glance-dashmove .75s linear infinite`, animating
// `stroke-dashoffset`. That property cannot be composited, so every frame WebKit had to REPAINT the
// layer holding it — and that layer is the whole SVG world, `worldW × worldH`, because the canvas
// renders the graph under one `translate(...) scale(...)` transform. One animated edge therefore cost a
// full-graph rasterisation 60 times a second, into graphics buffers no JS garbage collector can touch.
//
// MEASURED on the studio-code drill, same page and same fleet in every arm:
//
//     animations on                 +726 MB/min
//     both animations off            -20 MB/min   (466s)
//     only the EDGE animation off    +40 MB/min   (226s, inside a 152 MB oscillation band)
//
// WebKit killed its own web process at ~16 GB, which blanked the window with nothing in our log —
// `Unable to shrink memory footprint of process (16744 MB) below the kill thresold (16384 MB). Killed`.
//
// WHY A TEST AND NOT JUST A DELETION. Nothing else can see this. It is invisible to tsc, lint and every
// other test; it produces no error, no warning and no failing assertion; the app just dies half an hour
// later. The only signal is a process that grows, which nothing in CI watches. So the rule has to be
// written down where a future edit trips over it.
//
// The COMPOSITABLE properties are fine and deliberately still allowed — `glance-softpulse` animates
// `opacity` on an 8px dot and measured clean in the bisect above. This guard is about the ones that
// force a repaint.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/** The canvas as it SHIPS — the record, not a file: the module was retired, so the packaged record is
 *  what actually mounts and is therefore the only copy worth asserting against. */
const CANVAS: string = JSON.parse(
  readFileSync("src-tauri/data/components/app/features/glance/glance-canvas-module.json", "utf8"),
).srcText;

const CSS = readFileSync("src/features/glance/glance.css", "utf8");

/** Properties whose animation forces a REPAINT of the containing layer. Animating any of these on the
 *  world layer costs a full-graph rasterisation per frame. `transform` and `opacity` are absent on
 *  purpose — those the compositor can animate without repainting, which is why the health pulse stays. */
const REPAINT_PROPS = [
  "stroke-dashoffset", "stroke-dasharray", "stroke-width",
  "d", "cx", "cy", "r", "x1", "y1", "x2", "y2",
  "width", "height", "top", "left", "margin", "padding",
];

describe("the graph canvas animates nothing that forces a repaint (#the-webview-leaks…)", () => {
  it("declares no keyframes that animate a repaint-forcing property", () => {
    // Parse each @keyframes block and look at what it ACTUALLY animates, rather than banning a name —
    // a rename would slip straight past a name check, and the name is not what costs anything.
    //
    // Brace-MATCHED rather than regexed to the next `\n}`: these keyframes are written on ONE line, so a
    // lazy `[\s\S]*?\n}` runs straight past the block and swallows unrelated rules further down the
    // file. The first version of this test did exactly that and reported `glance-softpulse` animating
    // `stroke-dasharray`, which it does not — a false positive that would have "proved" the innocent
    // animation guilty.
    for (const m of CSS.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
      const name = m[1];
      let depth = 0, i = m.index! + m[0].length - 1, end = -1;
      for (; i < CSS.length; i++) {
        if (CSS[i] === "{") depth++;
        else if (CSS[i] === "}" && --depth === 0) { end = i; break; }
      }
      expect(end, `@keyframes ${name} has unbalanced braces`).toBeGreaterThan(-1);
      const body = CSS.slice(m.index! + m[0].length, end);
      for (const prop of REPAINT_PROPS) {
        expect(
          new RegExp(`(^|[;{\\s])${prop}\\s*:`).test(body),
          `@keyframes ${name} animates \`${prop}\`, which cannot be composited — on the world layer that ` +
            `is a full-graph repaint every frame. See this file's header for the measurements.`,
        ).toBe(false);
      }
    }
  });

  it("the canvas applies no infinite animation to an EDGE path", () => {
    // The specific regression: an edge spans the graph, so its repaint invalidates essentially the whole
    // world. `glance-dashmove` was applied inline on the `e.isCycle` branch.
    expect(CANVAS).not.toContain("glance-dashmove");
  });

  it("still marks a cycle edge WITHOUT motion, so the fix cost no information", () => {
    // The animation was emphasis on top of four static signals, which is what made removing it safe.
    // If these ever go, a cycle becomes invisible and someone will reach for the animation again.
    expect(CANVAS).toContain("var(--graph-health-error)");        // its own colour
    expect(CANVAS).toMatch(/e\.isCycle \? 2\.3/);                  // thicker than its neighbours
    expect(CANVAS).toMatch(/e\.isCycle \? "7 6"/);                // its own dash pattern
  });

  it("KEEPS the compositable pulse — the guard is about repaints, not about motion", () => {
    // `opacity` on a small dot measured clean. Banning animation outright would be the wrong lesson and
    // would strip a signal that costs nothing.
    expect(CSS).toContain("@keyframes glance-softpulse");
    expect(CANVAS).toContain("glance-softpulse");
  });
});
