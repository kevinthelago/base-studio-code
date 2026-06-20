import { describe, it, expect } from "vitest";
import {
  repoNameFromLink, catalogLink, mcpDirForServer, resolveMcpInstallDir,
} from "./mcpInstall";

describe("mcpInstall helpers", () => {
  it("repoNameFromLink takes the last path segment, trailing slash tolerant", () => {
    expect(repoNameFromLink("https://github.com/kevinthelago/compliance-mcp-server")).toBe("compliance-mcp-server");
    expect(repoNameFromLink("https://github.com/kevinthelago/dependency-graph-mcp-server/")).toBe("dependency-graph-mcp-server");
  });

  it("catalogLink returns the download link for first-party servers only", () => {
    expect(catalogLink("Compliance")).toMatch(/github\.com\/kevinthelago\/compliance-mcp-server$/);
    expect(catalogLink("Complexity Analyzer")).toMatch(/complexity-analyzer-mcp$/);
    expect(catalogLink("Postgres")).toBeUndefined();
    expect(catalogLink("Unknown")).toBeUndefined();
  });

  it("mcpDirForServer builds the install path, '' for non-downloadable or empty base", () => {
    expect(mcpDirForServer("Compliance", "/b")).toBe("/b/mcp/compliance-mcp-server");
    expect(mcpDirForServer("Compliance", "")).toBe("");
    expect(mcpDirForServer("Postgres", "/b")).toBe("");
  });

  it("resolveMcpInstallDir substitutes {dir}; no-op without {dir}, link, or base", () => {
    expect(resolveMcpInstallDir({ args: "run --directory {dir} compliance-mcp" }, "Compliance", "/b").args)
      .toBe("run --directory /b/mcp/compliance-mcp-server compliance-mcp");
    // No baseDir → unchanged (resolved later when the base dir is known).
    expect(resolveMcpInstallDir({ args: "x {dir} y" }, "Compliance", "").args).toBe("x {dir} y");
    // Not a downloadable server → unchanged even with a base dir.
    expect(resolveMcpInstallDir({ args: "-y server-postgres" }, "Postgres", "/b").args).toBe("-y server-postgres");
    // Windows base dir → backslash separators in the substituted path.
    expect(resolveMcpInstallDir({ args: "{dir}/dist/index.js" }, "Dependency Graph", "C:\\Users\\k\\.base-studio-code").args)
      .toContain("C:\\Users\\k\\.base-studio-code\\mcp\\dependency-graph-mcp-server");
  });
});
