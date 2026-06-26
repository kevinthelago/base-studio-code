import { describe, it, expect } from "vitest";
import { buildMcpLibrary, collectBlueprintMcp, applyBlueprintMcp } from "./blueprintMcp";
import { addMcpServer, removeMcpServer } from "./blueprintEdit";
import { type McpStoreLike } from "../lib/planExtensions";
import type { McpServer } from "@/features/mcp/lib/mcpServers";
import type { Blueprint, BlueprintSection } from "../stages/blueprints";

const sec = (over: Partial<BlueprintSection>): BlueprintSection => ({
  uid: over.uid ?? "u", key: over.key ?? "discovery", name: "S", glyph: "◆", gate: "", deps: [],
  blurb: "", prompt: "", enabled: true, expanded: false, ...over,
});

describe("buildMcpLibrary", () => {
  it("includes the first-party catalog MCP servers, excludes hooks", () => {
    const lib = buildMcpLibrary([]);
    const names = lib.map((i) => i.name);
    expect(names).toContain("Compliance");
    expect(names).toContain("Complexity Analyzer");
    expect(names).toContain("Dependency Graph");
    // Hook catalog templates (Block PII / Auto-format) are not MCP servers.
    expect(names).not.toContain("Block PII");
    expect(names).not.toContain("Auto-format");
    // Downloadable first-party servers are flagged; the built-in Compliance (#1005) is not.
    expect(lib.find((i) => i.name === "Dependency Graph")!.downloadable).toBe(true);
    expect(lib.find((i) => i.name === "Compliance")!.downloadable).toBe(false);
  });

  it("adds installed MCP servers not already in the catalog, deduped by name", () => {
    const servers: McpServer[] = [
      { id: "e1", name: "Custom Server", enabled: true, projects: [], transport: "stdio", command: "x", args: "", env: [] },
      { id: "e2", name: "Compliance", enabled: true, projects: [], transport: "stdio", command: "x", args: "", env: [] }, // dup of catalog
    ];
    const lib = buildMcpLibrary(servers);
    expect(lib.filter((i) => i.name === "Compliance")).toHaveLength(1); // deduped
    expect(lib.some((i) => i.name === "Custom Server")).toBe(true);
  });
});

describe("collectBlueprintMcp", () => {
  it("unions blueprint-wide + every section's mcp, deduped + order-preserving (blueprint-wide first)", () => {
    const bp = {
      mcp: ["Compliance"],
      sections: [
        sec({ uid: "a", mcp: ["Complexity Analyzer", "Compliance"] }),
        sec({ uid: "b", mcp: ["Dependency Graph"] }),
        sec({ uid: "c" }), // no mcp
      ],
    } as unknown as Blueprint;
    expect(collectBlueprintMcp(bp)).toEqual(["Compliance", "Complexity Analyzer", "Dependency Graph"]);
  });

  it("is empty when nothing is attached", () => {
    expect(collectBlueprintMcp({ sections: [sec({})] } as unknown as Blueprint)).toEqual([]);
  });
});

describe("applyBlueprintMcp (#897 Phase 2)", () => {
  const makeStore = (initial: McpServer[] = []): McpStoreLike & { mcpServers: McpServer[] } => {
    const store = {
      mcpServers: [...initial],
      addMcpServer(def: Omit<McpServer, "id">) { store.mcpServers.push({ ...def, id: `mcp_${store.mcpServers.length}` }); },
      updateMcpServer(id: string, patch: Partial<McpServer>) { store.mcpServers = store.mcpServers.map((e) => (e.id === id ? { ...e, ...patch } : e)); },
    };
    return store;
  };

  it("scopes every attached server to the project (enabled) and returns the downloadable ones", () => {
    const bp = {
      mcp: ["Compliance"], // built-in native server (#1005) — scoped but not cloned
      sections: [sec({ uid: "a", mcp: ["Dependency Graph"] })], // downloadable first-party
    } as unknown as Blueprint;
    const store = makeStore();
    const downloadable = applyBlueprintMcp(store, bp, "proj", "/base");
    // Both servers added, enabled, scoped to the project.
    expect(store.mcpServers.map((e) => e.name).sort()).toEqual(["Compliance", "Dependency Graph"]);
    expect(store.mcpServers.every((e) => e.enabled && e.projects.includes("proj"))).toBe(true);
    // Only catalog-linked (downloadable) servers are returned for the caller to clone — the
    // built-in Compliance is not.
    expect(downloadable.sort()).toEqual(["Dependency Graph"]);
    // {dir} resolved for the downloadable first-party server.
    expect(store.mcpServers.find((e) => e.name === "Dependency Graph")!.args).not.toContain("{dir}");
  });

  it("is idempotent — re-applying enables + scopes without duplicating", () => {
    const bp = { mcp: ["Compliance"], sections: [] } as unknown as Blueprint;
    const store = makeStore();
    applyBlueprintMcp(store, bp, "proj", "/base");
    applyBlueprintMcp(store, bp, "proj", "/base");
    expect(store.mcpServers.filter((e) => e.name === "Compliance")).toHaveLength(1);
  });
});

describe("blueprintEdit MCP ops", () => {
  it("addMcpServer attaches by name (idempotent); removeMcpServer detaches", () => {
    let secs = [sec({ uid: "u" })];
    secs = addMcpServer(secs, "u", "Compliance");
    expect(secs[0].mcp).toEqual(["Compliance"]);
    secs = addMcpServer(secs, "u", "Compliance"); // no dup
    expect(secs[0].mcp).toEqual(["Compliance"]);
    secs = addMcpServer(secs, "u", "Dependency Graph");
    expect(secs[0].mcp).toEqual(["Compliance", "Dependency Graph"]);
    secs = removeMcpServer(secs, "u", "Compliance");
    expect(secs[0].mcp).toEqual(["Dependency Graph"]);
  });
});
