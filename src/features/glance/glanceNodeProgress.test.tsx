// The node's own completion fill (#4050 → #4118 → #4123).
//
// It was a 2px hairline, then a 5px track with `done/total` beside it. Both presented a COARSE number
// as a precise one: the refs are a planning artifact, "done" is whatever evidence was reachable, and a
// readout on every node competes with the health dot and activity word for the same glance. The node
// now fills, and the fill FADES — a soft edge reads as an estimate, a hard one reads as a measurement.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { GlanceNode, nodeProgressMask, NODE_DIM } from "@/features/glance/GlanceNode";
import type { GNode } from "@/features/glance/lib/glanceGraph";

const node = (over: Partial<GNode> = {}): GNode => ({
  id: "auth", slug: "auth", role: "service", health: "healthy", activity: "building",
  rollupHealth: "healthy", x: 0, y: 0, ...over,
} as GNode);

const props = (n: GNode) => ({
  n, border: "var(--border)", boxShadow: "none", healthColor: "green", healthPulse: false,
  inherited: false, roleColor: "blue", roleLabel: "build", bottomText: "building",
  bottomColor: "var(--fg-muted)", bottomPulse: false, isOff: false, degraded: false,
  ownDegraded: false, state: null as null,
});

afterEach(() => cleanup());

describe("nodeProgressMask — progress is OPACITY, not a colour", () => {
  it("says NOTHING for an unmeasured node — absent is not zero", () => {
    // The old code collapsed "no progress data" and "0% done" into one `0`, and got away with it only
    // because a 0 fill drew nothing. Under an opacity scheme they MUST diverge: dimming an uncounted
    // node reports "nothing here is finished" for "nobody has counted".
    expect(nodeProgressMask(null)).toBeUndefined();
    expect(nodeProgressMask(undefined)).toBeUndefined();
  });

  it("dims the WHOLE node at 0% — uniformly, with no bright region", () => {
    const m = nodeProgressMask(0)!;
    expect(m).toBeDefined();
    // Every stop that carries a fraction is at NODE_DIM, and the last one reaches the far edge.
    expect(m).toContain(`rgba(0,0,0,${NODE_DIM}) 100%`);
    expect(m).toMatch(/#000 0%, #000 0%/);   // the bright band has zero width
  });

  it("returns the node to FULL opacity when complete — no mask at all", () => {
    // A finished node is simply itself. Anything else would leave a permanent artefact on it.
    expect(nodeProgressMask(1)).toBeUndefined();
    expect(nodeProgressMask(2)).toBeUndefined();
  });

  it("runs full strength -> NODE_DIM left to right, and never past the edge", () => {
    const m = nodeProgressMask(0.25)!;
    expect(m.startsWith("linear-gradient(90deg")).toBe(true);
    expect(m).toContain("25%");
    expect(m).toContain(`rgba(0,0,0,${NODE_DIM}) 100%`);
  });

  it("KEEPS the fade band — a soft edge reads as an estimate, a hard one as a measurement", () => {
    const m = nodeProgressMask(0.6)!;
    expect(m).toMatch(/44%/);                 // 60 − FADE_PCT(16)
    expect(m).not.toMatch(/-\d/);            // and never runs negative for an early node
    expect(nodeProgressMask(0.05)!).not.toMatch(/-\d/);
  });

  it("carries NO completion colour — health is the only colour signal on a node", () => {
    // The whole point of the change: progress stopped being a blue wash.
    const m = nodeProgressMask(0.5)!;
    expect(m).not.toContain("--graph-health-complete");
    expect(m).not.toContain("color-mix");
  });
});

describe("GlanceNode progress (#4123)", () => {
  it("shows NO count on the node — the numbers live in the inspector", () => {
    render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    expect(screen.queryByText("3/7")).toBeNull();
  });

  it("MASKS the node rather than tinting it, and keeps the exact counts on hover", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    // The surface stays the plain panel — progress is opacity now, so nothing is painted onto it.
    expect(el.style.background).toBe("var(--bg-elev)");
    expect(el.style.maskImage || el.style.getPropertyValue("mask-image")).toContain("linear-gradient");
    expect(el.getAttribute("title")).toBe("3/7 issues complete");
  });

  it("sets the WEBKIT mask too — the app ships on WebKitGTK", () => {
    // Without the prefixed property every node renders at full opacity in the product while looking
    // perfect in Chromium: the feature would be invisible exactly where it ships.
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    const webkit = el.style.getPropertyValue("-webkit-mask-image") || (el.style as unknown as Record<string, string>).WebkitMaskImage;
    expect(webkit).toContain("linear-gradient");
  });

  it("leaves a node with no work visually untouched — NOT dimmed", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 0, total: 0 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.background).toBe("var(--bg-elev)");
    expect(el.style.maskImage || el.style.getPropertyValue("mask-image") || "").toBe("");
    expect(el.getAttribute("title")).toBeNull();
  });

  it("a node with work but NOTHING done is dimmed — that is the case 0-vs-absent had to separate", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 0, total: 7 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    // The CSSOM re-spaces colour functions, so compare with whitespace removed rather than pinning
    // the browser's formatting.
    const mask = (el.style.maskImage || el.style.getPropertyValue("mask-image")).replace(/\s+/g, "");
    expect(mask).toContain(`rgba(0,0,0,${NODE_DIM})0%`);   // dim from the very start — nothing is done
    expect(mask).toContain(`rgba(0,0,0,${NODE_DIM})100%`); // …all the way across
  });
});
