import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAppStore } from "@/store";
import { projectLinkId, type ProjectLink } from "./projectLinks";
import { buildGlanceData } from "./glanceData";
import * as bridge from "./projectLinksBridge";

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

describe("projectLinks write-through slice (#2253 — bsc project link)", () => {
  beforeEach(() => {
    useAppStore.setState({ projectLinks: [] });
    vi.restoreAllMocks();
  });

  it("addProjectLink appends, dedups by id, rejects self-loops — pushing through the bridge once", () => {
    const push = vi.spyOn(bridge, "pushProjectLink").mockResolvedValue(undefined);
    useAppStore.getState().addProjectLink("a", "b", "api");
    useAppStore.getState().addProjectLink("a", "b", "api"); // duplicate id → no-op, no push
    useAppStore.getState().addProjectLink("c", "c", "data"); // self-loop → rejected
    const links = useAppStore.getState().projectLinks;
    expect(links).toEqual([{ id: projectLinkId("a", "b", "api"), from: "a", to: "b", kind: "api" }]);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith("a", "b", "api");
  });

  it("removeProjectLink drops by id and pushes the removal through the bridge", () => {
    vi.spyOn(bridge, "pushProjectLink").mockResolvedValue(undefined);
    const drop = vi.spyOn(bridge, "dropProjectLink").mockResolvedValue(undefined);
    useAppStore.getState().addProjectLink("a", "b", "api");
    const id = projectLinkId("a", "b", "api");
    useAppStore.getState().removeProjectLink(id);
    expect(useAppStore.getState().projectLinks).toHaveLength(0);
    expect(drop).toHaveBeenCalledWith(id);
  });

  it("hydrateProjectLinks replaces the cache when reachable, keeps it when not", async () => {
    const seed: ProjectLink[] = [{ id: projectLinkId("x", "y", "events"), from: "x", to: "y", kind: "events" }];
    useAppStore.setState({ projectLinks: seed });
    vi.spyOn(bridge, "loadProjectLinks").mockResolvedValueOnce(null); // unreachable → keep the cache
    await useAppStore.getState().hydrateProjectLinks();
    expect(useAppStore.getState().projectLinks).toEqual(seed);
    const loaded: ProjectLink[] = [{ id: projectLinkId("m", "n", "data"), from: "m", to: "n", kind: "data" }];
    vi.spyOn(bridge, "loadProjectLinks").mockResolvedValueOnce(loaded); // reachable → authoritative replace
    await useAppStore.getState().hydrateProjectLinks();
    expect(useAppStore.getState().projectLinks).toEqual(loaded);
  });
});
