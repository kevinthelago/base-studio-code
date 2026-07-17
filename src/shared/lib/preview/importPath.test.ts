import { describe, it, expect } from "vitest";
import { collapseSegments, resolveInternalBase } from "./importPath";

// The shared module-path resolver (#3246), extracted from the three former copies. resolveMemPath
// (componentBundle) delegates its collapse loop here; the two former `resolveInternalBase` copies in
// designs/ now import this one.

describe("importPath — collapseSegments", () => {
  it("drops empty and `.` segments, joining the rest with `/`", () => {
    expect(collapseSegments(["a", "", ".", "b"])).toBe("a/b");
    expect(collapseSegments([])).toBe("");
  });
  it("pops the parent on `..` (and a pop past the root is a no-op)", () => {
    expect(collapseSegments(["a", "b", "..", "c"])).toBe("a/c");
    expect(collapseSegments(["a", "..", "..", "b"])).toBe("b");
  });
});

describe("importPath — resolveInternalBase", () => {
  it("maps `@/x` to the src-relative base (importer ignored)", () => {
    expect(resolveInternalBase("@/shared/ui/Card", "features/x/y.tsx")).toBe("shared/ui/Card");
  });
  it("joins a relative import onto the importer's directory, collapsing `.`/`..`", () => {
    expect(resolveInternalBase("./chip", "shared/ui/data/Card.tsx")).toBe("shared/ui/data/chip");
    expect(resolveInternalBase("../feedback/Skeleton", "shared/ui/data/Card.tsx")).toBe("shared/ui/feedback/Skeleton");
    expect(resolveInternalBase("../../x", "a/b/c.tsx")).toBe("x");
  });
  it("resolves a relative import from a top-level (dir-less) importer", () => {
    expect(resolveInternalBase("./sibling", "root.tsx")).toBe("sibling");
  });
  it("returns null for a bare (non-internal) specifier", () => {
    expect(resolveInternalBase("react", "features/x/y.tsx")).toBeNull();
    expect(resolveInternalBase("d3-force", "a/b.tsx")).toBeNull();
  });
});
