import { describe, it, expect } from "vitest";
import { effectiveProjectRepos } from "../screens/projects/projectRepos";

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
});
