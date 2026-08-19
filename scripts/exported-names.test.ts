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

describe("exportedNames — comments inside an export block", () => {
  it("does not glue a comment onto the name that follows it", () => {
    // `shared/ui/kit/index.ts` was reported as DROPPING `setActiveKitThemes` because `[\s\S]*?` swallowed
    // the two comment lines sitting inside its `export { … }` block, so the name arrived as prose+name and
    // matched nothing on the record's side. A false "drops an export" argues for replacing a record that
    // was fine, which is the expensive direction to be wrong in.
    const src = [
      `export {`,
      `  themeById,`,
      `  // #2488: the designer-writable theme store's sync hooks — the components slice hydrate pushes`,
      `  // the store collection in.`,
      `  setActiveKitThemes,`,
      `} from "@/shared/ui/kit/theme";`,
    ].join("\n");
    const names = exportedNames(src);
    expect(names).not.toBeNull();
    expect([...names!].sort()).toEqual(["setActiveKitThemes", "themeById"]);
  });

  it("still returns null for `export * from`", () => {
    expect(exportedNames(`export * from "@/x";`)).toBeNull();
  });

  it("ignores an `export` written inside a comment", () => {
    expect([...exportedNames(`// export function ghost() {}\nexport const real = 1;`)!]).toEqual(["real"]);
  });
});
