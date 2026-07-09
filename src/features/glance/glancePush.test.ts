import { describe, it, expect } from "vitest";
import { pushAway } from "./lib/glancePush";
import { NW, NH } from "./lib/glanceGraph";

// The open terminal panel (#2662) pushes overlapping neighbour nodes out of the way. pushAway is the
// pure per-node displacement — the minimal shove out the nearest edge of the panel.
const RECT = { left: 0, top: 0, w: 600, h: 400 };

describe("pushAway (#2662 — make room for the open terminal panel)", () => {
  it("does not move a node clear of the panel", () => {
    expect(pushAway(5000, 5000, RECT)).toEqual({ dx: 0, dy: 0 });
  });

  it("shoves an overlapping node out the nearest edge (min-penetration axis)", () => {
    // A node near the panel's right edge → pushed further right (+x), not vertically.
    const p = pushAway(RECT.left + RECT.w - NW / 2, RECT.top + RECT.h / 2 - NH / 2, RECT);
    expect(p.dx).toBeGreaterThan(0);
    expect(p.dy).toBe(0);
  });

  it("pushes far enough to clear the panel + the margin", () => {
    const nx = RECT.left + RECT.w - NW / 2, ny = RECT.top + RECT.h / 2 - NH / 2;
    const p = pushAway(nx, ny, RECT);
    // After the push the node's centre clears the panel's right edge by at least the node half-width.
    const clearedCx = nx + NW / 2 + p.dx;
    expect(clearedCx).toBeGreaterThanOrEqual(RECT.left + RECT.w + NW / 2);
  });

  it("picks the vertical axis when the node overlaps more horizontally than vertically", () => {
    // Node centred on the panel horizontally, near the top edge → pushed up (−y), not sideways.
    const p = pushAway(RECT.left + RECT.w / 2 - NW / 2, RECT.top - NH / 2 + 4, RECT);
    expect(p.dy).toBeLessThan(0);
    expect(p.dx).toBe(0);
  });
});
