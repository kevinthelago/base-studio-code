// Hierarchical kit navigation (#2487, policy fixed by #2506) — the pure grouping model: ALWAYS
// technology → style, the single-kit style merge (the style header IS the kit), first-appearance
// ordering ("other" last), and missing-field tolerance.
import { describe, it, expect } from "vitest";
import type { Kit, ComponentRecord } from "./model";
import { groupKits, groupComponentsByGroup, OTHER_BUCKET, UNGROUPED_LABEL, type KitGroup, type KitTreeNode } from "./kitGroups";
import { SEED_KITS } from "./seed";

const kit = (id: string, tech?: string, style?: string): Kit =>
  ({ id, name: id, tech, style, stack: "", dot: "var(--accent)" });

const comp = (id: string, group?: string): ComponentRecord =>
  ({ id, name: id, kitId: "k", role: "primitive", group, version: "1", used: 0, tags: [],
     variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "" });

/** The kit ids of a node list, descending groups depth-first (order-preserving). */
const flatIds = (nodes: KitTreeNode[]): string[] =>
  nodes.flatMap((n) => (n.kind === "kit" ? [n.kit.id] : [...(n.kit ? [n.kit.id] : []), ...flatIds(n.children)]));

const asGroup = (n: KitTreeNode): KitGroup => {
  expect(n.kind).toBe("group");
  return n as KitGroup;
};

describe("groupKits — always technology → style (#2506)", () => {
  it("a single-tech library still nests: tech group → one merged style header per kit", () => {
    const t = groupKits([kit("a", "react", "studio"), kit("b", "react", "demo")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react"]);
    const react = asGroup(t[0]);
    expect(react.level).toBe("tech");
    expect(react.key).toBe("tech:react");
    expect(react.count).toBe(2);
    const styles = react.children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual(["studio", "demo"]);
    expect(styles.map((s) => s.level)).toEqual(["style", "style"]);
    expect(styles[0].key).toBe("style:react/studio"); // stable, tech-scoped expand key
    // The normal case — one kit per (tech, style): the style header IS the kit, no kit rows nest.
    expect(styles.map((s) => s.kit?.id)).toEqual(["a", "b"]);
    expect(styles.every((s) => s.children.length === 0)).toBe(true);
  });

  it("the real packaged seed renders React → Studio → components (#2506 — no flatten)", () => {
    const t = groupKits(SEED_KITS);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react"]);
    const styles = asGroup(t[0]).children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual(["studio"]);
    expect(styles[0].kit?.id).toBe("react-ui"); // the style header IS the one packaged kit
    expect(flatIds(t)).toEqual(SEED_KITS.map((k) => k.id));
  });

  it("a multi-tech library nests one header per tech — even a one-kit tech", () => {
    const t = groupKits([kit("a", "react", "studio"), kit("b", "react", "demo"), kit("v", "vue", "material")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react", "vue"]);
    const [react, vue] = t.map(asGroup);
    expect(react.count).toBe(2);
    expect(flatIds(react.children)).toEqual(["a", "b"]);
    expect(vue.count).toBe(1);
    expect(flatIds(vue.children)).toEqual(["v"]);
  });

  it("SEVERAL kits under one (tech, style) still nest a kit level beneath the style group", () => {
    const t = groupKits([
      kit("a", "react", "studio"), kit("b", "react", "studio"), kit("c", "react", "demo"),
    ]);
    const styles = asGroup(t[0]).children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual(["studio", "demo"]);
    // studio holds two kits → real kit rows, no header merge.
    expect(styles[0].kit).toBeUndefined();
    expect(styles[0].count).toBe(2);
    expect(styles[0].children.map((n) => n.kind)).toEqual(["kit", "kit"]);
    expect(flatIds(styles[0].children)).toEqual(["a", "b"]);
    // demo holds one → merged.
    expect(styles[1].kit?.id).toBe("c");
  });

  it("tech normalization: case/whitespace-insensitive bucketing", () => {
    const t = groupKits([kit("a", "React", "x"), kit("b", " react ", "x"), kit("v", "vue", "y")]);
    expect(asGroup(t[0]).label).toBe("react");
    expect(asGroup(t[0]).count).toBe(2);
  });

  it("kits without tech group into the trailing OTHER tech bucket — never a crash", () => {
    // "u" appears FIRST but its bucket still orders last.
    const t = groupKits([kit("u"), kit("a", "react", "studio"), kit("b", "react", "demo")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react", OTHER_BUCKET]);
    expect(flatIds(asGroup(t[1]).children)).toEqual(["u"]);
  });

  it("a kit without style groups into the trailing OTHER style bucket within its tech", () => {
    const t = groupKits([kit("bare", "react"), kit("a", "react", "studio")]);
    const styles = asGroup(t[0]).children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual(["studio", OTHER_BUCKET]);
    expect(styles[1].kit?.id).toBe("bare");
  });

  it("ALL kits missing tech/style → other → other, kits nested beneath (still grouped)", () => {
    const t = groupKits([kit("a"), kit("b"), kit("c")]);
    expect(t.map((n) => asGroup(n).label)).toEqual([OTHER_BUCKET]);
    const styles = asGroup(t[0]).children.map(asGroup);
    expect(styles.map((s) => s.label)).toEqual([OTHER_BUCKET]);
    expect(flatIds(styles[0].children)).toEqual(["a", "b", "c"]);
  });

  it("one kit per tech keeps one header per tech (#2487's all-singleton flatten is gone)", () => {
    const t = groupKits([kit("r", "react", "a"), kit("v", "vue", "b"), kit("k", "kotlin", "c")]);
    expect(t.map((n) => asGroup(n).label)).toEqual(["react", "vue", "kotlin"]);
    expect(t.every((n) => n.kind === "group")).toBe(true);
  });

  it("empty library → empty tree", () => {
    expect(groupKits([])).toEqual([]);
  });
});

describe("groupComponentsByGroup — the orthogonal `group` axis under a kit (#3048)", () => {
  it("partitions by `group` in first-appearance order, the ungrouped bucket forced LAST", () => {
    // "b" (no group) appears 2nd but its ungrouped bucket still orders last.
    const g = groupComponentsByGroup([comp("a", "data-viz"), comp("b"), comp("c", "forms"), comp("d", "data-viz")]);
    expect(g).not.toBeNull();
    expect(g!.map((x) => x.label)).toEqual(["data-viz", "forms", UNGROUPED_LABEL]);
    expect(g!.map((x) => x.key)).toEqual(["data-viz", "forms", OTHER_BUCKET]);
    expect(g!.map((x) => x.ungrouped)).toEqual([false, false, true]);
    // input order preserved within a bucket.
    expect(g!.find((x) => x.key === "data-viz")!.components.map((c) => c.id)).toEqual(["a", "d"]);
    expect(g!.find((x) => x.ungrouped)!.components.map((c) => c.id)).toEqual(["b"]);
  });

  it("returns null when NO component carries a group — the rail renders flat (zero regression)", () => {
    expect(groupComponentsByGroup([comp("a"), comp("b")])).toBeNull();
    // blank/whitespace-only group counts as absent — still flat.
    expect(groupComponentsByGroup([comp("a", "  "), comp("b", "")])).toBeNull();
    expect(groupComponentsByGroup([])).toBeNull();
  });

  it("any component with a group triggers nesting — even a single group, or a partial-group kit", () => {
    // A single group nests under one header.
    const one = groupComponentsByGroup([comp("a", "forms"), comp("b", "forms")]);
    expect(one!.map((x) => x.label)).toEqual(["forms"]);
    expect(one![0].components.map((c) => c.id)).toEqual(["a", "b"]);
    // A partial-group kit: grouped components + an ungrouped-last bucket.
    const partial = groupComponentsByGroup([comp("a", "data-viz"), comp("b")]);
    expect(partial!.map((x) => x.label)).toEqual(["data-viz", UNGROUPED_LABEL]);
    expect(partial![1].ungrouped).toBe(true);
  });
});
