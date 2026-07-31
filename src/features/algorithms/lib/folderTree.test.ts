// The algorithms folder tree (#4107) — 1:1 with the source layout, exactly like the components kit.
import { describe, it, expect } from "vitest";
import { folderTree, type AlgoImpl } from "./knowledge";

const im = (id: string, folder?: string, role: "primitive" | "algorithm" = "algorithm"): AlgoImpl =>
  ({ id, name: id.replace(/\..*$/, ""), tech: "rust", role, composes: [], folder }) as AlgoImpl;

describe("folderTree", () => {
  it("nests folders the way the source tree nests", () => {
    // The real shape a repo-root harvest produces (measured: 1982 candidates across 62 folders).
    const { roots } = folderTree([
      im("job.rs", "src-tauri/src/console/pty"),
      im("mod.rs", "src-tauri/src/console"),
      im("perf.rs", "src-tauri/src/observability"),
    ]);
    expect(roots.map((r) => r.name)).toEqual(["src-tauri"]);
    const srcTauri = roots[0];
    expect(srcTauri.children.map((c) => c.name)).toEqual(["src"]);
    const src = srcTauri.children[0];
    expect(src.children.map((c) => c.name)).toEqual(["console", "observability"]);
    const console_ = src.children[0];
    expect(console_.impls.map((i) => i.id)).toEqual(["mod.rs"]);
    expect(console_.children[0].path).toBe("src-tauri/src/console/pty");
    expect(console_.children[0].impls.map((i) => i.id)).toEqual(["job.rs"]);
  });

  it("keeps a pre-#4107 library rendering exactly as it did", () => {
    // Every impl in the live store is unfoldered (73 of 73, none carrying `src`). Those must come back
    // as a flat list, NOT collapsed under one blank folder — the change is additive.
    const { roots, unfoldered } = folderTree([im("merge.rs"), im("bfs.rs")]);
    expect(roots).toEqual([]);
    expect(unfoldered.map((i) => i.id)).toEqual(["merge.rs", "bfs.rs"]);
  });

  it("treats a blank folder as unfoldered rather than a `\"\"` node", () => {
    const { roots, unfoldered } = folderTree([im("a.rs", "   ")]);
    expect(roots).toEqual([]);
    expect(unfoldered.map((i) => i.id)).toEqual(["a.rs"]);
  });

  it("orders folders alphabetically and primitives before algorithms", () => {
    // The rail's existing convention — primitives first — must survive the move into the tree.
    const { roots } = folderTree([
      im("zeta.rs", "core", "algorithm"),
      im("alpha.rs", "core", "algorithm"),
      im("rust.vec", "core", "primitive"),
      im("b.rs", "bar"),
    ]);
    expect(roots.map((r) => r.name)).toEqual(["bar", "core"]);
    expect(roots[1].impls.map((i) => i.id)).toEqual(["rust.vec", "alpha.rs", "zeta.rs"]);
  });

  it("places two impls sharing a folder side by side", () => {
    const { roots } = folderTree([im("a.rs", "crates/x/src"), im("b.rs", "crates/x/src")]);
    const leaf = roots[0].children[0].children[0];
    expect(leaf.path).toBe("crates/x/src");
    expect(leaf.impls).toHaveLength(2);
  });
});
