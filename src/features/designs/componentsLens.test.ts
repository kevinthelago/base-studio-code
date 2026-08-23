// THE TECHNOLOGY TAB IS A LENS, NOT A PARTITION (`the-tab-is-a-lens-not-a-partition`) — the Components
// half of the guard, mirroring `features/algorithms/algorithmsLens.test.ts`.
//
// The claim a tab bar must never make is that technologies cannot cooperate. They can, and the model
// already says so: `@bsc/algorithms/fibonacci` is kit-less, so a React component resolves a TypeScript
// implementation across both pillar and technology (epic #3114, whose purpose was ending that siloing).
// Technology here is a CURATION scope — `studioScopeDirective` splits the designer per technology,
// governing who may WRITE a kit's components — and nothing more.
//
// What that obliges: scoping the rail to one technology must not make any kit, component or
// `composes` edge unreachable. That holds structurally rather than by luck, because a component's
// `composes` graph never leaves its kit and a kit belongs to exactly one technology — but "it holds
// today" is what a guard is for.
import { describe, it, expect } from "vitest";
import { groupKits, OTHER_BUCKET, type KitGroup, type KitTreeNode } from "@/features/designs/lib/kitGroups";
import type { Kit } from "@/features/designs/lib/model";

const kit = (id: string, tech?: string, style?: string): Kit =>
  ({ id, name: id, stack: "?", dot: "var(--accent)", ...(tech ? { tech } : {}), ...(style ? { style } : {}) }) as Kit;

/** Every kit id reachable by walking one technology group's subtree — what its tab can show. */
const kitsUnder = (node: KitTreeNode): string[] => {
  if (node.kind === "kit") return [node.kit.id];
  const own = node.kit ? [node.kit.id] : [];
  return [...own, ...node.children.flatMap(kitsUnder)];
};

const techGroups = (kits: Kit[]): KitGroup[] =>
  groupKits(kits).filter((n): n is KitGroup => n.kind === "group");

describe("the technology tab is a lens over the component library", () => {
  it("every kit is reachable from exactly one technology tab", () => {
    // Total and unambiguous. A kit under no tab is invisible in the UI; a kit under two is two copies
    // of one record, and edits to it would depend on which tab you happened to be on.
    const kits = [
      kit("studio", "react", "studio"),
      kit("fleet", "react", "studio"),
      kit("viz", "react", "data-viz"),
      kit("mobile", "react-native", "mobile"),
      kit("bare"), // no tech at all
    ];
    const seen = new Map<string, number>();
    for (const g of techGroups(kits)) {
      for (const id of g.children.flatMap(kitsUnder)) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    expect([...seen.keys()].sort()).toEqual(["bare", "fleet", "mobile", "studio", "viz"]);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("a kit with no technology still gets a tab rather than disappearing", () => {
    // The `other` bucket was a trailing rail GROUP; as a tab it must still exist, or an imported or
    // hand-authored kit that never set `tech` becomes unreachable — silently, since nothing errors.
    const groups = techGroups([kit("studio", "react", "studio"), kit("bare")]);
    const other = groups.find((g) => g.key === `tech:${OTHER_BUCKET}`);
    expect(other, "a kit with no `tech` must still have a tab").toBeTruthy();
    expect(other!.children.flatMap(kitsUnder)).toEqual(["bare"]);
    // …and it sorts LAST, so the real technologies lead.
    expect(groups[groups.length - 1].key).toBe(`tech:${OTHER_BUCKET}`);
  });

  it("scoping to one technology never splits a kit across tabs", () => {
    // The edge case that would sever something real: a kit's components compose only within that kit,
    // so a kit landing whole on one tab is what makes "no edge is lost" structural here rather than
    // coincidental. Two technologies sharing a STYLE name must not merge into one group.
    const groups = techGroups([kit("a", "react", "studio"), kit("b", "react-native", "studio")]);
    expect(groups.map((g) => g.key)).toEqual(["tech:react", "tech:react-native"]);
    expect(groups[0].children.flatMap(kitsUnder)).toEqual(["a"]);
    expect(groups[1].children.flatMap(kitsUnder)).toEqual(["b"]);
  });
});
