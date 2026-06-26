import { describe, it, expect } from "vitest";
import { toSessionPayloads, mcpAllowRules } from "./sessionConfig";
import { type McpServer } from "@/features/extensions/lib/mcpServers";
import { type Hook } from "@/features/extensions/lib/hooks";

const mcp = (over: Partial<McpServer>): McpServer => ({
  id: "m", name: over.id ?? "m", enabled: true, projects: [], transport: "stdio", ...over,
});
const hook = (over: Partial<Hook>): Hook => ({
  id: "h", name: over.id ?? "h", enabled: true, projects: [], event: "PostToolUse", command: "x", ...over,
});

describe("toSessionPayloads", () => {
  it("converts both lists and drops incomplete entries", () => {
    const { mcp: servers, hooks } = toSessionPayloads(
      [
        mcp({ id: "a", command: "npx", args: "p" }),
        mcp({ id: "c", command: "" }), // incomplete → dropped
      ],
      [
        hook({ id: "b", event: "Stop", command: "x" }),
        hook({ id: "d", command: "" }), // incomplete → dropped
      ],
    );
    expect(servers.map(m => m.name)).toEqual(["a"]);
    expect(hooks.map(h => h.event)).toEqual(["Stop"]);
  });

  it("returns empty lists for empty inputs", () => {
    expect(toSessionPayloads([], [])).toEqual({ mcp: [], hooks: [] });
  });
});

describe("mcpAllowRules", () => {
  it("emits an `mcp__<server>` allow rule per resolved server (all tools)", () => {
    const { mcp } = toSessionPayloads(
      [mcp_("Research", "bsc-research-mcp"), mcp_("Compliance", "bsc-compliance-mcp")],
      [],
    );
    // No `__<tool>` suffix → Claude Code auto-approves every tool from that server, so the planner
    // never hits a per-tool prompt when it calls the Research MCP while grounding a skill.
    expect(mcpAllowRules(mcp)).toEqual(["mcp__Research", "mcp__Compliance"]);
  });

  it("is empty when there are no servers", () => {
    expect(mcpAllowRules([])).toEqual([]);
  });
});

function mcp_(name: string, command: string): McpServer {
  return { id: name, name, enabled: true, projects: [], transport: "stdio", command };
}
