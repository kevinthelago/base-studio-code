// Migration SOURCE config (#source-pane, design/Source connection pane kickoff) — the data model
// behind the planner's Source stage (right after Repos): the legacy systems a project migrates FROM,
// connected READ-ONLY so the planner can scan them into a Data Model. Pure (no React/Tauri) so the
// catalog, the per-connector ConnectionSpec, and the readiness checks that drive the stage gate are
// unit-testable. Mirrors the deployConfig.ts shape.
//
// One SourceConfig per project (store slice `planSourceConfig`). The Source pane edits it; the
// `sourcesConnected` gate signal (Planning.tsx) is `allSourcesConnected(config)`.
//
// SECURITY BOUNDARY: a connector's SECRET field values NEVER live in this config (they go to the OS
// keychain on the device and are never persisted here or shared with the planning agent). The config
// keeps only non-secret fields, a redacted `handle`, and the discovered (not extracted) inventory.

import type { DataModel, Entity, Field, FieldType } from "@/features/planner/data/dataModel";

/** How a connector authenticates — drives which card the per-source ConnectionSpec renders. */
export type AuthMethod = "oauth" | "token" | "password" | "basic" | "apiKey" | "upload";

/** One input a connector's form collects. A `secret` field is masked, kept on-device, and never
 *  written into {@link DeclaredSource.fields}. */
export interface SpecField {
  key: string;
  label: string;
  /** Masked + keychain-bound; never persisted to the config or shared with the planner. */
  secret?: boolean;
  /** Optional field — absence doesn't block connecting (e.g. an app id that just scopes the scan). */
  optional?: boolean;
  hint?: string;
  placeholder?: string;
}

/** The per-connector connection contract — the same surface renders a different page from this. */
export interface ConnectionSpec {
  auth: AuthMethod;
  /** Form fields for token/password/basic/apiKey connectors (empty for oauth/upload). */
  fields: SpecField[];
  /** OAuth button label, e.g. "Connect to Salesforce" (oauth connectors only). */
  oauthLabel?: string;
  /** Show a Production / Sandbox environment toggle (oauth connectors). */
  envs?: boolean;
  /** One-line "will contribute →" summary of what a scan pulls in (objects + behaviors). */
  contributes: string;
}

/** A catalog connector the user can declare as a source. */
export interface Connector {
  id: string;
  name: string;
  /** Two/three-char mono badge, e.g. "QB". */
  badge: string;
  /** Catalog auth blurb, e.g. "OAuth" / "token" / "API key". */
  authLabel: string;
  spec: ConnectionSpec;
  /** Coarse grouping for the catalog UI (#1288) — `crm`, `erp`, `work`, … ; absent for the
   *  dedicated core connectors. */
  category?: string;
  /** A packaged generic-REST vendor preset (#1288), vs a dedicated connector. */
  preset?: boolean;
}

/** A packaged vendor preset from the backend catalog (#1288 — the `data_connector_catalog` command
 *  over `crates/data` `presets::CATALOG`). The Source pane turns each into a generic-REST connector. */
export interface ConnectorCatalogEntry {
  id: string;
  name: string;
  category: string;
  /** "will contribute →" blurb — the preset's resource object names. */
  contributes: string;
}

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

/** A discovered field: name + an inferred type + (for enums) the observed values (#1219). */
export interface DiscoveredField { name: string; type?: FieldType; enumValues?: string[]; ref?: string }
/** An object/table the scan discovered in a connected source (a count, not extracted rows).
 *  `fields` accepts bare column names (older fixtures) or typed {@link DiscoveredField}s (the live
 *  scan) — used to seed the derived Data Model's entity fields + types. */
export interface DiscoveredObject { name: string; count: number; fields?: (string | DiscoveredField)[] }
const fieldName = (f: string | DiscoveredField): string => (typeof f === "string" ? f : f.name);
const fieldMeta = (f: string | DiscoveredField): { type?: FieldType; enumValues?: string[]; ref?: string } =>
  typeof f === "string" ? {} : { type: f.type, enumValues: f.enumValues, ref: f.ref };
/** A behavior (business rule / automation) the scan found — these shape the target app, not just data. */
export interface SourceBehavior { label: string }

// ── Structured behavior scan (the Process visualization, #1209) ──────────────────────────────
// Mirrors the Rust `bsc_data::PlatformScan` (serde camelCase). The scan returns this alongside the
// flat `behaviors` labels; the Process view renders the detail (trigger → condition → actions, etc.).
export type ScanAutomationKind = "validation" | "workflow" | "flow" | "processBuilder" | "recurring" | "other";
export interface ScanAutomation {
  source: string; kind: ScanAutomationKind; name: string; object: string;
  active: boolean; trigger: string; condition: string; actions: string[];
}
export interface ScanBusinessProcess { source: string; name: string; object: string; active: boolean; steps: string[] }
export type ScanDerivedKind = "formula" | "code";
export interface ScanDerivedLogic { source: string; kind: ScanDerivedKind; name: string; object?: string; expression: string }
export interface PlatformScanView {
  automations: ScanAutomation[];
  businessProcesses: ScanBusinessProcess[];
  derivedLogic: ScanDerivedLogic[];
}

/** The lifecycle of one declared source. `declared` = chosen, not yet authorized; `connecting` =
 *  validating credentials; `scanning` = authorized, discovering objects; `scanned` = inventory in
 *  hand; `error` = auth/connection failed (holds the gate). */
export type SourceStatus = "declared" | "connecting" | "scanning" | "scanned" | "error";

/** A source the user declared they're migrating from. */
export interface DeclaredSource {
  uid: string;
  connectorId: string;
  /** Friendly instance label once connected, e.g. "Acme Co". */
  instance?: string;
  env?: "production" | "sandbox";
  status: SourceStatus;
  /** Non-secret field values (keyed by ConnectionSpec field key). SECRETS ARE NEVER STORED HERE. */
  fields: Record<string, string>;
  /** Redacted handle the planner is allowed to see ("Acme Co · Production · held by app"). */
  handle?: string;
  /** A secret was saved to the device keychain (we keep the flag, never the value). */
  secretSaved?: boolean;
  objects?: DiscoveredObject[];
  behaviors?: SourceBehavior[];
  /** The structured behavior scan (automations / processes / derived logic) for the Process view (#1209). */
  platform?: PlatformScanView;
  /** Failure reason for the error state, e.g. "token rejected (401)". */
  error?: string;
}

export interface SourceConfig {
  /** The canonical Data Model every connected source feeds, e.g. "Acme Core". */
  dataModelName: string;
  /** Connector ids the planner proposed from the pitch (the pre-declare ★ banner); cleared once acted on. */
  proposed: string[];
  sources: DeclaredSource[];
}

/** A fresh, empty source config. */
export function defaultSourceConfig(): SourceConfig {
  return { dataModelName: "", proposed: [], sources: [] };
}

/** A new declared source for `connectorId` (status `declared`, no fields yet). */
export function newDeclaredSource(connectorId: string, uid: string): DeclaredSource {
  return { uid, connectorId, status: "declared", fields: {} };
}

/** A source counts as "connected" once it is scanning or fully scanned (authorized, secret on device). */
export function isConnected(s: DeclaredSource): boolean {
  return s.status === "scanning" || s.status === "scanned";
}

/** How many declared sources are connected. */
export function connectedCount(cfg: SourceConfig): number {
  return cfg.sources.filter(isConnected).length;
}

/** The `sourcesConnected` gate signal: ≥1 source declared and EVERY one fully scanned (no pending or
 *  errored source). An empty set can't pass (nothing to migrate from ⇒ the stage shouldn't apply). */
export function allSourcesConnected(cfg: SourceConfig | undefined): boolean {
  return !!cfg && cfg.sources.length > 0 && cfg.sources.every((s) => s.status === "scanned");
}

export interface SourceCheck { id: string; label: string; ok: boolean; detail: string }

/** Readiness checks driving the in-pane banner: every declared source scanned, none errored. */
export function sourceChecks(cfg: SourceConfig): SourceCheck[] {
  const total = cfg.sources.length;
  const scanned = cfg.sources.filter((s) => s.status === "scanned").length;
  const errored = cfg.sources.filter((s) => s.status === "error").length;
  return [
    { id: "declared", label: "Declare the systems you're migrating from", ok: total > 0, detail: `${total} source${total !== 1 ? "s" : ""}` },
    { id: "connected", label: "Connect & scan every source", ok: total > 0 && scanned === total, detail: `${scanned}/${total} connected` },
    { id: "healthy", label: "No connection errors", ok: errored === 0, detail: errored ? `${errored} failed` : "all healthy" },
  ];
}

// ── Derive the canonical Data Model from a scan (#1205 — "data dictates structure") ─────────────
// The scanned sources seed the project's canonical Data Model: one entity per discovered object
// (deduped across sources), fields from the discovered columns when present (else a default `id`
// identity to start from). This is what `features`/`structure` design over — persisted to
// datamodel.json by the Source pane and surfaced as the downstream-impact recap.

/** Slug a source object/column name into a safe Data Model key (matches dataModel.ts SAFE_IDENT). */
function safeKey(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[a-z_]/.test(s) ? s : `e_${s}`;
}

/** Build a Data Model from the scanned sources — entities from discovered objects, fields from
 *  their columns (or a default `id` key), deduped by entity key. */
export function deriveDataModel(cfg: SourceConfig, id = "dm-source"): DataModel {
  const entities: Entity[] = [];
  const seen = new Set<string>();
  for (const s of cfg.sources) {
    if (s.status !== "scanned") continue;
    for (const o of s.objects ?? []) {
      const key = safeKey(o.name) || "entity";
      if (seen.has(key)) continue; // one entity per object name, across sources
      seen.add(key);
      const fseen = new Set<string>();
      const cols = (o.fields ?? [])
        .map((f) => ({ key: safeKey(fieldName(f)), meta: fieldMeta(f) }))
        .filter((c) => c.key && !fseen.has(c.key) && (fseen.add(c.key), true));
      const fields: Field[] = cols.length
        ? cols.map((c) => ({
            key: c.key,
            type: c.meta.type ?? "string",
            ...(c.meta.enumValues && c.meta.enumValues.length ? { enum_values: c.meta.enumValues } : {}),
            ...(c.meta.ref ? { ref: safeKey(c.meta.ref) } : {}),
          }))
        : [{ key: "id", type: "string" as const, required: true }];
      const identity = fields.some((f) => f.key === "id") ? ["id"] : fields[0] ? [fields[0].key] : [];
      entities.push({ key, label: o.name, fields, identity });
    }
  }
  // Resolve relationships. A connector-declared lookup (#1219, e.g. Salesforce AccountId → Account)
  // wins when its target was scanned — it's exact, and its field key (`accountid`) wouldn't match by
  // name. Otherwise infer (#1209): a field whose key matches another entity's key is a `ref` to it
  // (e.g. Contact.account → Account). Either gives the graph its edges and the list its ref chips.
  const entityKeys = new Set(entities.map((e) => e.key));
  for (const e of entities) {
    for (const f of e.fields) {
      if (f.ref && entityKeys.has(f.ref)) {
        f.type = "ref";
        delete f.enum_values; // a ref isn't an enum
      } else if (f.key !== e.key && entityKeys.has(f.key)) {
        f.type = "ref";
        f.ref = f.key;
        delete f.enum_values;
      } else if (f.ref) {
        // Declared ref to an object that wasn't scanned — drop the dangling link, keep a plain field.
        delete f.ref;
        if (f.type === "ref") f.type = "string";
      }
    }
  }
  return { id, name: cfg.dataModelName || "Source Data Model", version: 1, entities };
}

/** Whether a migration source is active for the project (≥1 declared source) — drives the `source`
 *  stage's `migrationSourceEnabled` so the stage applies. */
export function migrationActive(cfg: SourceConfig | undefined): boolean {
  return !!cfg && cfg.sources.length > 0;
}

/** The datamodel.json gate signals derived from the live scan state (feeds derivePlanStageState),
 *  so the source stage's gate reflects scan progress without a round-trip to disk. */
export function datamodelSignals(cfg: SourceConfig | undefined): { sourceReachable: boolean; modelInferred: boolean; schemaRefined: boolean } {
  if (!cfg) return { sourceReachable: false, modelInferred: false, schemaRefined: false };
  return {
    sourceReachable: cfg.sources.some((s) => s.status === "scanning" || s.status === "scanned"),
    modelInferred: cfg.sources.some((s) => s.status === "scanned"),
    schemaRefined: allSourcesConnected(cfg),
  };
}

/** The downstream-impact recap: what the scanned sources seed into features + structure. */
export function downstreamImpact(cfg: SourceConfig): { entities: number; fields: number; behaviors: number } {
  const m = deriveDataModel(cfg);
  const behaviors = cfg.sources.reduce((n, s) => {
    const p = s.platform;
    return n + (p ? p.automations.length + p.businessProcesses.length + p.derivedLogic.length : s.behaviors?.length ?? 0);
  }, 0);
  return { entities: m.entities.length, fields: m.entities.reduce((n, e) => n + e.fields.length, 0), behaviors };
}

// ── Scan visualizations (#1209) — the view-model behind the Graph / List / Process views ─────────

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

export interface ScanViewField { key: string; type: FieldType; required: boolean; identity: boolean; ref?: string; refLabel?: string; enumValues?: string[] }
export interface ScanViewEntity { key: string; label: string; count: number; source: string; srcColor: string; fields: ScanViewField[] }

/** The entities (with record counts, source provenance, fields + inferred refs) the Graph + List
 *  views render — built from the derived model and the scanned objects. */
export function scanEntities(cfg: SourceConfig): ScanViewEntity[] {
  const model = deriveDataModel(cfg);
  const labelByKey = new Map(model.entities.map((e) => [e.key, e.label ?? e.key]));
  const meta = new Map<string, { count: number; source: string }>();
  for (const s of cfg.sources) {
    if (s.status !== "scanned") continue;
    for (const o of s.objects ?? []) {
      const k = safeKey(o.name) || "entity";
      if (!meta.has(k)) meta.set(k, { count: o.count, source: s.connectorId }); // first wins (matches dedup)
    }
  }
  return model.entities.map((e) => {
    const m = meta.get(e.key) ?? { count: 0, source: "" };
    return {
      key: e.key,
      label: e.label ?? e.key,
      count: m.count,
      source: m.source,
      srcColor: connectorColor(m.source),
      fields: e.fields.map((f) => ({
        key: f.key, type: f.type, required: !!f.required, identity: e.identity.includes(f.key),
        ref: f.ref, refLabel: f.ref ? labelByKey.get(f.ref) ?? f.ref : undefined,
        enumValues: f.enum_values,
      })),
    };
  });
}

/** All ref relationships as edges for the Graph view. */
export function scanEdges(entities: ScanViewEntity[]): { from: string; to: string; label: string }[] {
  const keys = new Set(entities.map((e) => e.key));
  const edges: { from: string; to: string; label: string }[] = [];
  for (const e of entities) {
    for (const f of e.fields) {
      if (f.ref && keys.has(f.ref)) edges.push({ from: e.key, to: f.ref, label: `${f.key} → ${f.refLabel ?? f.ref}` });
    }
  }
  return edges;
}

/** The aggregated structured behaviors (across scanned sources) the Process view renders. */
export function aggregatePlatform(cfg: SourceConfig): PlatformScanView {
  const out: PlatformScanView = { automations: [], businessProcesses: [], derivedLogic: [] };
  for (const s of cfg.sources) {
    if (s.status !== "scanned" || !s.platform) continue;
    out.automations.push(...s.platform.automations);
    out.businessProcesses.push(...s.platform.businessProcesses);
    out.derivedLogic.push(...s.platform.derivedLogic);
  }
  return out;
}

/** Whether ≥2 distinct connector sources fed the scan (drives per-source provenance badges). */
export function isMultiSource(cfg: SourceConfig): boolean {
  return new Set(cfg.sources.filter((s) => s.status === "scanned").map((s) => s.connectorId)).size > 1;
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

/** A redacted handle the planner may see for a connected source — instance + env, never a credential. */
export function redactedHandle(s: DeclaredSource): string {
  const c = connector(s.connectorId);
  const inst = s.instance || c.name;
  const env = s.env ? ` · ${s.env}` : "";
  return `${inst}${env} · held by app`;
}

// ── Planner channel (forward-compat): coerce a lenient `<source_config>` payload → a SourceConfig.
//    The planner can PROPOSE sources from the pitch and pre-fill non-secret connection hints; it can
//    never supply a secret (those are entered on-device), so any secret-looking field is dropped. ──
type Raw = Record<string, unknown>;
const asStr = (v: unknown, d = ""): string => (typeof v === "string" ? v : d);
const asArr = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x): x is Raw => !!x && typeof x === "object") : []);
const STATUSES: SourceStatus[] = ["declared", "connecting", "scanning", "scanned", "error"];

export function coerceSourceConfig(raw: unknown): SourceConfig {
  const o = (raw && typeof raw === "object" ? raw : {}) as Raw;
  const proposed = (Array.isArray(o.proposed) ? o.proposed : [])
    .map((x) => asStr(x))
    .filter((id) => CONNECTORS.some((c) => c.id === id));
  const sources: DeclaredSource[] = asArr(o.sources).map((s, i) => {
    const connectorId = CONNECTORS.some((c) => c.id === asStr(s.connectorId)) ? asStr(s.connectorId) : "quickbase";
    const spec = connector(connectorId).spec;
    const secretKeys = new Set(spec.fields.filter((f) => f.secret).map((f) => f.key));
    const rawFields = (s.fields && typeof s.fields === "object" ? s.fields : {}) as Raw;
    const fields: Record<string, string> = {};
    // Keep only NON-SECRET field hints — a secret can never be carried in over the channel.
    for (const [k, v] of Object.entries(rawFields)) {
      if (!secretKeys.has(k) && typeof v === "string") fields[k] = v;
    }
    const status = STATUSES.includes(asStr(s.status) as SourceStatus) ? (asStr(s.status) as SourceStatus) : "declared";
    return {
      uid: asStr(s.uid) || `src-${connectorId}-${i}`,
      connectorId,
      instance: asStr(s.instance) || undefined,
      env: s.env === "sandbox" ? "sandbox" : s.env === "production" ? "production" : undefined,
      // A coerced source is never trusted as already-connected — credentials are entered on-device,
      // so anything past `declared` resets to `declared` (the user must connect it here).
      status: status === "error" ? "error" : "declared",
      fields,
    };
  });
  return { dataModelName: asStr(o.dataModelName) || asStr((o.dataModel as Raw)?.name), proposed, sources };
}

/** Parse a `<source_config>` tag body into a SourceConfig (forgiving: extracts the outermost JSON
 *  object, tolerates wrapping prose). Returns null if no JSON object is present. */
export function parseSourceConfigTag(body: string): SourceConfig | null {
  const json = body.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    return coerceSourceConfig(JSON.parse(json));
  } catch {
    try {
      return coerceSourceConfig(JSON.parse(json.replace(/[ \t]*[\r\n]+[ \t]*/g, " ")));
    } catch {
      return null;
    }
  }
}
