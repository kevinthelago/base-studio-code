import { describe, it, expect } from "vitest";
import catalogTemplates from "@data/mcp/catalog-templates.json";
import { resolvePersonaMcp, resolveAllInstalledMcp, toMcpPayload, toBscAgentMcp, mcpFromCatalog, blankMcpServer, type McpServer, type McpServerPayload } from "@/features/mcp/lib/mcpServers";
import { MCP_CATALOG } from "@/shared/data/mcpCatalog";

// Helper: a minimal enabled stdio server; `name` defaults to the id for readable asserts.
//
// `command` is part of the DEFAULT because a stdio server without one has no runnable config, and
// `resolvePersonaMcp` skips those — a broken entry must never reach a session's .mcp.json. The old
// `resolveMcpServers` did NOT check, so a fixture with no command still resolved; that was the
// resolver being wrong, not the fixture being clever. Tests that WANT the incomplete case pass
// `command: ""` explicitly.
const mk = (over: Partial<McpServer>): McpServer => ({
  id: "e", name: over.id ?? "e", enabled: true, projects: [], transport: "stdio", command: "x", ...over,
});

// Drop the bundled built-in servers (#1196 Research, #1005 Compliance, #3146 Channel-mock) so the
// user-server assertions stay focused.
const BUILTIN_IDS = new Set(["builtin-research", "builtin-compliance", "builtin-channel-mock"]);
const noBuiltins = (servers: McpServer[]) =>
  servers.map(e => e.id).filter(id => !BUILTIN_IDS.has(id));

describe("resolvePersonaMcp — the ONE resolver", () => {
  // It replaced resolveMcpServers (project scoping), resolveStreamMcp (per-stream) and a per-pane
  // override. Everything below is a property of the ONE rule: ambient built-ins, plus what the
  // persona carries.

  it("gives a persona carrying nothing the ENABLED built-ins, and only those", () => {
    // A new persona is useful immediately rather than starting with no tools at all.
    const ids = resolvePersonaMcp([mk({ id: "a" })], []).map((e) => e.id);
    expect(ids).toContain("builtin-research");
    expect(ids).toContain("builtin-compliance");
    // …and NOT the disabled built-in, which is exactly the channel-mock case.
    expect(ids).not.toContain("builtin-channel-mock");
    // …and not a stored server nobody carries.
    expect(ids).not.toContain("a");
  });

  it("includes a stored server the persona carries", () => {
    const all = [mk({ id: "a" }), mk({ id: "b" })];
    expect(noBuiltins(resolvePersonaMcp(all, ["a"]))).toEqual(["a"]);
  });

  it("includes a CARRIED server even when it is disabled — carrying is intent", () => {
    // The old model needed a special case for this (a disabled built-in assignable per-stream).
    // Here it falls out of the rule: if a persona carries it, it gets it.
    const all = [mk({ id: "off", enabled: false })];
    expect(noBuiltins(resolvePersonaMcp(all, ["off"]))).toEqual(["off"]);
  });

  it("lets a persona carry a DISABLED BUILT-IN — what replaced the channel-mock carve-out", () => {
    // channel-mock must reach the marketer and nobody else. It is not in the server store at all,
    // so the resolver has to look at the bundled set too.
    const ids = resolvePersonaMcp([], ["builtin-channel-mock"]).map((e) => e.id);
    expect(ids).toContain("builtin-channel-mock");
    // …while a persona that does not carry it still does not get it.
    expect(resolvePersonaMcp([], []).map((e) => e.id)).not.toContain("builtin-channel-mock");
  });

  it("ignores an id that resolves to nothing, rather than emitting a hole", () => {
    // A dangling assignment survives `bsc mcp server remove`; it must not become a null entry in
    // the generated .mcp.json.
    expect(noBuiltins(resolvePersonaMcp([mk({ id: "a" })], ["gone", "a"]))).toEqual(["a"]);
  });

  it("skips a half-configured server even when carried", () => {
    // stdio with no command has no runnable config; a broken line must never reach a session.
    const all = [mk({ id: "broken", command: "" })];
    expect(noBuiltins(resolvePersonaMcp(all, ["broken"]))).toEqual([]);
  });

  it("never emits the same server twice", () => {
    // An enabled built-in that the persona ALSO carries is one server, not two — a duplicate would
    // become a duplicate key in .mcp.json.
    const ids = resolvePersonaMcp([], ["builtin-research"]).map((e) => e.id);
    expect(ids.filter((i) => i === "builtin-research")).toHaveLength(1);
  });

  it("puts the ambient built-ins first, so the generated file stays diffable", () => {
    const ids = resolvePersonaMcp([mk({ id: "z" })], ["z"]).map((e) => e.id);
    expect(ids.indexOf("builtin-research")).toBeLessThan(ids.indexOf("z"));
  });

  it("treats an ABSENT carry list as carrying nothing", () => {
    // `persona.mcp` is optional — a persona authored before this field exists must not throw.
    expect(() => resolvePersonaMcp([mk({ id: "a" })])).not.toThrow();
    expect(noBuiltins(resolvePersonaMcp([mk({ id: "a" })]))).toEqual([]);
  });

  it("ignores `projects` entirely — project scoping is GONE", () => {
    // The field survives on the type until it is dropped; it must no longer influence anything.
    const all = [mk({ id: "scoped", projects: ["some-project"] })];
    expect(noBuiltins(resolvePersonaMcp(all, []))).toEqual([]);        // not global any more
    expect(noBuiltins(resolvePersonaMcp(all, ["scoped"]))).toEqual(["scoped"]); // carried wins
  });
});
describe("resolveAllInstalledMcp", () => {
  it("returns every runnable server regardless of enabled / project scope (#1054)", () => {
    const all = [
      mk({ id: "g", command: "x" }),                                 // global enabled
      mk({ id: "off", command: "x", enabled: false }),               // disabled — still exposed to the planner
      mk({ id: "scoped", command: "x", projects: ["other"] }),       // scoped to a different project
      mk({ id: "http", transport: "http", url: "https://h/sse" }),   // complete http
      mk({ id: "broken", command: "" }),                             // stdio without a command → dropped
    ];
    expect(noBuiltins(resolveAllInstalledMcp(all))).toEqual(["g", "off", "scoped", "http"]);
  });

  it("exposes the built-in Research + Compliance servers to the planner by default (#1196 / #1005)", () => {
    const names = resolveAllInstalledMcp([]).map(e => e.name);
    expect(names).toContain("Research");
    expect(names).toContain("Compliance");
  });

  it("exposes the disabled bundled channel to the planner/director so it can be assigned (#3146)", () => {
    const names = resolveAllInstalledMcp([]).map(e => e.name);
    expect(names).toContain("Channel (mock)"); // disabled, but installed + runnable → assignable
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

// Guard for the externalized catalog templates (@data/mcp/catalog-templates.json, #2419).
describe("catalog template registry (loaded from @data/mcp/catalog-templates.json)", () => {
  it("every template yields a RUNNABLE config through mcpFromCatalog (stdio ⇒ command, http ⇒ url)", () => {
    for (const [name, t] of Object.entries(catalogTemplates)) {
      const s = mcpFromCatalog(name);
      expect(s.name).toBe(name);
      expect(["stdio", "http"]).toContain(s.transport);
      if (s.transport === "http") expect(s.url).toMatch(/^https:\/\//);
      else expect(s.command).toBeTruthy();
      expect(s.transport).toBe(t.transport); // the template's config rode through unchanged
    }
  });

  it("keeps the well-known entries the planner's <mcp_assign> resolves by name", () => {
    for (const name of ["Compliance", "Research", "Postgres", "Slack", "Sentry", "Linear", "Notion"]) {
      expect(catalogTemplates).toHaveProperty(name);
    }
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
