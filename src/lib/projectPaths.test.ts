import { describe, it, expect } from "vitest";
import { agentWorktreeCwd, projectHubCwd, worktreeSlug, mcpInstallDir } from "./projectPaths";

describe("mcpInstallDir (#859 follow-up — download location)", () => {
  it("places a server under <base>/mcp/<name>", () => {
    expect(mcpInstallDir("/base", "compliance-mcp-server")).toBe("/base/mcp/compliance-mcp-server");
  });
  it("uses backslashes for a Windows base", () => {
    expect(mcpInstallDir("C:\\base", "complexity-analyzer-mcp")).toBe("C:\\base\\mcp\\complexity-analyzer-mcp");
  });
  it("returns empty string when base is empty", () => {
    expect(mcpInstallDir("", "x")).toBe("");
  });
});

describe("agentWorktreeCwd (#844 — worktrees live outside the hub)", () => {
  it("places worktrees under <base>/worktrees/<key>/, NOT under the project hub", () => {
    const cwd = agentWorktreeCwd("/base", "proj-key", "own/web", "auth-ui");
    expect(cwd).toBe("/base/worktrees/proj-key/web--auth-ui");
    // The hub (which holds the planner CLAUDE.md) must not be a prefix of the worktree —
    // that's the whole point: the planner spec is no longer an ancestor of the worker cwd.
    expect(cwd.startsWith(projectHubCwd("/base", "proj-key"))).toBe(false);
  });

  it("uses the repo short name and the branch-safe agent slug", () => {
    expect(agentWorktreeCwd("/base", "k", "acme/api-service", "api worker!")).toBe(
      `/base/worktrees/k/api-service--${worktreeSlug("api worker!")}`,
    );
  });

  it("uses backslashes when baseDir is a Windows path", () => {
    expect(agentWorktreeCwd("C:\\base", "k", "own/web", "web-a")).toBe(
      "C:\\base\\worktrees\\k\\web--web-a",
    );
  });

  it("sanitizes the project key into the path", () => {
    expect(agentWorktreeCwd("/base", "My Proj!", "own/web", "a")).toBe(
      "/base/worktrees/My_Proj_/web--a",
    );
  });

  it("returns empty string when baseDir is empty", () => {
    expect(agentWorktreeCwd("", "k", "own/web", "a")).toBe("");
  });
});
