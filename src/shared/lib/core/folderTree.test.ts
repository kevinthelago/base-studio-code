// The shared rail folder tree (#4128) — the ONE builder both library rails render. The
// feature-specific suites (`kitGroups.test.ts`, `algorithms/lib/folderTree.test.ts`) exercise their own
// bindings; this covers the model itself, including the two decisions the two former copies had
// diverged on: where an item with no folder goes, and whose ordering wins.
import { describe, it, expect } from "vitest";
import { buildFolderTree, folderItemCount, UNGROUPED_KEY, UNGROUPED_LABEL } from "./folderTree";

interface Rec { id: string; folder?: string }
const r = (id: string, folder?: string): Rec => ({ id, folder });
const tree = (items: Rec[]) => buildFolderTree(items, (x) => x.folder);

describe("buildFolderTree", () => {
  it("splits a `/` path into nested folders, with the record at the LEAF", () => {
    const t = tree([r("btn", "shared/ui/controls"), r("box", "shared/ui/layout")])!;
    expect(t.map((f) => f.label)).toEqual(["shared"]);
    expect(t[0].key).toBe("shared");
    expect(t[0].items).toEqual([]); // nothing lives directly in `shared`
    const ui = t[0].folders[0];
    expect(ui.key).toBe("shared/ui");
    expect(ui.folders.map((f) => f.key)).toEqual(["shared/ui/controls", "shared/ui/layout"]);
    expect(ui.folders[0].items.map((x) => x.id)).toEqual(["btn"]);
  });

  it("lets a folder hold BOTH direct records and subfolders", () => {
    const t = tree([r("panel", "shared/ui"), r("btn", "shared/ui/controls")])!;
    const ui = t[0].folders[0];
    expect(ui.items.map((x) => x.id)).toEqual(["panel"]);
    expect(ui.folders.map((f) => f.label)).toEqual(["controls"]);
    expect(folderItemCount(t[0])).toBe(2); // transitive
  });

  it("forces the ungrouped bucket LAST, whatever order the records arrived in", () => {
    const t = tree([r("a", "forms"), r("b"), r("c", "data")])!;
    expect(t.map((f) => f.label)).toEqual(["forms", "data", UNGROUPED_LABEL]);
    expect(t[2].key).toBe(UNGROUPED_KEY);
    expect(t[2].ungrouped).toBe(true);
    expect(t.slice(0, 2).every((f) => !f.ungrouped)).toBe(true);
  });

  it("preserves the CALLER's ordering — first-appearance for folders, input order within one", () => {
    // Load-bearing: each rail sorts its rows first (components by tier, algorithms primitives-first) and
    // that reading has to survive into every folder. Re-sorting here would silently override it.
    const t = tree([r("z", "zeta"), r("a", "alpha"), r("y", "zeta")])!;
    expect(t.map((f) => f.label)).toEqual(["zeta", "alpha"]); // NOT alphabetical
    expect(t[0].items.map((x) => x.id)).toEqual(["z", "y"]);
  });

  it("returns null when NOTHING carries a folder, so a caller renders its flat list", () => {
    expect(tree([r("a"), r("b")])).toBeNull();
    expect(tree([r("a", "   "), r("b", "")])).toBeNull();
    expect(tree([])).toBeNull();
  });

  it("treats a separator-only path as unfoldered rather than making a nameless folder", () => {
    const t = tree([r("a", "/"), r("b", " / / "), r("c", "real")])!;
    expect(t.map((f) => f.label)).toEqual(["real", UNGROUPED_LABEL]);
    expect(t[1].items.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("collapses repeated separators instead of emitting empty segments", () => {
    const t = tree([r("a", "shared//ui")])!;
    expect(t[0].folders.map((f) => f.key)).toEqual(["shared/ui"]);
  });
});
