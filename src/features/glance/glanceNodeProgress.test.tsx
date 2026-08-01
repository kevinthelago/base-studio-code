// The node's own completion fill (#4050 → #4118 → #4123).
//
// It was a 2px hairline, then a 5px track with `done/total` beside it. Both presented a COARSE number
// as a precise one: the refs are a planning artifact, "done" is whatever evidence was reachable, and a
// readout on every node competes with the health dot and activity word for the same glance. The node
// now fills, and the fill FADES — a soft edge reads as an estimate, a hard one reads as a measurement.
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { GlanceNode, nodeFill } from "./GlanceNode";
import type { GNode } from "./lib/glanceGraph";

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

describe("nodeFill (#4123)", () => {
  it("is the bare panel colour at zero — an unmeasured node must look unmeasured", () => {
    // A visible 0% sliver would put a mark on every node in the graph and say nothing.
    expect(nodeFill(0)).toBe("var(--bg-elev)");
    expect(nodeFill(-1)).toBe("var(--bg-elev)");
  });

  it("layers the wash OVER the panel colour rather than replacing it", () => {
    // The node has to keep its surface, and its contrast with the canvas, at every fill level.
    expect(nodeFill(0.5)).toContain("var(--bg-elev)");
    expect(nodeFill(0.5).startsWith("linear-gradient(90deg")).toBe(true);
  });

  it("ends the wash at the fill edge, not past it", () => {
    expect(nodeFill(0.25)).toContain("transparent 25%");
    expect(nodeFill(1)).toContain("transparent 100%");
  });

  it("FADES instead of stopping — there is no boundary to misread", () => {
    // The soft stop sits a fade-band before the edge, and is weaker than the origin.
    const g = nodeFill(0.6);
    expect(g).toMatch(/44%/);            // 60 − 16
    const [origin, mid] = [...g.matchAll(/complete\) (\d+)%/g)].map((m) => Number(m[1]));
    expect(origin).toBeGreaterThan(mid); // thinning, not a flat block
  });

  it("never runs the fade below zero for an early node", () => {
    expect(nodeFill(0.05)).toContain("0%");
    expect(nodeFill(0.05)).not.toMatch(/-\d/);
  });
});

describe("GlanceNode progress (#4123)", () => {
  it("shows NO count on the node — the numbers live in the inspector", () => {
    render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    expect(screen.queryByText("3/7")).toBeNull();
  });

  it("fills the node itself, and keeps the exact counts on hover", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 3, total: 7 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.background).toContain("linear-gradient");
    expect(el.getAttribute("title")).toBe("3/7 issues complete");
  });

  it("leaves a node with no work visually untouched", () => {
    const { container } = render(<GlanceNode {...props(node({ progress: { done: 0, total: 0 } }))} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.background).toBe("var(--bg-elev)");
    expect(el.getAttribute("title")).toBeNull();
  });
});
