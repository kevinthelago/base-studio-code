import { describe, it, expect } from "vitest";
import { projectLinkId, type ProjectLink } from "./projectLinks";
import { buildGlanceData } from "./glanceData";

describe("projectLinkId", () => {
  it("is deterministic per (from,to,kind) so adding a link twice is idempotent", () => {
    expect(projectLinkId("a", "b", "api")).toBe(projectLinkId("a", "b", "api"));
    expect(projectLinkId("a", "b", "api")).not.toBe(projectLinkId("b", "a", "api")); // directed
    expect(projectLinkId("a", "b", "api")).not.toBe(projectLinkId("a", "b", "data")); // kind matters
  });
});

describe("buildGlanceData with project links (#2253)", () => {
  const projects = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }];

  it("renders the user's links as edges, carrying the link id", () => {
    const links: ProjectLink[] = [{ id: "a>b:api", from: "a", to: "b", kind: "api" }];
    const d = buildGlanceData(projects, links);
    expect(d.sample).toBe(false);
    expect(d.rawEdges).toEqual([{ id: "a>b:api", from: "a", to: "b", kind: "api" }]);
  });

  it("drops a link whose endpoint no longer exists", () => {
    const links: ProjectLink[] = [
      { id: "a>b:api", from: "a", to: "b", kind: "api" },
      { id: "a>gone:data", from: "a", to: "gone", kind: "data" },
    ];
    expect(buildGlanceData(projects, links).rawEdges.map((e) => e.id)).toEqual(["a>b:api"]);
  });

  it("no links → an un-wired node grid (no fabricated edges)", () => {
    expect(buildGlanceData(projects).rawEdges).toEqual([]);
  });
});
