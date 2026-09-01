// Which MCP servers a session gets, captured from the LIVE TypeScript so the Rust resolution can be
// proved equal.
//
// Rust owns every part of this except the choice: the BUILT-INS are backend data
// (`src-tauri/data/mcp/builtin-servers.json`), `extensions/mcp.rs::write_mcp_json` writes the session's
// `.mcp.json` from an already-resolved list, and `crates/bsc-agent` parses `$BSC_AGENT_MCP` into that
// same `McpServerCfg`.
//
// THREE RULES, each a distinction someone had to argue for:
//   · AMBIENT — an ENABLED built-in reaches every session (the app's own capability).
//   · CARRIED — anything a persona names is included REGARDLESS of its enabled toggle, because carrying
//     is INTENT. That is what sends a DISABLED built-in to one persona instead of the whole fleet.
//   · a HALF-CONFIGURED entry is skipped, so a broken line never reaches a session's .mcp.json.
//
// ORDER IS LOAD-BEARING: built-ins come FIRST so the generated .mcp.json keeps a stable shape and its
// diff stays readable across launches.
//
//     UPDATE_FIXTURES=1 npx vitest run src/features/mcp/lib/mcpResolution.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolvePersonaMcp, toMcpPayload, toBscAgentMcp, BUILTIN_MCP_SERVERS } from "@/features/mcp/lib/mcpServers";
import { mcpReachableFrom } from "@/app/console/lib/sessionLaunch";
import type { McpServer } from "@/features/mcp";

const FIXTURE = join(process.cwd(), "src/features/mcp/lib/mcpResolution.fixtures.json");

const srv = (over: Partial<McpServer> & { id: string }): McpServer =>
  ({ name: over.id, transport: "stdio", command: "/bin/thing", args: "", env: [], enabled: true, ...over }) as McpServer;

/** Stored servers covering every shape the resolution distinguishes. */
const STORED: McpServer[] = [
  srv({ id: "s-enabled", name: "Stored Enabled" }),
  srv({ id: "s-disabled", name: "Stored Disabled", enabled: false }),
  srv({ id: "s-http", name: "Stored Http", transport: "http", url: "https://example/mcp", command: undefined }),
  srv({ id: "s-http-nourl", name: "Stored Http No Url", transport: "http", command: undefined }),
  srv({ id: "s-stdio-nocmd", name: "Stored Stdio No Command", command: undefined }),
  srv({ id: "s-args", name: "Stored With Args", args: "  --flag   value  " }),
  srv({ id: "s-env", name: "Stored With Env", env: [["K", "V"], ["K2", "V2"]] }),
];

type Case = { label: string; personaMcp?: string[]; sandboxed?: boolean };

const disabledBuiltin = BUILTIN_MCP_SERVERS.find((b) => !b.enabled)?.id;
const enabledBuiltin = BUILTIN_MCP_SERVERS.find((b) => b.enabled)?.id;

const SUBJECTS: Case[] = [
  { label: "no persona servers — ambient built-ins only" },
  { label: "a persona carries an ENABLED stored server", personaMcp: ["s-enabled"] },
  // CARRYING IS INTENT: a disabled server is included when named.
  { label: "a persona carries a DISABLED stored server — intent beats the toggle", personaMcp: ["s-disabled"] },
  { label: "a persona carries an http server", personaMcp: ["s-http"] },
  { label: "a persona carries a HALF-CONFIGURED http server — skipped", personaMcp: ["s-http-nourl"] },
  { label: "a persona carries a stdio server with NO command — skipped", personaMcp: ["s-stdio-nocmd"] },
  { label: "a persona carries several", personaMcp: ["s-enabled", "s-args", "s-env"] },
  { label: "a persona names an id that does not exist", personaMcp: ["nope"] },
  { label: "a persona carries the same id twice", personaMcp: ["s-enabled", "s-enabled"] },
  ...(disabledBuiltin ? [{ label: `a persona carries the DISABLED built-in ${disabledBuiltin}`, personaMcp: [disabledBuiltin] }] : []),
  ...(enabledBuiltin ? [{ label: `a persona carries an ALREADY-ambient built-in ${enabledBuiltin}`, personaMcp: [enabledBuiltin] }] : []),
  // The sandbox narrowing: built-ins are unreachable inside a namespace.
  { label: "SANDBOXED — built-ins are dropped", sandboxed: true },
  { label: "SANDBOXED with a carried stored server — it survives", personaMcp: ["s-enabled"], sandboxed: true },
];

describe("mcpResolution fixtures", () => {
  it("captures the resolution, the payloads and both narrowings", () => {
    const cases = SUBJECTS.map((c) => {
      const resolved = resolvePersonaMcp(STORED, c.personaMcp ?? []);
      const reachable = mcpReachableFrom(resolved, !!c.sandboxed);
      const payloads = reachable.map(toMcpPayload).filter((p): p is NonNullable<typeof p> => p !== null);
      return {
        label: c.label,
        personaMcp: c.personaMcp ?? [],
        sandboxed: !!c.sandboxed,
        resolvedIds: resolved.map((s) => s.id),
        reachableIds: reachable.map((s) => s.id),
        payloads,
        bscAgent: toBscAgentMcp(payloads),
      };
    });
    const next = {
      note: "GENERATED from @/features/mcp/lib/mcpServers + sessionLaunch mcpReachableFrom — do not hand-edit; see the .gen.test.ts",
      // The WHOLE server, not a summary: the resolution reads `command`/`url` through `toMcpPayload`,
      // so recording a subset made every built-in look half-configured to the Rust side. A fixture
      // proves only the fields it carries — the same trap that hid a dropped `harvestRoots`.
      builtins: BUILTIN_MCP_SERVERS.map((b) => ({ id: b.id, name: b.name, transport: b.transport, command: b.command ?? null, args: b.args ?? "", url: b.url ?? null, env: b.env ?? [], enabled: b.enabled })),
      stored: STORED.map((s) => ({ id: s.id, name: s.name, transport: s.transport, command: s.command ?? null, args: s.args ?? "", url: s.url ?? null, env: s.env ?? [], enabled: s.enabled })),
      cases,
    };

    if (process.env.UPDATE_FIXTURES) writeFileSync(FIXTURE, `${JSON.stringify(next, null, 2)}\n`);
    expect(existsSync(FIXTURE), `${FIXTURE} missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(next);
  });

  it("BUILT-INS COME FIRST — the order is what keeps a .mcp.json diff readable", () => {
    const ids = resolvePersonaMcp(STORED, ["s-enabled"]).map((s) => s.id);
    const builtinIds = new Set(BUILTIN_MCP_SERVERS.map((b) => b.id));
    const firstStored = ids.findIndex((i) => !builtinIds.has(i));
    const lastBuiltin = ids.map((i) => builtinIds.has(i)).lastIndexOf(true);
    if (firstStored >= 0 && lastBuiltin >= 0) expect(lastBuiltin).toBeLessThan(firstStored);
  });

  it("CARRYING IS INTENT: a disabled server is included when a persona names it", () => {
    expect(resolvePersonaMcp(STORED, []).map((s) => s.id), "not ambient").not.toContain("s-disabled");
    expect(resolvePersonaMcp(STORED, ["s-disabled"]).map((s) => s.id), "carried anyway").toContain("s-disabled");
  });

  it("a half-configured entry never reaches a session", () => {
    for (const id of ["s-http-nourl", "s-stdio-nocmd"]) {
      expect(resolvePersonaMcp(STORED, [id]).map((s) => s.id), `${id} is not runnable`).not.toContain(id);
    }
  });

  it("the bsc-agent payload is stdio-only — its client cannot speak http", () => {
    const payloads = resolvePersonaMcp(STORED, ["s-http", "s-enabled"]).map(toMcpPayload).filter((p): p is NonNullable<typeof p> => p !== null);
    expect(payloads.some((p) => p.transport === "http"), "the .mcp.json keeps it").toBe(true);
    expect(toBscAgentMcp(payloads).some((c) => c.name === "Stored Http"), "bsc-agent must not get it").toBe(false);
  });
});
