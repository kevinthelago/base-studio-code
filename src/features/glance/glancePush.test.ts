import { describe, it, expect } from "vitest";
import { pushAway, relaxAroundPanel } from "./lib/glancePush";
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

// The remaining overlap magnitude if a node's top-left were at (nx,ny) — 0 when it clears the panel.
const penetration = (nx: number, ny: number) => { const { dx, dy } = pushAway(nx, ny, RECT); return Math.hypot(dx, dy); };

describe("relaxAroundPanel (#2666 — d3-force: make room while keeping relative distances)", () => {
  it("shifts an overlapping node out, reducing its overlap", () => {
    const a = { id: "a", x: 250, y: 170 };
    const d = relaxAroundPanel([a], [], RECT).get("a");
    expect(d).toBeTruthy();
    expect(penetration(a.x + d!.dx, a.y + d!.dy)).toBeLessThan(penetration(a.x, a.y));
  });

  it("keeps a LINKED pair far closer to its home distance than pushing each node independently", () => {
    const a = { id: "a", x: 180, y: 160 }, b = { id: "b", x: 380, y: 160 };
    const homeD = Math.hypot((a.x + NW / 2) - (b.x + NW / 2), (a.y + NH / 2) - (b.y + NH / 2));

    // Independent per-node push (the old #2662 behaviour) splits the pair across the panel.
    const ia = pushAway(a.x, a.y, RECT), ib = pushAway(b.x, b.y, RECT);
    const indepD = Math.hypot((a.x + ia.dx) - (b.x + ib.dx), (a.y + ia.dy) - (b.y + ib.dy));

    // The force relaxation, with a spring between them, holds them together (flows around, not torn apart).
    const m = relaxAroundPanel([a, b], [{ source: "a", target: "b" }], RECT);
    const da = m.get("a") ?? { dx: 0, dy: 0 }, db = m.get("b") ?? { dx: 0, dy: 0 };
    const relaxD = Math.hypot((a.x + da.dx) - (b.x + db.dx), (a.y + da.dy) - (b.y + db.dy));

    expect(indepD).toBeGreaterThan(homeD * 2);            // independent push badly distorts the distance
    expect(relaxD).toBeLessThan(indepD);                  // the relaxation keeps them much closer
    expect(Math.abs(relaxD - homeD)).toBeLessThan(Math.abs(indepD - homeD));
  });

  it("leaves a node clear of the panel untouched", () => {
    expect(relaxAroundPanel([{ id: "far", x: 5000, y: 5000 }], [], RECT).has("far")).toBe(false);
  });

  it("excludes the grown node (it lives under the panel)", () => {
    const m = relaxAroundPanel([{ id: "a", x: 250, y: 170 }, { id: "g", x: 250, y: 170 }], [], RECT, "g");
    expect(m.has("g")).toBe(false);
  });

  it("is deterministic — the same rect yields the same shift (no jitter between frames)", () => {
    const nodes = [{ id: "a", x: 180, y: 160 }, { id: "b", x: 380, y: 160 }];
    const links = [{ source: "a", target: "b" }];
    expect(relaxAroundPanel(nodes, links, RECT)).toEqual(relaxAroundPanel(nodes, links, RECT));
  });
});
