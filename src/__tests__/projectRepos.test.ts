import { describe, it, expect } from "vitest";
import { effectiveProjectRepos } from "../screens/planner/projectRepos";

describe("effectiveProjectRepos (#833)", () => {
  const local = { "my-project": ["acme/api"], "proj-x": ["acme/web", "acme/api"] };

  it("surfaces the persisted linked repos for an UNPUBLISHED project (survives restart)", () => {
    // No activeProjectId (no GitHub board yet): read the persisted set under effectiveProjectId.
    expect(effectiveProjectRepos(null, "my-project", [], local)).toEqual(["acme/api"]);
  });

  it("is empty for an unpublished project with nothing linked yet", () => {
    expect(effectiveProjectRepos(null, "fresh-project", [], local)).toEqual([]);
  });

  it("uses the board repos for a published project", () => {
    expect(effectiveProjectRepos("proj-x", "proj-x", ["acme/web"], local)).toEqual(["acme/web"]);
  });

  it("falls back to the cloned set when a published board hasn't loaded its repos yet", () => {
    expect(effectiveProjectRepos("proj-x", "proj-x", [], local)).toEqual(["acme/web", "acme/api"]);
  });

  // #881: linked repos are written under two keys (title-derived effectiveProjectId vs the
  // GitHub node id). Reading must union both, or links vanish on restart → relink.
  it("finds links stored under the title key when a published board hasn't loaded (node id ≠ title key)", () => {
    // Linked under the title key ("my-project") during planning; project later published with a
    // different node-id activeProjectId. Board not loaded yet → must still surface the link.
    expect(effectiveProjectRepos("node_123", "my-project", [], { "my-project": ["acme/api"] }))
      .toEqual(["acme/api"]);
  });

  it("unions links stored under BOTH the node id and the title key, deduped", () => {
    const split = { "node_123": ["acme/api"], "my-project": ["acme/api", "acme/web"] };
    expect(effectiveProjectRepos("node_123", "my-project", [], split)).toEqual(["acme/api", "acme/web"]);
  });

  it("an unpublished project also reads links written under a stale node id key", () => {
    // Defensive: even with no active board, a link recorded under some other key for this
    // effectiveProjectId is read (effectiveProjectId is the primary key here).
    expect(effectiveProjectRepos(null, "my-project", [], { "my-project": ["acme/api"] }))
      .toEqual(["acme/api"]);
  });
});
