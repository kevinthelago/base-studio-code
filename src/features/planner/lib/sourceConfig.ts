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
//
// This module is the PUBLIC SURFACE (#1638). The implementation is split across focused modules that
// this file re-exports so importers don't churn:
//   - sourceSpecs.ts          — the type model (auth/field specs, discovered-inventory shapes, SourceConfig)
//   - sourceCatalog.ts        — the connector catalog + resolution, presets, samples, pitch proposal, colors
//   - sourceGate.ts           — connection counts/readiness + the gate signals (#1712)
//   - dataModelDerivation.ts  — the canonical Data Model derivation (#1712)
//   - sourceScanViews.ts      — the Graph / List / Process scan view-models (#1712)

export type {
  AuthMethod, SpecField, ConnectionSpec, Connector,
  DiscoveredField, DiscoveredObject, SourceBehavior,
  ScanAutomationKind, ScanAutomation, ScanBusinessProcess, ScanDerivedKind, ScanDerivedLogic, PlatformScanView,
  SourceStatus, DeclaredSource, SourceConfig,
} from "./sourceSpecs";
export { defaultSourceConfig, newDeclaredSource } from "./sourceSpecs";

// The native pre-built connectors were removed (#1976): there is no static catalog or backend preset
// catalog, so `connector(id)` resolves any id to a generic fallback shape (a one-click token connector).
export {
  connector, connectorColor, sampleScan, proposeFromPitch, redactedHandle,
} from "./sourceCatalog";
export type { RuntimeConnectorView } from "./sourceCatalog";

export {
  isConnected, connectedCount, allSourcesConnected, sourceChecks,
  migrationActive, datamodelSignals, downstreamImpact,
} from "./sourceGate";
export { deriveDataModel } from "./dataModelDerivation";
export type { ScanViewField, ScanViewEntity } from "./sourceScanViews";
export { scanEntities, scanEdges, aggregatePlatform, isMultiSource } from "./sourceScanViews";
