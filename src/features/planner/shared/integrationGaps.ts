// Integration gap detection (#1200) — scan the forming plan for the integrations it implies
// (MCP servers, native source connectors, and the credentials those need), and classify each as
// already wired (`assigned`), one-click resolvable (`available`), or needing setup (`missing`).
// Pure (no React/Tauri) so the detect+classify logic is unit-testable; the focused pane renders the
// result and offers the in-session add path. Heuristic + idempotent — re-running over the same plan
// yields the same set, and an integration already in play never re-appears as a gap.

import type { McpServer } from "@/features/extensions/lib/mcpServers";
import { resolveMcpServers, mcpFromCatalog } from "@/features/extensions/lib/mcpServers";
import { CONNECTORS, connector, type DeclaredSource } from "./sourceConfig";
import { parseMcpAssigns } from "./planExtensions";

export type IntegrationKind = "mcp" | "connector" | "credential";
export type IntegrationStatus = "assigned" | "available" | "missing";
/** The single in-session affordance that resolves a gap. Absent ⇒ already assigned (nothing to do). */
export type IntegrationAction = "assign" | "declare" | "install" | "credential";

export interface ImpliedIntegration {
  /** Stable de-dupe key, e.g. `mcp:Stripe` / `connector:salesforce` / `credential:<uid>`. */
  key: string;
  kind: IntegrationKind;
  /** Server name | connector id | source uid — what the action operates on. */
  ref: string;
  label: string;
  /** Why the plan implies it (the matched signal), for the surfaced explanation. */
  reason: string;
  status: IntegrationStatus;
  detail: string;
  action?: IntegrationAction;
}

export interface IntegrationGapInput {
  /** Joined plan section text to scan (stack / features / architecture / …). */
  text: string;
  /** Declared sources from the project's source config. */
  sources: DeclaredSource[];
  /** The global MCP server list (scoped per-project via `projects`). */
  mcpServers: McpServer[];
  projectId: string;
}

export interface IntegrationGaps {
  items: ImpliedIntegration[];
  total: number;
  assigned: number;
  available: number;
  missing: number;
  /** Every implied integration is wired — nothing is `available`/`missing`. */
  ready: boolean;
}

interface Rule {
  re: RegExp;
  ref: string;
  label: string;
  reason: string;
}

// Stack/feature keywords → the MCP server they imply. Each `ref` is a catalog template name so the
// match is one-click resolvable (see `mcpFromCatalog`).
const MCP_RULES: Rule[] = [
  { re: /\bpostgres(ql)?\b/i, ref: "Postgres", label: "Postgres MCP", reason: "the stack uses PostgreSQL" },
  { re: /\bsqlite\b/i, ref: "SQLite", label: "SQLite MCP", reason: "the stack uses SQLite" },
  { re: /\b(stripe|billing|payments?|subscriptions?)\b/i, ref: "Stripe", label: "Stripe MCP", reason: "the plan involves billing/payments" },
  { re: /\bslack\b/i, ref: "Slack", label: "Slack MCP", reason: "the plan integrates Slack" },
  { re: /\b(sentry|error[ -]tracking)\b/i, ref: "Sentry", label: "Sentry MCP", reason: "the plan uses Sentry" },
  { re: /\blinear\b/i, ref: "Linear", label: "Linear MCP", reason: "the plan uses Linear" },
  { re: /\bnotion\b/i, ref: "Notion", label: "Notion MCP", reason: "the plan uses Notion" },
  { re: /\b(compliance|gdpr|hipaa|soc ?2|iso ?27001|pci( dss)?)\b/i, ref: "Compliance", label: "Compliance MCP", reason: "the plan has regulatory/compliance requirements" },
  { re: /\b(arxiv|pubmed|semantic scholar|scientific literature)\b/i, ref: "Research", label: "Research MCP", reason: "the plan needs scientific-literature research" },
];

// Enterprise-system keywords → the source connector they imply. Each `ref` is a built-in connector id.
const CONNECTOR_RULES: Rule[] = [
  { re: /\bsalesforce\b/i, ref: "salesforce", label: "Salesforce", reason: "the plan reads from Salesforce" },
  { re: /\b(quickbooks|intuit)\b/i, ref: "quickbooks", label: "QuickBooks", reason: "the plan reads from QuickBooks" },
  { re: /\bhubspot\b/i, ref: "hubspot", label: "HubSpot", reason: "the plan reads from HubSpot" },
  { re: /\bmonday(\.com)?\b/i, ref: "monday", label: "monday.com", reason: "the plan reads from monday.com" },
  { re: /\bquickbase\b/i, ref: "quickbase", label: "Quickbase", reason: "the plan reads from Quickbase" },
  { re: /\bnetsuite\b/i, ref: "netsuite", label: "NetSuite", reason: "the plan reads from NetSuite" },
  { re: /\bdynamics( ?365)?\b/i, ref: "dynamics365", label: "Dynamics 365", reason: "the plan reads from Dynamics 365" },
  { re: /\bsap\b/i, ref: "sap-odata", label: "SAP OData", reason: "the plan reads from SAP" },
];

const CONNECTOR_IDS = new Set(CONNECTORS.map((c) => c.id));

/** Is this MCP server name something the app can resolve to a runnable config in one click? */
function mcpResolvable(name: string): boolean {
  const d = mcpFromCatalog(name);
  return !!(d.command || d.url);
}

/** A source is connected (secret saved to the keychain) once it is scanning or scanned. */
function connected(s: DeclaredSource): boolean {
  return s.status === "scanning" || s.status === "scanned";
}

/** Detect + classify the integrations the forming plan implies. */
export function integrationGaps(input: IntegrationGapInput): IntegrationGaps {
  const { text, sources, mcpServers, projectId } = input;
  const items: ImpliedIntegration[] = [];
  const seen = new Set<string>();
  const push = (it: ImpliedIntegration) => {
    if (!seen.has(it.key)) {
      seen.add(it.key);
      items.push(it);
    }
  };

  // 1. MCP servers — keyword matches in the plan text + any explicit <mcp_assign> the planner wrote.
  const mcpNeeds = new Map<string, { label: string; reason: string }>();
  for (const r of MCP_RULES) {
    if (r.re.test(text)) mcpNeeds.set(r.ref, { label: r.label, reason: r.reason });
  }
  for (const name of parseMcpAssigns(text)) {
    if (!mcpNeeds.has(name)) mcpNeeds.set(name, { label: name, reason: "the plan assigns this server" });
  }
  const scoped = resolveMcpServers(mcpServers, projectId);
  for (const [name, { label, reason }] of mcpNeeds) {
    const isAssigned = scoped.some((s) => s.name.toLowerCase() === name.toLowerCase());
    const resolvable = mcpResolvable(name);
    const status: IntegrationStatus = isAssigned ? "assigned" : resolvable ? "available" : "missing";
    push({
      key: `mcp:${name}`,
      kind: "mcp",
      ref: name,
      label,
      reason,
      status,
      detail: isAssigned ? "assigned to this project" : resolvable ? "one-click assign" : "add a custom MCP server in the MCP stage",
      action: isAssigned ? undefined : resolvable ? "assign" : "install",
    });
  }

  // 2. Source connectors — keyword matches mapped to the connector catalog.
  const declaredIds = new Set(sources.map((s) => s.connectorId));
  for (const r of CONNECTOR_RULES) {
    if (!r.re.test(text)) continue;
    const isAssigned = declaredIds.has(r.ref);
    push({
      key: `connector:${r.ref}`,
      kind: "connector",
      ref: r.ref,
      label: r.label,
      reason: r.reason,
      status: isAssigned ? "assigned" : "available",
      detail: isAssigned ? "declared as a source" : "add it in the Source stage",
      action: isAssigned ? undefined : "declare",
    });
  }

  // 3. Credentials — a declared source that needs a secret it doesn't have yet (installed-but-
  //    unconfigured counts as missing, per the acceptance criteria).
  for (const s of sources) {
    const spec = connector(s.connectorId).spec;
    const needsSecret = spec.fields.some((f) => f.secret) || ["token", "password", "basic", "apiKey"].includes(spec.auth);
    if (needsSecret && !s.secretSaved && !connected(s)) {
      const name = connector(s.connectorId).name;
      push({
        key: `credential:${s.uid}`,
        kind: "credential",
        ref: s.uid,
        label: `${name} credential`,
        reason: `${name} is declared but not yet authorized`,
        status: "missing",
        detail: "enter the credential in the Source stage (stored on-device)",
        action: "credential",
      });
    }
  }

  const assigned = items.filter((i) => i.status === "assigned").length;
  const available = items.filter((i) => i.status === "available").length;
  const missing = items.filter((i) => i.status === "missing").length;
  return { items, total: items.length, assigned, available, missing, ready: available + missing === 0 };
}

/** Whether a connector id is a built-in (vs an authored runtime preset / unknown). */
export function isBuiltinConnector(id: string): boolean {
  return CONNECTOR_IDS.has(id);
}
