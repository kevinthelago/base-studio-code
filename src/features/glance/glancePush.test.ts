import { describe, it, expect } from "vitest";
import { partAroundPanel, PUSH_MARGIN, type MorphRect } from "./lib/glancePush";
import { NW, NH } from "./lib/glanceGraph";

// The open terminal panel (#2534/#2662) makes room by PARTING the graph into four rigid curtains (#2671,
// replacing the soft d3-force relaxation). The two properties that matter — and that the old soft force
// could NOT guarantee — are: (1) every neighbour clears the panel (no clipping), and (2) nodes keep their
// spacing (no node-into-node clipping). These are the regression tests for exactly those.
const RECT: MorphRect = { left: 500, top: 400, w: 760, h: 520 };

/** Does a node whose top-left is (x,y) still intersect the panel box? (true = clipping) */
const intersectsPanel = (x: number, y: number, r: MorphRect) =>
  !(x + NW <= r.left || x >= r.left + r.w || y + NH <= r.top || y >= r.top + r.h);

/** Apply a computed shift to a node's top-left. */
const shifted = (n: { id: string; x: number; y: number }, m: Map<string, { dx: number; dy: number }>) => {
  const d = m.get(n.id) ?? { dx: 0, dy: 0 };
  return { x: n.x + d.dx, y: n.y + d.dy };
};

describe("partAroundPanel (#2671 — rigid curtains make room for the open panel)", () => {
  it("leaves a node clear of the panel untouched", () => {
    expect(partAroundPanel([{ id: "far", x: 5000, y: 5000 }], RECT).has("far")).toBe(false);
  });

  it("excludes the grown node (it lives under the panel)", () => {
    const cx = RECT.left + RECT.w / 2 - NW / 2, cy = RECT.top + RECT.h / 2 - NH / 2;
    const m = partAroundPanel([{ id: "g", x: cx, y: cy }, { id: "a", x: cx - 120, y: cy }], RECT, "g");
    expect(m.has("g")).toBe(false);
  });

  it("pushes a node above the panel straight UP, not sideways", () => {
    // Centred horizontally, just above the top edge → the up curtain (vertical, dy<0, dx=0).
    const n = { id: "n", x: RECT.left + RECT.w / 2 - NW / 2, y: RECT.top - NH / 2 };
    const d = partAroundPanel([n], RECT).get("n")!;
    expect(d.dy).toBeLessThan(0);
    expect(d.dx).toBe(0);
  });

  it("pushes a node beside the panel straight OUT, not vertically", () => {
    // Centred vertically, near the right edge → the right curtain (horizontal, dx>0, dy=0).
    const n = { id: "n", x: RECT.left + RECT.w - NW / 2, y: RECT.top + RECT.h / 2 - NH / 2 };
    const d = partAroundPanel([n], RECT).get("n")!;
    expect(d.dx).toBeGreaterThan(0);
    expect(d.dy).toBe(0);
  });

  it("GUARANTEE: every overlapping node in a dense ring around the panel fully clears it (no clipping)", () => {
    // A grid of nodes blanketing the panel and its surroundings — the exact scenario that used to leave
    // residual overlap with the soft force.
    const nodes: { id: string; x: number; y: number }[] = [];
    for (let gx = -1; gx <= 9; gx++)
      for (let gy = -1; gy <= 7; gy++)
        nodes.push({ id: `${gx},${gy}`, x: RECT.left - 200 + gx * 150, y: RECT.top - 200 + gy * 130 });
    // Exclude whatever node sits nearest the panel centre (the grown one).
    const cx0 = RECT.left + RECT.w / 2, cy0 = RECT.top + RECT.h / 2;
    let ex = nodes[0].id, best = Infinity;
    for (const n of nodes) { const d = Math.hypot(n.x + NW / 2 - cx0, n.y + NH / 2 - cy0); if (d < best) { best = d; ex = n.id; } }

    const m = partAroundPanel(nodes, RECT, ex);
    for (const n of nodes) {
      if (n.id === ex) continue;
      const s = shifted(n, m);
      expect(intersectsPanel(s.x, s.y, RECT)).toBe(false); // fully cleared — the hard guarantee
    }
  });

  it("keeps a curtain RIGID: members keep their exact spacing (no node-into-node clipping)", () => {
    // Two nodes stacked directly above the panel — both land in the up curtain and MUST move together, or
    // the lower one would ram the upper one. A rigid block preserves their gap exactly.
    const cx = RECT.left + RECT.w / 2 - NW / 2;
    const lower = { id: "lower", x: cx, y: RECT.top - NH - 10 };       // overlaps → drives the shift
    const upper = { id: "upper", x: cx, y: lower.y - (NH + 40) };      // clear, but must ride along
    const m = partAroundPanel([lower, upper], RECT);
    const dLo = m.get("lower")!, dUp = m.get("upper")!;
    expect(dLo).toEqual(dUp);                                          // identical shift → rigid
    // Spacing before === spacing after.
    const gapBefore = lower.y - upper.y;
    const gapAfter = (lower.y + dLo.dy) - (upper.y + dUp.dy);
    expect(gapAfter).toBeCloseTo(gapBefore, 6);
    // And the overlapping member actually cleared.
    expect(intersectsPanel(lower.x + dLo.dx, lower.y + dLo.dy, RECT)).toBe(false);
  });

  it("clears the panel by at least the margin", () => {
    const n = { id: "n", x: RECT.left + RECT.w - NW / 2, y: RECT.top + RECT.h / 2 - NH / 2 };
    const d = partAroundPanel([n], RECT).get("n")!;
    const clearedLeftEdge = n.x + d.dx;                                // the node's new left edge
    expect(clearedLeftEdge).toBeGreaterThanOrEqual(RECT.left + RECT.w + PUSH_MARGIN - 1e-6);
  });

  it("is deterministic — the same rect yields the same shift (no jitter between frames)", () => {
    const nodes = [{ id: "a", x: 480, y: 420 }, { id: "b", x: 900, y: 660 }, { id: "c", x: 1300, y: 500 }];
    expect(partAroundPanel(nodes, RECT)).toEqual(partAroundPanel(nodes, RECT));
  });
});
