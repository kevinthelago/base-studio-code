// Hierarchical kit navigation (#2487) — the pure grouping model: tech → style → kit with the
// trivial-level auto-flatten, first-appearance ordering ("other" last), and missing-field tolerance.
import { describe, it, expect } from "vitest";
import type { Kit } from "./model";
import { groupKits, OTHER_BUCKET, type KitGroup, type KitTreeNode } from "./kitGroups";
import { SEED_KITS } from "./seed";

const kit = (id: string, tech?: string, style?: string): Kit =>
  ({ id, name: id, tech, style, stack: "", dot: "var(--accent)" });

/** The kit ids of a node list, descending groups depth-first (order-preserving). */
const flatIds = (nodes: KitTreeNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "kit" ? [n.kit.id] : flatIds(n.children)));

const asGroup = (n: KitTreeNode): KitGroup => {
  expect(n.kind).toBe("group");
  return n as KitGroup;
};

describe("groupKits auto-flatten (#2487)", () => {
  it("single tech + one kit per style → EXACTLY flat (no group nodes, order preserved)", () => {
    const t = groupKits([kit("a", "react", "studio"), kit("b", "react", "demo")]);
    expect(t.every((n) => n.kind === "kit")).toBe(true);
    expect(flatIds(t)).toEqual(["a", "b"]);
  });

  it("the real packaged seed renders flat — no extra depth over the pre-#2487 rail", () => {
    const t = groupKits(SEED_KITS);
    expect(t.every((n) => n.kind === "kit")).toBe(true);
    expect(flatIds(t)).toEqual(SEED_KITS.map((k) => k.id));
  });

  it("a genuinely multi-tech library nests under tech headers — uniformly, even a one-kit tech", () => {
    const t = groupKits([kit("a", "react", "studio"), kit("b", "react", "demo"), kit("v", "vue", "material")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react", "vue"]);
    const [react, vue] = t.map(asGroup);
    expect(react.level).toBe("tech");
    expect(react.key).toBe("tech:react");
    expect(react.count).toBe(2);
    // react's style level is trivial (one kit per style) → kits sit directly under the tech group.
    expect(react.children.every((n) => n.kind === "kit")).toBe(true);
    expect(flatIds(react.children)).toEqual(["a", "b"]);
    expect(flatIds(vue.children)).toEqual(["v"]);
  });

  it("a genuinely multi-style tech nests style subgroups under its tech header", () => {
    const t = groupKits([
      kit("a", "react", "studio"), kit("b", "react", "studio"), kit("c", "react", "demo"),
      kit("v", "vue", "material"),
    ]);
    const react = asGroup(t[0]);
    const styles = react.children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual(["studio", "demo"]);
    expect(styles.map((s) => s.level)).toEqual(["style", "style"]);
    expect(styles[0].key).toBe("style:react/studio"); // stable, tech-scoped expand key
    expect(flatIds(styles[0].children)).toEqual(["a", "b"]);
    expect(flatIds(styles[1].children)).toEqual(["c"]);
  });

  it("tech normalization: case/whitespace-insensitive bucketing", () => {
    const t = groupKits([kit("a", "React", "x"), kit("b", " react ", "x"), kit("v", "vue", "y")]);
    expect(asGroup(t[0]).label).toBe("react");
    expect(asGroup(t[0]).count).toBe(2);
  });

  it("kits without tech group into the trailing OTHER bucket — never a crash", () => {
    // "u" appears FIRST but its bucket still orders last.
    const t = groupKits([kit("u"), kit("a", "react", "studio"), kit("b", "react", "demo")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react", OTHER_BUCKET]);
    expect(flatIds(asGroup(t[1]).children)).toEqual(["u"]);
  });

  it("ALL kits missing tech/style → the single bucket is trivial → flat", () => {
    const t = groupKits([kit("a"), kit("b"), kit("c")]);
    expect(t.every((n) => n.kind === "kit")).toBe(true);
    expect(flatIds(t)).toEqual(["a", "b", "c"]);
  });

  it("one kit per tech (all-singleton partition) → headers would restate the kits → flat", () => {
    const t = groupKits([kit("r", "react", "a"), kit("v", "vue", "b"), kit("k", "kotlin", "c")]);
    expect(t.every((n) => n.kind === "kit")).toBe(true);
  });

  it("empty library → empty tree", () => {
    expect(groupKits([])).toEqual([]);
  });
});
