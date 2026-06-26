// Migration SOURCE specs (#source-pane) — the pure type model behind the planner's Source stage:
// the per-connector connection contract (auth + form fields), the discovered inventory shape a scan
// returns, the structured behavior scan, and the per-project SourceConfig the Source pane edits.
// Split out of sourceConfig.ts (#1638); the connector catalog lives in sourceCatalog.ts and the
// gate/derivation/scan-view helpers in sourceGate.ts / dataModelDerivation.ts / sourceScanViews.ts.
// sourceConfig.ts re-exports them all.
//
// SECURITY BOUNDARY: a connector's SECRET field values NEVER live in this config (they go to the OS
// keychain on the device and are never persisted here or shared with the planning agent). The config
// keeps only non-secret fields, a redacted `handle`, and the discovered (not extracted) inventory.

import type { FieldType } from "@/features/planner/data/dataModel";

/** How a connector authenticates — drives which card the per-source ConnectionSpec renders. */
export type AuthMethod = "oauth" | "token" | "password" | "basic" | "apiKey" | "open" | "upload";

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

/** A discovered field: name + an inferred type + (for enums) the observed values (#1219). */
export interface DiscoveredField { name: string; type?: FieldType; enumValues?: string[]; ref?: string }
/** An object/table the scan discovered in a connected source (a count, not extracted rows).
 *  `fields` accepts bare column names (older fixtures) or typed {@link DiscoveredField}s (the live
 *  scan) — used to seed the derived Data Model's entity fields + types. */
export interface DiscoveredObject { name: string; count: number; fields?: (string | DiscoveredField)[] }
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
