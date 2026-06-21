import { describe, it, expect } from "vitest";
import { toSessionPayloads } from "./sessionConfig";
import { type McpServer } from "./mcpServers";
import { type Hook } from "./hooks";

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
