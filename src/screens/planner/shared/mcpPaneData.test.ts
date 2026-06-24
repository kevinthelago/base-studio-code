import { describe, it, expect } from "vitest";
import { buildMcpServers } from "./mcpPaneData";
import type { McpServer } from "@/features/extensions/lib/mcpServers";
import type { FleetPlan } from "../stages/planSections";

const mcp = (over: Partial<McpServer>): McpServer => ({
  id: "e", name: "x", enabled: true, projects: [], transport: "stdio", command: "", args: "", env: [], ...over,
});

const fleet: FleetPlan = {
  recommended: 2, reasoning: "", director: { enabled: true, role: "integrator" },
  streams: [
    { id: "auth", name: "Auth", repo: "o/r", owns: [], issues: [], dependsOn: [] },
    { id: "api", name: "API", repo: "o/r", owns: [], issues: [], dependsOn: [] },
  ],
};

describe("buildMcpServers", () => {
  it("includes globals + project-scoped MCP servers, excludes other projects", () => {
    const servers: McpServer[] = [
      mcp({ id: "g", name: "Compliance", projects: [] }),
      mcp({ id: "p", name: "Dependency Graph", projects: ["proj"] }),
      mcp({ id: "other", name: "Complexity Analyzer", projects: ["nope"] }),
    ];
    expect(buildMcpServers(servers, "proj", fleet).map((s) => s.id)).toEqual(["g", "p"]);
  });

  it("joins catalog metadata and resolves the launch command for stdio + http", () => {
    const stdio = buildMcpServers([mcp({ id: "c", name: "Compliance", command: "uv", args: "run --directory /b/mcp/compliance-mcp-server compliance-mcp" })], "p", fleet)[0];
    expect(stdio.desc).toMatch(/compliance/i);
    expect(stdio.official).toBe(false);     // first-party, not @modelcontextprotocol
    expect(stdio.downloadable).toBe(true);
    expect(stdio.cmd).toBe("uv run --directory /b/mcp/compliance-mcp-server compliance-mcp");

    const http = buildMcpServers([mcp({ id: "u", name: "Remote", transport: "http", url: "https://x/sse" })], "p", fleet)[0];
    expect(http.cmd).toBe("https://x/sse");
    expect(http.downloadable).toBe(false);
    expect(http.status).toBe("ready"); // remote is ready once enabled
  });

  it("an enabled project server reaches the whole fleet (director + every worker)", () => {
    const s = buildMcpServers([mcp({ id: "c", name: "Compliance", projects: ["p"] })], "p", fleet)[0];
    expect(s.scope).toBe("fleet");
    expect(s.agents).toEqual(["director", "auth", "api"]);
  });

  it("a disabled server is configured but not granted (no scope, no agents)", () => {
    const s = buildMcpServers([mcp({ id: "c", name: "Compliance", enabled: false })], "p", fleet)[0];
    expect(s.scope).toBe("—");
    expect(s.agents).toEqual([]);
  });

  it("downloadable status follows the install-state map; defaults to 'available'", () => {
    const exts = [mcp({ id: "c", name: "Compliance" }), mcp({ id: "d", name: "Dependency Graph" })];
    const built = buildMcpServers(exts, "p", fleet, { c: "ready" });
    expect(built.find((s) => s.id === "c")!.status).toBe("ready");
    expect(built.find((s) => s.id === "d")!.status).toBe("available");
  });

  it("excludes the director from agents when the fleet has no director", () => {
    const noDir: FleetPlan = { ...fleet, director: { enabled: false } };
    expect(buildMcpServers([mcp({ id: "c", name: "Compliance" })], "p", noDir)[0].agents).toEqual(["auth", "api"]);
  });
});
