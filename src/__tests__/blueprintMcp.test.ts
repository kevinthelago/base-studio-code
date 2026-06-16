import { describe, it, expect } from "vitest";
import { buildMcpLibrary, resolveBlueprintMcp, collectBlueprintMcp } from "../screens/projects/blueprintMcp";
import { addMcpServer, removeMcpServer } from "../screens/projects/blueprintEdit";
import type { ExtensionDef } from "../lib/extensions";
import type { Blueprint, BlueprintSection } from "../screens/projects/blueprints";

const sec = (over: Partial<BlueprintSection>): BlueprintSection => ({
  uid: over.uid ?? "u", key: over.key ?? "context", name: "S", glyph: "◆", gate: "", deps: [],
  blurb: "", prompt: "", enabled: true, expanded: false, pipelines: [], ...over,
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
    // First-party servers are flagged downloadable.
    expect(lib.find((i) => i.name === "Compliance")!.downloadable).toBe(true);
  });

  it("adds installed MCP extensions not already in the catalog, deduped by name", () => {
    const exts: ExtensionDef[] = [
      { id: "e1", kind: "mcp", name: "Custom Server", enabled: true, projects: [], transport: "stdio", command: "x", args: "", env: [] },
      { id: "e2", kind: "mcp", name: "Compliance", enabled: true, projects: [], transport: "stdio", command: "x", args: "", env: [] }, // dup of catalog
      { id: "h1", kind: "hook", name: "A hook", enabled: true, projects: [], event: "PreToolUse", hookCommand: "x" },
    ];
    const lib = buildMcpLibrary(exts);
    expect(lib.filter((i) => i.name === "Compliance")).toHaveLength(1); // deduped
    expect(lib.some((i) => i.name === "Custom Server")).toBe(true);
    expect(lib.some((i) => i.name === "A hook")).toBe(false); // hooks excluded
  });
});

describe("resolveBlueprintMcp", () => {
  it("splits attached names into found (library) and missing (warn), case-insensitive, order-preserved", () => {
    const lib = buildMcpLibrary([]);
    const { found, missing } = resolveBlueprintMcp(["compliance", "Nonexistent", "Dependency Graph"], lib);
    expect(found.map((i) => i.name)).toEqual(["Compliance", "Dependency Graph"]);
    expect(missing).toEqual(["Nonexistent"]);
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
