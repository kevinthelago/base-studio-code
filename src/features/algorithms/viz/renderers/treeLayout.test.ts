import { describe, it, expect } from "vitest";
import { treeLayout, TREE_VIEW } from "./treeLayout";

describe("treeLayout (#3270)", () => {
  it("returns an empty map for an empty tree", () => {
    expect(treeLayout([])).toEqual({});
  });

  it("centers a lone node in the viewBox", () => {
    const pos = treeLayout([{ id: "r" }]);
    expect(pos.r.x).toBe(TREE_VIEW / 2);
    expect(pos.r.y).toBeLessThan(TREE_VIEW / 2); // near the top (depth 0)
  });

  it("places deeper nodes lower and a parent centered over its children", () => {
    // r ─ a ─ (c, d)
    //   └ b
    const pos = treeLayout([
      { id: "r" },
      { id: "a", parent: "r" },
      { id: "b", parent: "r" },
      { id: "c", parent: "a" },
      { id: "d", parent: "a" },
    ]);
    // depth drives y: root highest, the deepest leaves lowest and level.
    expect(pos.r.y).toBeLessThan(pos.a.y);
    expect(pos.a.y).toBeLessThan(pos.c.y);
    expect(pos.c.y).toBe(pos.d.y); // c, d are the same depth
    // each parent sits centered over the horizontal span of its children.
    expect(pos.a.x).toBeCloseTo((pos.c.x + pos.d.x) / 2, 5);
    expect(pos.r.x).toBeCloseTo((pos.a.x + pos.b.x) / 2, 5);
    // leaves are laid out left→right in child order (c left of d).
    expect(pos.c.x).toBeLessThan(pos.d.x);
  });

  it("treats a node with a dangling parent as a root (never crashes)", () => {
    const pos = treeLayout([
      { id: "x", parent: "ghost" }, // parent not in the set
      { id: "y", parent: "x" },
    ]);
    expect(pos.x.y).toBeLessThan(pos.y.y); // x is a root, y hangs below it
  });
});
