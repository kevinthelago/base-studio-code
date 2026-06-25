import { describe, it, expect } from "vitest";
import { integrationGaps } from "./integrationGaps";
import type { McpServer } from "@/features/extensions/lib/mcpServers";
import type { DeclaredSource } from "./sourceConfig";

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

  it("infers a source connector from an enterprise-system keyword (available until declared)", () => {
    const g = integrationGaps({ ...base, text: "Pull customers from Salesforce and invoices from QuickBooks." });
    const byRef = Object.fromEntries(g.items.map((i) => [i.ref, i]));
    expect(byRef.salesforce.kind).toBe("connector");
    expect(byRef.salesforce.status).toBe("available");
    expect(byRef.salesforce.action).toBe("declare");
    expect(byRef.quickbooks.status).toBe("available");
  });

  it("picks up an explicit <mcp_assign>, and an unknown server name is missing (no template)", () => {
    const g = integrationGaps({ ...base, text: 'Tools: <mcp_assign name="Acme Private" />' });
    const it0 = g.items.find((i) => i.ref === "Acme Private")!;
    expect(it0.status).toBe("missing");
    expect(it0.action).toBe("install");
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

  it("a connector already declared as a source is assigned", () => {
    const g = integrationGaps({ ...base, text: "Read from HubSpot.", sources: [src("hubspot")] });
    expect(g.items.find((i) => i.ref === "hubspot")!.status).toBe("assigned");
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
      sources: [src("salesforce", { status: "scanned", secretSaved: true })], // salesforce now assigned
      mcpServers: [mcp("Stripe", { projects: ["p1"] })], // Stripe assigned
      projectId: "p1",
    });
    expect(g.items.filter((i) => i.ref === "Postgres")).toHaveLength(1); // deduped
    expect(g.assigned).toBe(2); // salesforce + Stripe
    expect(g.available).toBe(1); // Postgres
    expect(g.ready).toBe(false);
    expect(g.total).toBe(g.assigned + g.available + g.missing);
  });

  it("an empty plan implies nothing and is ready", () => {
    const g = integrationGaps({ ...base, text: "" });
    expect(g.total).toBe(0);
    expect(g.ready).toBe(true);
  });
});
