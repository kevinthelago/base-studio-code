// Migration SOURCE catalog (#source-pane) — connector resolution behind the planner's Source stage:
// the per-connector resolver/colors, the sample scan inventory, the pitch→proposal keyword scan, and
// the redacted handle the planner is allowed to see. Split out of sourceConfig.ts (#1638); the type
// model lives in sourceSpecs.ts and the gate/derivation helpers in sourceGate.ts /
// dataModelDerivation.ts / sourceScanViews.ts.
//
// The native pre-built connectors were removed (#1976): the agent authors every connector as a
// runtime REST preset (#1235), so there is no static `CONNECTORS` catalog. {@link connector}
// resolves any id to a generic fallback shape so a declared runtime source still renders.

import type { Connector, DeclaredSource, DiscoveredObject, SourceBehavior } from "./sourceSpecs";

/** One agent-authored runtime connector as the backend surfaces it (#1980) — the live, app-wide
 *  list the Source pane polls (`data_runtime_connectors`). Mirrors the Rust `RuntimeConnectorView`
 *  (serde camelCase). Metadata only; the secret + resources stay backend-side. */
export interface RuntimeConnectorView {
  id: string;
  label: string;
  category: string;
  /** Declared auth method — one of `oauth` / `token` / `apikey` / `basic` (`RUNTIME_AUTH_KINDS`). */
  auth: string;
}

/** Human auth blurb for a runtime connector's declared auth method (the {@link Connector.authLabel}). */
const RUNTIME_AUTH_LABEL: Record<string, string> = {
  oauth: "OAuth", token: "token", apikey: "API key", basic: "Basic auth",
};

/** Resolve a connector by id (#1980). When `runtime` carries an agent-authored connector with that
 *  id, its real `label` / `auth` / `category` are used; otherwise — and for an unknown id — a generic
 *  fallback shape so any declared source still renders. Both keep the simple token form (no fields ⇒
 *  a one-click connect + sample scan); the full per-auth connect form is Phase 5b. */
export function connector(id: string, runtime?: readonly RuntimeConnectorView[]): Connector {
  const rt = runtime?.find((r) => r.id === id);
  if (rt) {
    const name = rt.label || id;
    return {
      id, name, badge: name.slice(0, 2).toUpperCase(),
      authLabel: RUNTIME_AUTH_LABEL[rt.auth] ?? rt.auth ?? "custom",
      category: rt.category || undefined,
      spec: { auth: "token", fields: [], contributes: "—" },
    };
  }
  return {
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
// connector ids. This makes the stage open with the user CONFIRMING the obvious migration
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

/** Connector ids to propose from a planner pitch: any id whose alias appears in the prose
 *  (word-boundary, case-insensitive), deduped and in {@link PITCH_ALIASES} order. With the static
 *  catalog gone (#1976) the alias table is the source of proposable ids. Empty for an empty/blank
 *  pitch or one that mentions no known system. */
export function proposeFromPitch(pitch: string | undefined): string[] {
  const text = (pitch ?? "").toLowerCase();
  if (!text.trim()) return [];
  const ids: string[] = [];
  for (const [id, aliases] of Object.entries(PITCH_ALIASES)) {
    const hit = aliases.some((a) => new RegExp(`(^|[^a-z0-9])${escapeRe(a)}([^a-z0-9]|$)`, "i").test(text));
    if (hit) ids.push(id);
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
