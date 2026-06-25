import { describe, it, expect } from "vitest";
import { resolveMcpServers, resolveAllInstalledMcp, resolveStreamMcp, toMcpPayload, toBscAgentMcp, mcpFromCatalog, blankMcpServer, type McpServer, type McpServerPayload } from "./mcpServers";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";

// Helper: a minimal enabled stdio server; `name` defaults to the id for readable asserts.
const mk = (over: Partial<McpServer>): McpServer => ({
  id: "e", name: over.id ?? "e", enabled: true, projects: [], transport: "stdio", ...over,
});

// Drop the always-present built-in servers (#1196 Research, #1005 Compliance) so the user-server
// assertions stay focused.
const noBuiltins = (servers: McpServer[]) =>
  servers.map(e => e.id).filter(id => id !== "builtin-research" && id !== "builtin-compliance");

describe("resolveMcpServers", () => {
  it("includes enabled globals + this-project matches; drops disabled and other projects", () => {
    const all = [
      mk({ id: "g", projects: [] }),
      mk({ id: "p", projects: ["P1"] }),
      mk({ id: "q", projects: ["P2"] }),
      mk({ id: "off", projects: [], enabled: false }),
    ];
    expect(noBuiltins(resolveMcpServers(all, "P1"))).toEqual(["g", "p"]);
    expect(noBuiltins(resolveMcpServers(all, "P2"))).toEqual(["g", "q"]);
    // No project (ad-hoc console) → globals only.
    expect(noBuiltins(resolveMcpServers(all, ""))).toEqual(["g"]);
  });

  it("always includes the built-in Research + Compliance servers (#1196 / #1005)", () => {
    const names = resolveMcpServers([], "").map(e => e.name);
    expect(names).toContain("Research");
    expect(names).toContain("Compliance");
  });
});

describe("resolveAllInstalledMcp", () => {
  it("returns every runnable server regardless of enabled / project scope (#1054)", () => {
    const all = [
      mk({ id: "g", command: "x" }),                                 // global enabled
      mk({ id: "off", command: "x", enabled: false }),               // disabled — still exposed to the planner
      mk({ id: "scoped", command: "x", projects: ["other"] }),       // scoped to a different project
      mk({ id: "http", transport: "http", url: "https://h/sse" }),   // complete http
      mk({ id: "broken" }),                                          // stdio without a command → dropped
    ];
    expect(noBuiltins(resolveAllInstalledMcp(all))).toEqual(["g", "off", "scoped", "http"]);
  });

  it("exposes the built-in Research + Compliance servers to the planner by default (#1196 / #1005)", () => {
    const names = resolveAllInstalledMcp([]).map(e => e.name);
    expect(names).toContain("Research");
    expect(names).toContain("Compliance");
  });
});

describe("resolveStreamMcp", () => {
  const all = [
    mk({ id: "g", name: "g", command: "x", projects: [] }),                                   // global enabled → baseline
    mk({ id: "p", name: "p", command: "x", projects: ["P1"] }),                                // this-project → baseline
    mk({ id: "off", name: "off", command: "x", enabled: false }),                             // disabled global → not baseline
    mk({ id: "ex", name: "Extra", command: "x", enabled: false, projects: ["zzz"] }),         // assignable extra
  ];
  it("is the #876 baseline (enabled global + this-project) plus stream-assigned extras", () => {
    // No assignment → just the baseline.
    expect(noBuiltins(resolveStreamMcp(all, [], "P1"))).toEqual(["g", "p"]);
    // Assign Extra by name (disabled + other-project) → included as an extra, baseline first.
    expect(noBuiltins(resolveStreamMcp(all, ["extra"], "P1"))).toEqual(["g", "p", "ex"]);
    // Assigning a server already in the baseline doesn't duplicate it.
    expect(noBuiltins(resolveStreamMcp(all, ["g"], "P1"))).toEqual(["g", "p"]);
  });

  it("rides the worker baseline with the built-in Research + Compliance servers (#1196 / #1005)", () => {
    const names = resolveStreamMcp(all, [], "P1").map(e => e.name);
    expect(names).toContain("Research");
    expect(names).toContain("Compliance");
  });
});

describe("toMcpPayload", () => {
  it("stdio → command + split args; http → url; env defaults to []", () => {
    expect(toMcpPayload(mk({ transport: "stdio", command: "npx", args: "-y pkg" })))
      .toEqual({ name: "e", transport: "stdio", command: "npx", args: ["-y", "pkg"], env: [] });
    expect(toMcpPayload(mk({ transport: "http", url: "https://h/sse" })))
      .toEqual({ name: "e", transport: "http", args: [], url: "https://h/sse", env: [] });
  });

  it("returns null for incomplete servers", () => {
    expect(toMcpPayload(mk({ transport: "stdio", command: "" }))).toBeNull();
    expect(toMcpPayload(mk({ transport: "http", url: "" }))).toBeNull();
  });
});

describe("catalog templates + blank", () => {
  it("fills a known stdio template, disabled + global", () => {
    const d = mcpFromCatalog("Postgres");
    expect(d).toMatchObject({ transport: "stdio", command: "npx", enabled: false, projects: [], name: "Postgres" });
    expect(d.args).toContain("server-postgres");
  });

  it("falls back to a blank stdio server for unknown names", () => {
    expect(mcpFromCatalog("Nope")).toMatchObject({ transport: "stdio", command: "", name: "Nope" });
  });

  it("includes the first-party downloadable MCP servers with download links + run configs (#858)", () => {
    const firstParty = ["Complexity Analyzer", "Dependency Graph", "Plan Grader"];
    for (const name of firstParty) {
      const item = MCP_CATALOG.find((c) => c.name === name);
      expect(item, `${name} in catalog`).toBeDefined();
      expect(item!.link).toMatch(/^https:\/\/github\.com\/kevinthelago\//);
      expect(item!.install).toBeTruthy();
    }
    // "add" produces a stdio config whose args carry the {dir} placeholder, substituted with the
    // on-disk download path (~/.base-studio-code/mcp/<repo>) when added.
    expect(mcpFromCatalog("Complexity Analyzer")).toMatchObject({ command: "node", args: "{dir}/dist/mcp/index.js" });
    expect(mcpFromCatalog("Dependency Graph")).toMatchObject({ command: "node", args: "{dir}/dist/index.js" });
    expect(mcpFromCatalog("Plan Grader")).toMatchObject({ transport: "stdio", command: "python", args: "-m uv run --directory {dir} plan-grader-mcp" });
  });

  it("presents Research + Compliance as built-in servers — no download/build, native binary (#1196 / #1005)", () => {
    for (const name of ["Research", "Compliance"]) {
      const item = MCP_CATALOG.find((c) => c.name === name);
      expect(item?.builtIn, `${name} built-in`).toBe(true);
      expect(item?.link).toBeUndefined();
      expect(item?.install).toBeUndefined();
    }
    // Each template points at its bundled native binary marker (the Rust side rewrites it to the
    // absolute path when writing .mcp.json), not a downloaded Node/Python entrypoint.
    expect(mcpFromCatalog("Research")).toMatchObject({ transport: "stdio", command: "bsc-research-mcp", args: "" });
    expect(mcpFromCatalog("Compliance")).toMatchObject({ transport: "stdio", command: "bsc-compliance-mcp", args: "" });
  });

  it("blankMcpServer produces an empty stdio shape", () => {
    expect(blankMcpServer()).toMatchObject({ transport: "stdio", command: "", enabled: false, projects: [] });
  });
});

describe("toBscAgentMcp", () => {
  it("keeps stdio servers, drops http, and maps env to an object", () => {
    const payloads: McpServerPayload[] = [
      { name: "fs", transport: "stdio", command: "mcp-fs", args: ["--root", "."], env: [["TOKEN", "x"]] },
      { name: "web", transport: "http", args: [], url: "https://example.com", env: [] },
    ];
    const out = toBscAgentMcp(payloads);
    expect(out).toEqual([{ name: "fs", command: "mcp-fs", args: ["--root", "."], env: { TOKEN: "x" } }]);
  });
});
