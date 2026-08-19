import { describe, expect, it } from "vitest";
import { exportedNames } from "./lib/recordSource.mjs";

// `exportedNames` decides what a refresh or a retirement would DROP, so a form it cannot see is an
// export the guards cannot protect. The re-export form was invisible: `export type { X } from "…"` puts
// the `type` keyword between `export` and the brace, which defeated the pattern — and that made the
// retirement guard refuse `treeexplorerpage` for "dropping" a `TreeNodeData` its file re-exports on the
// very next line. Over-refusal is the harmless direction; the same miss on a RECORD's side would mean an
// export it really has is not counted as lost.
const names = (src: string): string[] => [...(exportedNames(src) ?? [])];

describe("exportedNames sees every export form", () => {
  it("counts a plain re-export", () => {
    expect(names(`export { A } from "@/x";`)).toEqual(["A"]);
  });

  it("counts a TYPE re-export — the form that was missed", () => {
    expect(names(`export type { TreeNodeData } from "@/shared/ui/layouts/Tree";`)).toEqual(["TreeNodeData"]);
  });

  it("counts declarations and re-exports together, and unwraps `as`", () => {
    const src = [
      `export type { TreeNodeData } from "@/shared/ui/layouts/Tree";`,
      `export function TreeExplorerPage() { return null; }`,
      `export { inner as Outer } from "./x";`,
    ].join("\n");
    expect(names(src).sort()).toEqual(["Outer", "TreeExplorerPage", "TreeNodeData"]);
  });

  it("still gives up on `export *`, which it cannot resolve without following the module", () => {
    // `null` means "unknown", not "none" — callers treat it as "cannot prove nothing is lost".
    expect(exportedNames(`export * from "@/x";`)).toBeNull();
  });
});
