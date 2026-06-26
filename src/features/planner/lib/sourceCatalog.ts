// Migration SOURCE catalog (#source-pane) — the connector catalog and resolution behind the
// planner's Source stage: the first-party connectors, the packaged vendor presets (#1288), the
// per-connector resolver/colors, the sample scan inventory, the pitch→proposal keyword scan, and the
// redacted handle the planner is allowed to see. Split out of sourceConfig.ts (#1638); the type
// model lives in sourceSpecs.ts and the gate/derivation helpers in sourceGate.ts /
// dataModelDerivation.ts / sourceScanViews.ts.

import type {
  ConnectionSpec, Connector, ConnectorCatalogEntry, DeclaredSource, DiscoveredObject, SourceBehavior,
} from "./sourceSpecs";

/** Build a Source-pane {@link Connector} from a backend preset entry (#1288): a generic-REST
 *  connector declared with a base URL + bearer token, described by what the preset pulls. */
export function presetToConnector(e: ConnectorCatalogEntry): Connector {
  const badge = e.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "··";
  return {
    id: e.id,
    name: e.name,
    badge,
    authLabel: "token",
    category: e.category,
    preset: true,
    spec: {
      auth: "token",
      fields: [
        { key: "baseUrl", label: "base URL", placeholder: "https://api.vendor.com" },
        { key: "token", label: "API token", secret: true },
      ],
      contributes: e.contributes || "resources discovered from the API",
    },
  };
}

const oauth = (label: string, contributes: string, envs = true): ConnectionSpec => ({ auth: "oauth", fields: [], oauthLabel: label, envs, contributes });

/** The connector catalog (#source-pane). Each declared source renders its own page from `spec`. */
export const CONNECTORS: Connector[] = [
  {
    id: "quickbooks", name: "QuickBooks", badge: "QB", authLabel: "OAuth",
    spec: oauth("Connect to QuickBooks", "Customers · Invoices · Items · Payments + recurring-invoice rules"),
  },
  {
    id: "quickbase", name: "Quickbase", badge: "Qk", authLabel: "token",
    spec: {
      auth: "token",
      fields: [
        { key: "realm", label: "realm hostname", placeholder: "acme.quickbase.com" },
        { key: "appId", label: "App ID / DBID", optional: true, hint: "scopes the scan", placeholder: "bqr2x4n8" },
        { key: "userToken", label: "User Token", secret: true },
      ],
      contributes: "Projects · Tickets · Vendors + form rules · Pipelines",
    },
  },
  {
    id: "salesforce", name: "Salesforce", badge: "SF", authLabel: "OAuth",
    spec: oauth("Connect to Salesforce", "objects + custom fields + validation rules · Flows / Process Builder · approval processes"),
  },
  {
    id: "hubspot", name: "HubSpot", badge: "HS", authLabel: "OAuth / token",
    spec: oauth("Connect to HubSpot", "Contacts · Companies · Deals · Tickets + workflows"),
  },
  {
    id: "monday", name: "monday.com", badge: "Mo", authLabel: "OAuth / token",
    spec: oauth("Connect to monday.com", "Boards · Items · Columns + automations"),
  },
  {
    id: "dynamics365", name: "Dynamics 365", badge: "Dy", authLabel: "OAuth",
    spec: oauth("Connect to Dynamics 365", "Accounts · Contacts · Opportunities + business rules"),
  },
  {
    id: "netsuite", name: "NetSuite", badge: "NS", authLabel: "token",
    spec: {
      auth: "token",
      fields: [
        { key: "accountId", label: "Account ID", placeholder: "1234567" },
        { key: "token", label: "Token-based auth secret", secret: true },
      ],
      contributes: "Customers · Transactions · Items + saved searches",
    },
  },
  {
    id: "sap-odata", name: "SAP OData", badge: "SAP", authLabel: "basic / OAuth",
    spec: {
      auth: "basic",
      fields: [
        { key: "serviceUrl", label: "OData service URL", placeholder: "https://sap.acme.com/odata" },
        { key: "user", label: "User" },
        { key: "password", label: "Password", secret: true },
      ],
      contributes: "entity sets + associations",
    },
  },
  {
    id: "sql", name: "SQL database", badge: "SQL", authLabel: "password",
    spec: {
      auth: "password",
      fields: [
        { key: "host", label: "host", placeholder: "db.acme.com:5432" },
        { key: "database", label: "database", placeholder: "production" },
        { key: "user", label: "user" },
        { key: "password", label: "password", secret: true },
      ],
      contributes: "tables + foreign keys + views",
    },
  },
  {
    id: "rest", name: "REST / OpenAPI", badge: "{ }", authLabel: "API key",
    spec: {
      auth: "apiKey",
      fields: [
        { key: "baseUrl", label: "base URL", placeholder: "https://api.acme.com" },
        { key: "apiKey", label: "API key", secret: true },
      ],
      contributes: "resources discovered from the OpenAPI spec",
    },
  },
  {
    id: "fhir", name: "HL7 FHIR (R4)", badge: "FH", authLabel: "open / SMART",
    spec: {
      auth: "open",
      fields: [
        { key: "baseUrl", label: "FHIR base URL", placeholder: "https://hapi.fhir.org/baseR4" },
      ],
      contributes: "patients, encounters, observations/labs, conditions, medications, procedures, reports",
    },
  },
  {
    id: "csv", name: "CSV export", badge: "CSV", authLabel: "upload",
    spec: { auth: "upload", fields: [], contributes: "columns inferred from the file" },
  },
];

/** Look up a connector by id, with a safe fallback so an unknown id still renders. */
/** Runtime registry of packaged vendor presets loaded from the backend catalog (#1288). Lets the
 *  static {@link connector} resolver return a declared preset's connect spec (base URL + token)
 *  everywhere — the preset list isn't known at module load (it comes from `data_connector_catalog`). */
const PRESET_REGISTRY = new Map<string, Connector>();

/** Register the loaded preset connectors so {@link connector} can resolve their specs (#1288). */
export function registerPresetConnectors(list: Connector[]): void {
  for (const c of list) PRESET_REGISTRY.set(c.id, c);
}

export function connector(id: string): Connector {
  return CONNECTORS.find((c) => c.id === id) ?? PRESET_REGISTRY.get(id) ?? {
    id, name: id, badge: id.slice(0, 2).toUpperCase(), authLabel: "custom",
    spec: { auth: "token", fields: [], contributes: "—" },
  };
}

// ── Scan visualizations (#1209) — per-source accent color ─────────────────────────────────────

/** A per-source accent color for multi-source provenance (matches the design's SF/QB/QBO mapping). */
export function connectorColor(connectorId: string): string {
  const map: Record<string, string> = {
    salesforce: "var(--info)", quickbase: "var(--accent)", quickbooks: "var(--success)",
    hubspot: "var(--violet)", monday: "var(--accent)", dynamics365: "var(--info)",
    netsuite: "var(--success)", "sap-odata": "var(--info)", sql: "var(--accent)",
  };
  if (map[connectorId]) return map[connectorId];
  const palette = ["var(--info)", "var(--accent)", "var(--success)", "var(--violet)"];
  let h = 0;
  for (const c of connectorId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// ── Sample scan (#source-pane) — the discovered inventory a connect surfaces. Until the native
//    read-only connectors land (separate backend work), the hi-fi pane uses these per-connector
//    samples so every state is demonstrable; the SHAPE is what a real scan returns. ──────────────
const SAMPLE_SCANS: Record<string, { objects: DiscoveredObject[]; behaviors: SourceBehavior[] }> = {
  quickbooks: {
    objects: [{ name: "Customers", count: 2940 }, { name: "Invoices", count: 18220 }, { name: "Items", count: 430 }, { name: "Payments", count: 12118 }],
    behaviors: [{ label: "recurring-invoice rule" }],
  },
  quickbase: {
    objects: [{ name: "Projects", count: 1204 }, { name: "Tickets", count: 8991 }, { name: "Vendors", count: 310 }],
    behaviors: [{ label: "2 form rules" }, { label: "1 Pipeline (auto-assign)" }],
  },
  salesforce: {
    objects: [{ name: "Accounts", count: 3120 }, { name: "Contacts", count: 9840 }, { name: "Opportunities", count: 2210 }],
    behaviors: [{ label: "validation rules" }, { label: "Flows / Process Builder" }],
  },
};

/** The inventory a scan of `connectorId` discovers (sample data, see above). */
export function sampleScan(connectorId: string): { objects: DiscoveredObject[]; behaviors: SourceBehavior[] } {
  return SAMPLE_SCANS[connectorId] ?? {
    objects: [{ name: "Records", count: 0 }],
    behaviors: [],
  };
}

// ── Propose sources from the pitch (#1349) ───────────────────────────────────────────────────────
// The Source stage's "Confirm N sources" banner is seeded from the planner's pitch BEFORE any live
// `<source_config>` tag arrives: a keyword scan over the pitch prose maps mentioned legacy systems to
// catalog connector ids. This makes the stage open with the user CONFIRMING the obvious migration
// sources rather than hunting the catalog. The match is conservative (word-boundary aliases) so an
// unrelated mention doesn't propose a source; the user can always edit the selection or add more.

/** Per-connector aliases matched (case-insensitive, word-boundary) against the pitch prose. */
const PITCH_ALIASES: Record<string, string[]> = {
  quickbooks: ["quickbooks", "qbo", "quick books"],
  quickbase: ["quickbase", "quick base"],
  salesforce: ["salesforce", "sfdc"],
  hubspot: ["hubspot", "hub spot"],
  monday: ["monday.com", "monday com", "monday"],
  dynamics365: ["dynamics 365", "dynamics365", "dynamics", "d365"],
  netsuite: ["netsuite", "net suite"],
  "sap-odata": ["sap odata", "sap"],
  sql: ["postgres", "postgresql", "mysql", "mariadb", "sql server", "sqlserver", "oracle db", "sql database"],
  rest: ["openapi", "swagger", "rest api"],
  csv: ["csv export", "csv file", "spreadsheet export"],
};

/** Escape a literal alias for use inside a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Connector ids to propose from a planner pitch: any catalog connector whose alias appears in the
 *  prose (word-boundary, case-insensitive), deduped and in catalog order. Empty for an empty/blank
 *  pitch or one that mentions no known system. */
export function proposeFromPitch(pitch: string | undefined): string[] {
  const text = (pitch ?? "").toLowerCase();
  if (!text.trim()) return [];
  const ids: string[] = [];
  for (const c of CONNECTORS) {
    const aliases = PITCH_ALIASES[c.id];
    if (!aliases) continue;
    const hit = aliases.some((a) => new RegExp(`(^|[^a-z0-9])${escapeRe(a)}([^a-z0-9]|$)`, "i").test(text));
    if (hit) ids.push(c.id);
  }
  return ids;
}

/** A redacted handle the planner may see for a connected source — instance + env, never a credential. */
export function redactedHandle(s: DeclaredSource): string {
  const c = connector(s.connectorId);
  const inst = s.instance || c.name;
  const env = s.env ? ` · ${s.env}` : "";
  return `${inst}${env} · held by app`;
}
