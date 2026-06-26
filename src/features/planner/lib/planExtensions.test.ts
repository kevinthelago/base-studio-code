import { describe, it, expect } from "vitest";
import {
  parseMcpAssigns,
  stripMcpAssigns,
  mcpAssignToServer,
  applyMcpAssign,
  isDownloadableMcp,
  type McpStoreLike,
} from "./planExtensions";
import type { McpServer } from "@/features/mcp/lib/mcpServers";

describe("parseMcpAssigns", () => {
  it("extracts catalog names, deduped and order-preserving, across straight/curly quotes", () => {
    const text = [
      'intro <mcp_assign name="Postgres" /> mid',
      "<mcp_assign name=“Sentry” />",
      '<mcp_assign name="Postgres" />',  // dup — dropped
      '<mcp_assign id="Linear" />',      // id alias
    ].join("\n");
    expect(parseMcpAssigns(text)).toEqual(["Postgres", "Sentry", "Linear"]);
  });

  it("skips a tag with no name and tolerates extra attributes", () => {
    expect(parseMcpAssigns('<mcp_assign foo="bar" />')).toEqual([]);
    expect(parseMcpAssigns('<mcp_assign name="Stripe" note="db" />')).toEqual(["Stripe"]);
  });
});

describe("stripMcpAssigns", () => {
  it("removes every assign tag and leaves surrounding text", () => {
    expect(stripMcpAssigns('a <mcp_assign name="Postgres" /> b <mcp_assign id="X" /> c')).toBe("a  b  c");
  });
});

describe("mcpAssignToServer", () => {
  it("derives an enabled, project-scoped catalog server with blank secret env", () => {
    const def = mcpAssignToServer("Postgres", "proj-1");
    expect(def).toMatchObject({ name: "Postgres", enabled: true, projects: ["proj-1"], command: "npx" });
    // secrets are never invented — the connection string stays blank for the user
    expect(def.env).toEqual([["POSTGRES_CONNECTION_STRING", ""]]);
  });

  it("an empty projectId yields a global (unscoped) server", () => {
    expect(mcpAssignToServer("Sentry", "").projects).toEqual([]);
  });

  it("resolves {dir} to the on-disk install path for a downloadable first-party server", () => {
    const def = mcpAssignToServer("Plan Grader", "p1", "/home/u/.base-studio-code");
    expect(def.command).toBe("python"); // `python -m uv …` — no PATH dependency (#887)
    // The literal {dir} placeholder must NOT survive into a launched config (#876).
    expect(def.args).not.toContain("{dir}");
    expect(def.args).toContain("/home/u/.base-studio-code/mcp/plan-grader-mcp-server");
    expect(def).toMatchObject({ enabled: true, projects: ["p1"] });
  });

  it("keeps {dir} when no baseDir is supplied (resolved later, never throws)", () => {
    expect(mcpAssignToServer("Plan Grader", "p1").args).toContain("{dir}");
  });
});

describe("isDownloadableMcp", () => {
  it("is true for the downloadable first-party catalog servers, false for built-in/others", () => {
    expect(isDownloadableMcp("Plan Grader")).toBe(true);
    expect(isDownloadableMcp("Complexity Analyzer")).toBe(true);
    expect(isDownloadableMcp("Dependency Graph")).toBe(true);
    expect(isDownloadableMcp("Compliance")).toBe(false); // built-in native server (#1005)
    expect(isDownloadableMcp("Research")).toBe(false);    // built-in native server (#1196)
    expect(isDownloadableMcp("Postgres")).toBe(false); // pruned from the browse catalog
    expect(isDownloadableMcp("Nope")).toBe(false);
  });
});

describe("applyMcpAssign", () => {
  const makeStore = (initial: McpServer[] = []): McpStoreLike & { mcpServers: McpServer[] } => {
    const store = {
      mcpServers: [...initial],
      addMcpServer(def: Omit<McpServer, "id">) {
        store.mcpServers.push({ ...def, id: `mcp_${store.mcpServers.length}` });
      },
      updateMcpServer(id: string, patch: Partial<McpServer>) {
        store.mcpServers = store.mcpServers.map((e) => (e.id === id ? { ...e, ...patch } : e));
      },
    };
    return store;
  };

  it("adds a fresh catalog server when none exists", () => {
    const store = makeStore();
    expect(applyMcpAssign(store, "Postgres", "p1")).toBe(true);
    expect(store.mcpServers).toHaveLength(1);
    expect(store.mcpServers[0]).toMatchObject({ name: "Postgres", enabled: true, projects: ["p1"] });
  });

  it("is idempotent: re-assigning the same name enables it + scopes the project without duplicating", () => {
    const store = makeStore();
    applyMcpAssign(store, "Postgres", "p1");
    expect(applyMcpAssign(store, "postgres", "p1")).toBe(false); // case-insensitive match, no add
    applyMcpAssign(store, "Postgres", "p2");                     // a second project scopes in
    expect(store.mcpServers).toHaveLength(1);
    expect(store.mcpServers[0].projects).toEqual(["p1", "p2"]);
  });

  it("leaves a global server global (does not narrow projects: [])", () => {
    const store = makeStore([
      { id: "g", name: "Sentry", enabled: false, projects: [], transport: "http", url: "https://x" },
    ]);
    applyMcpAssign(store, "Sentry", "p1");
    expect(store.mcpServers[0]).toMatchObject({ enabled: true, projects: [] });
  });
});
