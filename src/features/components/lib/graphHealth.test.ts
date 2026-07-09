import { describe, it, expect } from "vitest";
import { analyzeGraphHealth, nodeHealth } from "./graphHealth";
import type { ComponentRecord, Role } from "./model";

/** Minimal component fixture — only the fields the analyzer reads matter. */
function comp(name: string, role: Role, used: number, composes: string[] = [], extra: Partial<ComponentRecord> = {}): ComponentRecord {
  return {
    id: name, name, kitId: "k", role, version: "1", used, tags: [], variants: ["default"],
    composes, props: [], whenUse: [], whenNot: [], src: "", srcText: `src-${name}`, ...extra,
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
});
