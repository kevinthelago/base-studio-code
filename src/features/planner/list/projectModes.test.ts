import { describe, it, expect } from "vitest";
import { PROJECT_MODES } from "@/features/planner/list/projectModes";
import { GRAPH_PAGE_KEYS } from "@/store/retiredWorkspaces";

describe("PROJECT_MODES", () => {
  it("is the single Projects page — every graph tab left for its own Workspace", () => {
    // `five-graphs-become-rail-workspaces` reversed the folding-in. The Planner keeps exactly what it
    // is for; `themes` was already gone (#2834, folded into the Components preview) and stays gone.
    const ids = PROJECT_MODES.map((m) => m.id);
    expect(ids).toEqual(["projects"]);
    expect(ids).not.toContain("themes");
  });

  it("every departed tab id has a forwarding entry, so no persisted page mode is stranded", () => {
    // The pairing that matters: a tab id removed from here with no `GRAPH_PAGES` entry leaves anyone
    // whose last session ended on it reopening the Planner on a page that does not exist. The Planner
    // falls back to Projects, so nothing errors and nobody reports it — which is exactly why the two
    // are asserted together rather than separately.
    //
    // `designs` is the one to watch: its tab id was the internal feature name while its label was
    // "Components" (#2818), so its forwarding entry is deliberately not identity.
    for (const departed of ["designs", "teams", "algorithms", "sounds", "data"]) {
      expect(PROJECT_MODES.map((m) => m.id)).not.toContain(departed);
      expect(GRAPH_PAGE_KEYS, `${departed} was removed with no forwarding entry`).toContain(departed);
    }
  });
});
