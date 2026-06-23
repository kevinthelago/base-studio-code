import { describe, it, expect } from "vitest";
import { buildMcpContext } from "./mcpContext";
import { type McpServer } from "../../../lib/session/mcpServers";
import { type CatalogItem } from "../../../data/mcpCatalog";

const mk = (name: string): McpServer => ({ id: name, name, enabled: true, projects: [], transport: "stdio", command: "x" });
const catalog: CatalogItem[] = [{ name: "Research", by: "k", icon: "⌕", desc: "Search scientific literature." }];

describe("buildMcpContext", () => {
  it("lists installed servers with catalog descriptions + a generic note for custom ones", () => {
    const md = buildMcpContext([mk("Research"), mk("MyServer")], catalog);
    expect(md).toContain("- **Research** — Search scientific literature.");
    expect(md).toContain("- **MyServer** — (custom server");
  });

  it("documents the per-worker assignment directive (the stream `mcp` list)", () => {
    const md = buildMcpContext([mk("Research")], catalog);
    expect(md).toContain('"mcp": ["Research"]');
    expect(md).toMatch(/exposed to you \(the planner\)/);
  });

  it("renders an empty-state line when nothing is installed", () => {
    const md = buildMcpContext([], catalog);
    expect(md).toContain("No MCP servers installed yet");
  });
});
