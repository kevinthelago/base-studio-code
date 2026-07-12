import { describe, it, expect } from "vitest";
import { analyzeGraphHealth, nodeHealth } from "./graphHealth";
import type { ComponentRecord, Role } from "./model";

/** Minimal component fixture — only the fields the analyzer reads matter. Carries a real `source` so
 *  the no-implementation check (#2839) never fires on it and the topology tests stay about topology;
 *  the no-implementation-specific test overrides it with a deliberately source-less spec. */
function comp(name: string, role: Role, used: number, composes: string[] = [], extra: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: name, name, kitId: "k", role, version: "1", used, tags: [], variants: ["default"],
    composes, props: [], whenUse: [], whenNot: [], src: "", srcText: `src-${name}`,
    source: "export const C = () => null;", ...extra,
  };
}

describe("analyzeGraphHealth (#2680, mirrors bsc ui doctor)", () => {
  it("a clean graph has no findings", () => {
    const comps = [comp("Page", "page", 1, ["Card"]), comp("Card", "composite", 3, ["Button"]), comp("Button", "primitive", 9)];
    expect(analyzeGraphHealth(comps)).toEqual([]);
  });

  it("flags an isolated unused primitive as an orphan (and never a used one)", () => {
    const fs = analyzeGraphHealth([comp("Button", "primitive", 5), comp("Ghost", "primitive", 0)]);
    expect(fs.map((f) => f.category)).toEqual(["orphan"]);
    expect(fs[0].nodeNames).toEqual(["Ghost"]);
  });

  it("flags an unused root with deps as a dangling branch (root + reachable)", () => {
    const fs = analyzeGraphHealth([comp("DeadShell", "layout", 0, ["Widget"]), comp("Widget", "composite", 0)]);
    expect(fs.map((f) => f.category)).toEqual(["dangling-branch"]);
    expect(fs[0].nodeNames).toEqual(expect.arrayContaining(["DeadShell", "Widget"]));
  });

  it("flags two components wrapping the same intrinsic as duplicates", () => {
    const fs = analyzeGraphHealth([
      comp("Button", "primitive", 9, [], { wraps: "button" }),
      comp("Btn2", "primitive", 1, [], { wraps: "button" }),
    ]);
    expect(fs.map((f) => f.category)).toEqual(["duplicate"]);
  });

  it("flags a composes cycle at the top severity", () => {
    const fs = analyzeGraphHealth([comp("A", "composite", 1, ["B"]), comp("B", "composite", 1, ["A"])]);
    expect(fs[0].category).toBe("cycle");
    expect(fs[0].severity).toBe(4);
  });

  it("nodeHealth badges each node with its most-severe category", () => {
    const map = nodeHealth([comp("Ghost", "primitive", 0), comp("A", "composite", 1, ["B"]), comp("B", "composite", 1, ["A"])]);
    expect(map.get("Ghost")).toBe("orphan");
    expect(map.get("A")).toBe("cycle");
    expect(map.get("B")).toBe("cycle");
  });

  it("flags a slot-driven composite (composes + a ReactNode slot) as slot-shell, informationally (#2921)", () => {
    // A used page that composes children delivered via a `view` ReactNode slot → previews a demo
    // placeholder standalone. Used>0 so it isn't ALSO a dead-root dangling-branch — isolate slot-shell.
    const page = comp("GraphExplorerPage", "page", 2, ["ForceGraph", "TreeDiagram"], {
      props: [
        { name: "title", type: "string", req: false, desc: "" },
        { name: "view", type: "ReactNode", req: false, desc: "" },
        { name: "inspector", type: "ReactNode", req: false, desc: "" },
      ],
    });
    const fs = analyzeGraphHealth([page]);
    expect(fs.map((f) => f.category)).toEqual(["slot-shell"]);
    expect(fs[0].severity).toBe(1);
    expect(fs[0].why).toContain("ForceGraph, TreeDiagram"); // names the composed children
    expect(fs[0].why).toContain("view, inspector");         // names the slots
  });

  it("does NOT flag slot-shell without a node slot, or with only `children` (#2921)", () => {
    // composes children but no ReactNode content slot → renders its function standalone, not flagged.
    const internal = comp("Toolbar", "composite", 3, ["Button"], { props: [{ name: "label", type: "string", req: false, desc: "" }] });
    // a `children`-only prop is universal, never a slot-shell signal.
    const wrapper = comp("Card", "composite", 3, ["Icon"], { props: [{ name: "children", type: "ReactNode", req: false, desc: "" }] });
    const cats = analyzeGraphHealth([internal, wrapper, comp("Button", "primitive", 9), comp("Icon", "primitive", 9)])
      .map((f) => f.category);
    expect(cats).not.toContain("slot-shell");
  });

  it("flags a source-less user spec as no-implementation but never a built-in (#2839)", () => {
    // BUILT-IN: source-less in the store (its artifact `source` is stripped, #2794) but its `src` is a
    // real packaged react-ui component — buildable via the artifact roster, so NOT flagged.
    const builtin = comp("Card", "primitive", 2, [], {
      source: undefined, src: "shared/ui/data/Card.tsx",
      srcText: 'import { Card } from "@/shared/ui/data/Card";\n<Card />',
    });
    // USER SPEC: a `page` that's a design, not code — source-less, a usage-snippet srcText, and a `src`
    // NOT in the artifact. The preview can't build it (componentPreviewFiles → null) → flagged.
    const spec = comp("GraphExplorerPage", "page", 1, [], {
      source: undefined, src: "user/pages/GraphExplorerPage.tsx",
      srcText: 'import { GraphExplorerPage } from "@/x";\n<GraphExplorerPage nodes={…} />',
    });
    const flagged = analyzeGraphHealth([builtin, spec])
      .filter((f) => f.category === "no-implementation")
      .flatMap((f) => f.nodeNames);
    expect(flagged).toContain("GraphExplorerPage");
    expect(flagged).not.toContain("Card");
    // The badge map picks it up (its most-severe category).
    const map = nodeHealth([builtin, spec]);
    expect(map.get("GraphExplorerPage")).toBe("no-implementation");
    expect(map.get("Card")).toBeUndefined();
  });
});
