// The algorithms folder tree (#4107, reshaped by #4128) — the SAME nested model the components kit
// renders, down to the trailing "ungrouped" bucket and the caller-preserved ordering.
import { describe, it, expect } from "vitest";
import { UNGROUPED_KEY, UNGROUPED_LABEL } from "@/shared/lib/core/folderTree";
import { folderTree, folderImplCount, type AlgoImpl } from "./knowledge";

const im = (id: string, folder?: string, role: "primitive" | "algorithm" = "algorithm"): AlgoImpl =>
  ({ id, name: id.replace(/\..*$/, ""), tech: "rust", role, composes: [], folder }) as AlgoImpl;

describe("folderTree", () => {
  it("nests folders the way the source tree nests", () => {
    // The real shape a repo-root harvest produces (measured: 1982 candidates across 62 folders).
    const t = folderTree([
      im("job.rs", "src-tauri/src/console/pty"),
      im("mod.rs", "src-tauri/src/console"),
      im("perf.rs", "src-tauri/src/observability"),
    ])!;
    expect(t.map((r) => r.label)).toEqual(["src-tauri"]);
    const src = t[0].folders[0];
    expect(src.label).toBe("src");
    expect(src.folders.map((c) => c.label)).toEqual(["console", "observability"]);
    const console_ = src.folders[0];
    expect(console_.items.map((i) => i.id)).toEqual(["mod.rs"]);
    expect(console_.folders[0].key).toBe("src-tauri/src/console/pty");
    expect(console_.folders[0].items.map((i) => i.id)).toEqual(["job.rs"]);
  });

  it("buckets unfoldered impls LAST instead of spilling them flat (#4128 — the components rule)", () => {
    // Before #4128 these came back in a separate `unfoldered` array the rail rendered beside the tree;
    // the components rail has always bucketed them, so a partially-foldered library now reads the same
    // in both. The seeded classics carry no `src`, so this is the COMMON case here, not an edge one.
    const t = folderTree([im("merge.rs"), im("bfs.rs"), im("job.rs", "src-tauri/src/console/pty")])!;
    expect(t.map((f) => f.label)).toEqual(["src-tauri", UNGROUPED_LABEL]);
    const bucket = t[t.length - 1];
    expect(bucket.ungrouped).toBe(true);
    expect(bucket.key).toBe(UNGROUPED_KEY);
    expect(bucket.items.map((i) => i.id)).toEqual(["merge.rs", "bfs.rs"]);
  });

  it("returns null when NOTHING carries a folder — the rail renders its flat list unchanged", () => {
    // Every impl in the live store was unfoldered before #4119; those must come back as a flat list,
    // NOT collapsed under one blank folder. The change stays additive.
    expect(folderTree([im("merge.rs"), im("bfs.rs")])).toBeNull();
    expect(folderTree([])).toBeNull();
  });

  it("treats a blank folder as unfoldered rather than a `\"\"` node", () => {
    expect(folderTree([im("a.rs", "   ")])).toBeNull();
    const t = folderTree([im("a.rs", "   "), im("b.rs", "core")])!;
    expect(t.map((f) => f.label)).toEqual(["core", UNGROUPED_LABEL]);
    expect(t[1].items.map((i) => i.id)).toEqual(["a.rs"]);
  });

  it("preserves the CALLER's order — primitives before algorithms survives into every folder", () => {
    // `groupImplsByLanguage` sorts primitives first; the tree must not re-sort that away (the pre-#4128
    // algorithms builder sorted folders alphabetically and impls by role+name itself, which silently
    // overrode whatever order the rail had chosen).
    const t = folderTree([
      im("rust.vec", "core", "primitive"),
      im("zeta.rs", "core", "algorithm"),
      im("alpha.rs", "core", "algorithm"),
      im("b.rs", "bar"),
    ])!;
    expect(t.map((r) => r.label)).toEqual(["core", "bar"]); // first-appearance, not alphabetical
    expect(t[0].items.map((i) => i.id)).toEqual(["rust.vec", "zeta.rs", "alpha.rs"]);
  });

  it("places two impls sharing a folder side by side, and counts a subtree transitively", () => {
    const t = folderTree([im("a.rs", "crates/x/src"), im("b.rs", "crates/x/src")])!;
    const leaf = t[0].folders[0].folders[0];
    expect(leaf.key).toBe("crates/x/src");
    expect(leaf.items).toHaveLength(2);
    expect(folderImplCount(t[0])).toBe(2);
  });
});
