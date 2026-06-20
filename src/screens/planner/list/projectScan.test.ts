import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { reposFromItems, scanProjectRepos, scanPlanSections, type ProjectItemNode } from "./projectScan";

const item = (nameWithOwner?: string): ProjectItemNode =>
  nameWithOwner === undefined ? { content: null } : { content: { repository: { nameWithOwner } } };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("reposFromItems", () => {
  it("returns the unique repositories across items", () => {
    const repos = reposFromItems([item("acme/api"), item("acme/web"), item("acme/api")]);
    expect(repos).toEqual(["acme/api", "acme/web"]);
  });

  it("skips items with no issue content or no repository", () => {
    const repos = reposFromItems([item("acme/api"), item(undefined), { content: { repository: null } }, {}]);
    expect(repos).toEqual(["acme/api"]);
  });

  it("returns [] for an empty project", () => {
    expect(reposFromItems([])).toEqual([]);
  });

  it("preserves first-seen order", () => {
    expect(reposFromItems([item("z/last"), item("a/first"), item("z/last")])).toEqual(["z/last", "a/first"]);
  });
});

describe("scanProjectRepos", () => {
  it("queries the project's items and returns the deduped repo set (beyond the list query's cap)", async () => {
    // A project whose issues span 5 repos — more than the projects-list query
    // surfaces — proving the scan resolves the full set.
    vi.mocked(invoke).mockResolvedValueOnce({
      node: { items: { nodes: [
        item("acme/api"), item("acme/web"), item("acme/api"),
        item("acme/cli"), item("acme/docs"), item("acme/infra"),
      ] } },
    });

    const repos = await scanProjectRepos("tok", "PVT_123");

    expect(repos).toEqual(["acme/api", "acme/web", "acme/cli", "acme/docs", "acme/infra"]);
    expect(invoke).toHaveBeenCalledWith("github_graphql", expect.objectContaining({
      token: "tok",
      variables: { id: "PVT_123" },
    }));
  });

  it("returns [] when the project node or items are missing", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ node: null });
    expect(await scanProjectRepos("tok", "PVT_x")).toEqual([]);
  });
});

describe("scanPlanSections", () => {
  it("reads plan sections from disk keyed by the project title", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ goal: "# Goal", phases: "[]" });

    const sections = await scanPlanSections("WoTos");

    expect(sections).toEqual({ goal: "# Goal", phases: "[]" });
    expect(invoke).toHaveBeenCalledWith("read_plan_sections", { projectKey: "WoTos" });
  });
});
