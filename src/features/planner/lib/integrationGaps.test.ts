import { describe, it, expect } from "vitest";
import { integrationGaps } from "./integrationGaps";
import { BUILTIN_MCP_SERVERS, type McpServer } from "@/features/mcp/lib/mcpServers";
import type { DeclaredSource } from "./sourceConfig";

// The always-on built-in MCP servers (Research + Compliance, #1196) are global + enabled by
// construction, so `resolveMcpServers` returns them for every project and they always classify as
// `assigned`. Any count assertion has to account for them.
// The GLOBAL built-ins — the ones every session gets. Count only the ENABLED ones: a disabled
// built-in (the per-stream mock channel, #3146/#3777) is catalog-present but reaches a session
// only by explicit stream assignment, so `resolveMcpServers` never auto-assigns it here.
const BUILTINS = BUILTIN_MCP_SERVERS.filter((s) => s.enabled).length;

const mcp = (name: string, over: Partial<McpServer> = {}): McpServer => ({
  id: name, name, enabled: true, projects: [], transport: "stdio", command: "x", args: "", ...over,
});
const src = (connectorId: string, over: Partial<DeclaredSource> = {}): DeclaredSource => ({
  uid: `u-${connectorId}`, connectorId, status: "declared", fields: {}, ...over,
});

const base = { sources: [] as DeclaredSource[], mcpServers: [] as McpServer[], projectId: "p1" };

describe("integrationGaps — detect", () => {
  it("infers an MCP server from a stack keyword and marks it available (resolvable, unassigned)", () => {
    const g = integrationGaps({ ...base, text: "Backend on PostgreSQL with billing via Stripe." });
    const byRef = Object.fromEntries(g.items.map((i) => [i.ref, i]));
    expect(byRef.Postgres.kind).toBe("mcp");
    expect(byRef.Postgres.status).toBe("available");
    expect(byRef.Postgres.action).toBe("assign");
    expect(byRef.Stripe.status).toBe("available"); // billing → Stripe
  });

  it("no longer implies a built-in source connector from a keyword (#1976 — connectors are agent-authored)", () => {
    const g = integrationGaps({ ...base, text: "Pull customers from Salesforce and invoices from QuickBooks." });
    expect(g.items.some((i) => i.kind === "connector")).toBe(false);
  });

  it("classifies an explicitly-assigned server (via the mcpServers array) as assigned, even with an unknown, non-catalog name", () => {
    // MCP assignment is no longer a `<mcp_assign>` text tag (#tag-parse-migration): the planner records
    // it with `bsc plan mcp add`, which the plan.db poll resolves into the `mcpServers` array. A server
    // scoped + enabled for the project is `assigned` regardless of whether it has a catalog template.
    const g = integrationGaps({ ...base, text: "Tools needed.", mcpServers: [mcp("Acme Private", { projects: ["p1"] })] });
    const it0 = g.items.find((i) => i.ref === "Acme Private")!;
    expect(it0.status).toBe("assigned");
    expect(it0.action).toBeUndefined();
  });
});

describe("integrationGaps — classify", () => {
  it("an MCP server scoped + enabled for the project is assigned (no action)", () => {
    const g = integrationGaps({ ...base, text: "Uses Stripe for payments.", mcpServers: [mcp("Stripe", { projects: ["p1"] })] });
    const stripe = g.items.find((i) => i.ref === "Stripe")!;
    expect(stripe.status).toBe("assigned");
    expect(stripe.action).toBeUndefined();
  });

  it("a global (unscoped) enabled server also counts as assigned", () => {
    const g = integrationGaps({ ...base, text: "Notion docs.", mcpServers: [mcp("Notion", { projects: [] })] });
    expect(g.items.find((i) => i.ref === "Notion")!.status).toBe("assigned");
  });
});

describe("integrationGaps — credentials", () => {
  it("flags a declared, unauthorized secret-requiring source as a missing credential", () => {
    const g = integrationGaps({ ...base, text: "", sources: [src("quickbase")] });
    const cred = g.items.find((i) => i.kind === "credential")!;
    expect(cred.ref).toBe("u-quickbase");
    expect(cred.status).toBe("missing");
    expect(cred.action).toBe("credential");
  });

  it("does not flag a credential once the source is connected (secret saved on-device)", () => {
    const g = integrationGaps({ ...base, text: "", sources: [src("quickbase", { status: "scanned", secretSaved: true })] });
    expect(g.items.some((i) => i.kind === "credential")).toBe(false);
  });
});

describe("integrationGaps — summary", () => {
  it("counts + ready reflect the mix, and items dedupe by key", () => {
    const g = integrationGaps({
      text: "Postgres database. Salesforce CRM. Stripe billing. Postgres again.", // Postgres mentioned twice
      // The salesforce source is scanned (no credential gap); connectors no longer imply a gap (#1976).
      sources: [src("salesforce", { status: "scanned", secretSaved: true })],
      mcpServers: [mcp("Stripe", { projects: ["p1"] })], // Stripe assigned
      projectId: "p1",
    });
    expect(g.items.filter((i) => i.ref === "Postgres")).toHaveLength(1); // deduped
    expect(g.assigned).toBe(1 + BUILTINS); // Stripe + the always-on built-ins
    expect(g.available).toBe(1); // Postgres
    expect(g.ready).toBe(false); // Postgres is available (unassigned)
    expect(g.total).toBe(g.assigned + g.available + g.missing);
  });

  it("an empty plan implies only the always-on built-ins and is ready", () => {
    const g = integrationGaps({ ...base, text: "" });
    expect(g.total).toBe(BUILTINS); // just Research + Compliance, both assigned
    expect(g.assigned).toBe(BUILTINS);
    expect(g.ready).toBe(true); // nothing available/missing
  });
});
