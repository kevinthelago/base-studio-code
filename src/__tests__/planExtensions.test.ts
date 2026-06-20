import { describe, it, expect } from "vitest";
import {
  parseMcpAssigns,
  stripMcpAssigns,
  mcpAssignToExtension,
  applyMcpAssign,
  isDownloadableMcp,
  type ExtensionStoreLike,
} from "../screens/planner/planExtensions";
import type { ExtensionDef } from "../lib/extensions";

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

describe("mcpAssignToExtension", () => {
  it("derives an enabled, project-scoped catalog extension with blank secret env", () => {
    const def = mcpAssignToExtension("Postgres", "proj-1");
    expect(def).toMatchObject({ kind: "mcp", name: "Postgres", enabled: true, projects: ["proj-1"], command: "npx" });
    // secrets are never invented — the connection string stays blank for the user
    expect(def.env).toEqual([["POSTGRES_CONNECTION_STRING", ""]]);
  });

  it("an empty projectId yields a global (unscoped) extension", () => {
    expect(mcpAssignToExtension("Sentry", "").projects).toEqual([]);
  });

  it("resolves {dir} to the on-disk install path for a downloadable first-party server", () => {
    const def = mcpAssignToExtension("Compliance", "p1", "/home/u/.base-studio-code");
    expect(def.command).toBe("python"); // `python -m uv …` — no PATH dependency (#887)
    // The literal {dir} placeholder must NOT survive into a launched config (#876).
    expect(def.args).not.toContain("{dir}");
    expect(def.args).toContain("/home/u/.base-studio-code/mcp/compliance-mcp-server");
    expect(def).toMatchObject({ enabled: true, projects: ["p1"] });
  });

  it("keeps {dir} when no baseDir is supplied (resolved later, never throws)", () => {
    expect(mcpAssignToExtension("Compliance", "p1").args).toContain("{dir}");
  });
});

describe("isDownloadableMcp", () => {
  it("is true for the first-party catalog servers, false for others", () => {
    expect(isDownloadableMcp("Compliance")).toBe(true);
    expect(isDownloadableMcp("Complexity Analyzer")).toBe(true);
    expect(isDownloadableMcp("Dependency Graph")).toBe(true);
    expect(isDownloadableMcp("Postgres")).toBe(false); // pruned from the browse catalog
    expect(isDownloadableMcp("Nope")).toBe(false);
  });
});

describe("applyMcpAssign", () => {
  const makeStore = (initial: ExtensionDef[] = []): ExtensionStoreLike & { extensions: ExtensionDef[] } => {
    const store = {
      extensions: [...initial],
      addExtension(def: Omit<ExtensionDef, "id">) {
        store.extensions.push({ ...def, id: `ext_${store.extensions.length}` });
      },
      updateExtension(id: string, patch: Partial<ExtensionDef>) {
        store.extensions = store.extensions.map((e) => (e.id === id ? { ...e, ...patch } : e));
      },
    };
    return store;
  };

  it("adds a fresh catalog extension when none exists", () => {
    const store = makeStore();
    expect(applyMcpAssign(store, "Postgres", "p1")).toBe(true);
    expect(store.extensions).toHaveLength(1);
    expect(store.extensions[0]).toMatchObject({ name: "Postgres", enabled: true, projects: ["p1"] });
  });

  it("is idempotent: re-assigning the same name enables it + scopes the project without duplicating", () => {
    const store = makeStore();
    applyMcpAssign(store, "Postgres", "p1");
    expect(applyMcpAssign(store, "postgres", "p1")).toBe(false); // case-insensitive match, no add
    applyMcpAssign(store, "Postgres", "p2");                     // a second project scopes in
    expect(store.extensions).toHaveLength(1);
    expect(store.extensions[0].projects).toEqual(["p1", "p2"]);
  });

  it("leaves a global extension global (does not narrow projects: [])", () => {
    const store = makeStore([
      { id: "g", kind: "mcp", name: "Sentry", enabled: false, projects: [], transport: "http", url: "https://x" },
    ]);
    applyMcpAssign(store, "Sentry", "p1");
    expect(store.extensions[0]).toMatchObject({ enabled: true, projects: [] });
  });
});
