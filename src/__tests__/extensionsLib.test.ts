import { describe, it, expect } from "vitest";
import {
  resolveExtensions, toMcpPayload, toHookPayload, toSessionPayloads,
  defFromCatalog, blankExtension, type ExtensionDef,
} from "../lib/extensions";
import { EXT_CATALOG } from "../data/extensions";

// Helper: a minimal enabled MCP def; `name` defaults to the id for readable asserts.
const mk = (over: Partial<ExtensionDef>): ExtensionDef => ({
  id: "e", kind: "mcp", name: over.id ?? "e", enabled: true, projects: [], ...over,
});

describe("resolveExtensions", () => {
  it("includes enabled globals + this-project matches; drops disabled and other projects", () => {
    const all = [
      mk({ id: "g", projects: [] }),
      mk({ id: "p", projects: ["P1"] }),
      mk({ id: "q", projects: ["P2"] }),
      mk({ id: "off", projects: [], enabled: false }),
    ];
    expect(resolveExtensions(all, "P1").map(e => e.id)).toEqual(["g", "p"]);
    expect(resolveExtensions(all, "P2").map(e => e.id)).toEqual(["g", "q"]);
    // No project (ad-hoc console) → globals only.
    expect(resolveExtensions(all, "").map(e => e.id)).toEqual(["g"]);
  });
});

describe("payload conversion", () => {
  it("stdio mcp → command + split args; http → url; env defaults to []", () => {
    expect(toMcpPayload(mk({ transport: "stdio", command: "npx", args: "-y pkg" })))
      .toEqual({ name: "e", transport: "stdio", command: "npx", args: ["-y", "pkg"], env: [] });
    expect(toMcpPayload(mk({ transport: "http", url: "https://h/sse" })))
      .toEqual({ name: "e", transport: "http", args: [], url: "https://h/sse", env: [] });
  });

  it("returns null for incomplete defs", () => {
    expect(toMcpPayload(mk({ transport: "stdio", command: "" }))).toBeNull();
    expect(toMcpPayload(mk({ transport: "http", url: "" }))).toBeNull();
    expect(toMcpPayload(mk({ kind: "hook" }))).toBeNull();
    expect(toHookPayload(mk({ kind: "hook", name: "fmt-hook", event: "PostToolUse", matcher: "Write", hookCommand: "fmt" })))
      .toEqual({ event: "PostToolUse", matcher: "Write", command: "bsc-hook 'fmt-hook' 'fmt'" });
    expect(toHookPayload(mk({ kind: "hook", event: "PostToolUse", hookCommand: "" }))).toBeNull();
  });

  it("toHookPayload single-quote-escapes the name and command", () => {
    expect(toHookPayload(mk({ kind: "hook", name: "it's a hook", event: "PreToolUse", hookCommand: "echo 'hi'" })))
      .toEqual({ event: "PreToolUse", matcher: "", command: "bsc-hook 'it'\\''s a hook' 'echo '\\''hi'\\'''" });
  });

  it("toSessionPayloads splits mcp vs hook and drops incomplete", () => {
    const { mcp, hooks } = toSessionPayloads([
      mk({ id: "a", transport: "stdio", command: "npx", args: "p" }),
      mk({ id: "b", kind: "hook", event: "Stop", hookCommand: "x" }),
      mk({ id: "c", transport: "stdio", command: "" }),
    ]);
    expect(mcp.map(m => m.name)).toEqual(["a"]);
    expect(hooks.map(h => h.event)).toEqual(["Stop"]);
  });
});

describe("catalog templates + blanks", () => {
  it("fills a known stdio MCP template, disabled + global", () => {
    const d = defFromCatalog("Postgres");
    expect(d).toMatchObject({ kind: "mcp", transport: "stdio", command: "npx", enabled: false, projects: [], name: "Postgres" });
    expect(d.args).toContain("server-postgres");
  });

  it("maps a hook catalog item, and falls back to a blank stdio mcp for unknowns", () => {
    expect(defFromCatalog("Block PII")).toMatchObject({ kind: "hook", event: "PreToolUse" });
    expect(defFromCatalog("Nope")).toMatchObject({ kind: "mcp", transport: "stdio", command: "", name: "Nope" });
  });

  it("includes the first-party MCP servers with download links + run configs (#858)", () => {
    const firstParty = ["Compliance", "Complexity Analyzer", "Dependency Graph"];
    for (const name of firstParty) {
      const item = EXT_CATALOG.find((c) => c.name === name);
      expect(item, `${name} in catalog`).toBeDefined();
      // Each carries a GitHub download link + a setup hint (they install from source, not npm).
      expect(item!.link).toMatch(/^https:\/\/github\.com\/kevinthelago\//);
      expect(item!.install).toBeTruthy();
    }
    // "add" produces a stdio MCP config whose args carry the {dir} placeholder, substituted
    // with the on-disk download path (~/.base-studio-code/mcp/<repo>) when added.
    expect(defFromCatalog("Compliance")).toMatchObject({ kind: "mcp", transport: "stdio", command: "python", args: "-m uv run --directory {dir} compliance-mcp" });
    expect(defFromCatalog("Complexity Analyzer")).toMatchObject({ command: "node", args: "{dir}/dist/mcp/index.js" });
    expect(defFromCatalog("Dependency Graph")).toMatchObject({ command: "node", args: "{dir}/dist/index.js" });
  });

  it("blankExtension produces empty mcp/hook shapes", () => {
    expect(blankExtension("mcp")).toMatchObject({ kind: "mcp", transport: "stdio", enabled: false, projects: [] });
    expect(blankExtension("hook")).toMatchObject({ kind: "hook", event: "PostToolUse", enabled: false, projects: [] });
  });
});
