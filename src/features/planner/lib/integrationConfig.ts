// Integration config (#1207) — the two concerns the Integration blueprint adds beyond the existing
// source → model → map machinery: WHERE the extracted data goes (the destination/sink) and HOW/WHEN
// it syncs (full vs. incremental, schedule, watermark). Pure (no React/Tauri) so the readiness checks
// that drive the `destinationDefined` / `syncDefined` stage gates are unit-testable. Mirrors the
// deployConfig.ts / sourceConfig.ts shape; one IntegrationConfig per project (store `planIntegrationConfig`).
//
// This is the integration app's OUTBOUND half — migration loads inward and once; integration delivers
// outward and continuously. Source extraction is read-only and reuses the connector machinery; this
// config only describes the sink + cadence.

import type { ReadinessCheck } from "./readiness";

/** Kind of destination the extracted data lands in. */
export type DestinationType = "warehouse" | "database" | "object-store" | "file" | "api";

export interface DestinationOption {
  id: DestinationType;
  name: string;
  /** Placeholder for the `target` field (a connection string / bucket / path / URL). */
  targetHint: string;
  glyph: string;
}

/** The destination catalog the pane offers. */
export const DESTINATIONS: DestinationOption[] = [
  { id: "warehouse",    name: "Data warehouse",  targetHint: "bigquery://project.dataset / snowflake://…", glyph: "▤" },
  { id: "database",     name: "Database",        targetHint: "postgres://host/db",                          glyph: "⛁" },
  { id: "object-store", name: "Object store",    targetHint: "s3://bucket/prefix / gcs://bucket",           glyph: "⬢" },
  { id: "file",         name: "File drop",       targetHint: "/exports or sftp://host/path",                glyph: "⎙" },
  { id: "api",          name: "Outbound API / webhook", targetHint: "https://api.example.com/ingest",       glyph: "↗" },
];
export function destinationMeta(id: string): DestinationOption {
  return DESTINATIONS.find((d) => d.id === id) ?? { id: id as DestinationType, name: id || "—", targetHint: "", glyph: "■" };
}

/** How the data is written into the destination. */
export type WriteMode = "append" | "upsert" | "replace";

export interface DestinationConfig {
  type: DestinationType | "";
  /** Connection string / bucket / path / URL for the sink. */
  target: string;
  writeMode: WriteMode | "";
  /** Optional table / path layout, e.g. `raw.{object}` or `{object}/dt={date}`. */
  layout: string;
}

/** Full snapshot every run vs. only what changed since the last watermark (CDC). */
export type SyncMode = "full" | "incremental";

export interface SyncConfig {
  mode: SyncMode | "";
  /** Cron expression or a trigger keyword (`manual`, `@hourly`, `0 2 * * *`). */
  schedule: string;
  /** The monotonically-increasing field incremental sync watermarks on (e.g. `updated_at`). */
  watermark: string;
  /** Idempotent upserts keyed by the source identity — pairs with destination `upsert`. */
  idempotent: boolean;
}

export interface IntegrationConfig {
  destination: DestinationConfig;
  sync: SyncConfig;
}

/** A fresh, empty integration config. */
export function defaultIntegrationConfig(): IntegrationConfig {
  return {
    destination: { type: "", target: "", writeMode: "", layout: "" },
    sync: { mode: "", schedule: "", watermark: "", idempotent: true },
  };
}

/** Destination readiness checks — drive the pane banner; every one ok ⇒ `destinationDefined`. */
export function destinationChecks(d: DestinationConfig): ReadinessCheck[] {
  return [
    { id: "type",   label: "Destination type chosen",  ok: !!d.type,           detail: d.type ? destinationMeta(d.type).name : "—" },
    { id: "target", label: "Target location set",      ok: !!d.target.trim(),  detail: d.target.trim() || "—" },
    { id: "write",  label: "Write mode chosen",        ok: !!d.writeMode,       detail: d.writeMode || "—" },
  ];
}

/** The `destinationDefined` gate signal: the sink type, target, and write mode are all set. */
export function destinationDefined(cfg: IntegrationConfig | undefined): boolean {
  return !!cfg && destinationChecks(cfg.destination).every((c) => c.ok);
}

/** Sync readiness checks — `syncDefined` requires all ok (incremental also needs a watermark). */
export function syncChecks(s: SyncConfig): ReadinessCheck[] {
  return [
    { id: "mode",      label: "Sync mode chosen",            ok: !!s.mode,            detail: s.mode || "—" },
    { id: "schedule",  label: "Schedule / trigger set",      ok: !!s.schedule.trim(), detail: s.schedule.trim() || "—" },
    { id: "watermark", label: "Watermark field (incremental)", ok: s.mode !== "incremental" || !!s.watermark.trim(), detail: s.mode === "incremental" ? (s.watermark.trim() || "needed") : "n/a (full)" },
  ];
}

/** The `syncDefined` gate signal: a mode + schedule, and a watermark when the mode is incremental. */
export function syncDefined(cfg: IntegrationConfig | undefined): boolean {
  return !!cfg && syncChecks(cfg.sync).every((c) => c.ok);
}
