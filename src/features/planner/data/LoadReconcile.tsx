// LoadReconcile — build-time migration UI (#ls-reconcile-ui).
//
// Surfaces the reconcile-by-identity result from the backend: each canonical record with
// per-field lineage (source, loaded_at, license), a quality-gate pass/fail against each
// Field's `validate` rule, and a "Verify load" button that writes a persistent store flag
// once every record clears the gate. The load is re-runnable until cutover (idempotent).

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { DataModel, Field } from "./dataModel";

const mono = "var(--mono)";

// ── Backend response shape ────────────────────────────────────────────────────
// Mirrors the Rust `data_load_reconciled` command output (source-experience lands the stub).
// Each per-field lineage entry carries the full provenance trio: source, timestamp, license.

interface FieldLineage {
  source: string;
  loaded_at: string;
  license: string;
}

export interface ReconcileRecord {
  identity: string;
  values: Record<string, string>;
  /** field → lineage (source, loaded_at, license). May be absent for empty fields. */
  lineage: Record<string, FieldLineage>;
}

export interface ReconcileResponse {
  entity: string;
  records: ReconcileRecord[];
  conflicts: number;
  source_precedence: string[];
}

// ── Quality gate ─────────────────────────────────────────────────────────────
// Lightweight built-in validators keyed by the rule id stored in Field.validate.
// Unknown rule ids pass through (future rules won't silently gate existing loads).

const VALIDATORS: Record<string, (v: string) => boolean> = {
  email:     (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone:     (v) => /^[\d\s\-+().]{7,}$/.test(v),
  url:       (v) => { try { new URL(v); return true; } catch { return false; } },
  "not-empty": (v) => v.trim().length > 0,
};

export interface QualityFailure {
  field: string;
  rule: string;
  value: string;
}

export interface QuarantineEntry {
  record: ReconcileRecord;
  failures: QualityFailure[];
}

export interface GateResult {
  clean: ReconcileRecord[];
  quarantine: QuarantineEntry[];
}

export function runQualityGate(records: ReconcileRecord[], entity: { fields: Field[] }): GateResult {
  const clean: ReconcileRecord[] = [];
  const quarantine: QuarantineEntry[] = [];

  for (const record of records) {
    const failures: QualityFailure[] = [];
    for (const field of entity.fields) {
      if (!field.validate) continue;
      const value = record.values[field.key] ?? "";
      // An absent/empty cell means the source had no value — skip format validation.
      // (Missing required fields are handled by Field.required, not the validate rule.)
      if (!value) continue;
      const validator = VALIDATORS[field.validate];
      if (validator && !validator(value)) {
        failures.push({ field: field.key, rule: field.validate, value });
      }
    }
    if (failures.length > 0) {
      quarantine.push({ record, failures });
    } else {
      clean.push(record);
    }
  }

  return { clean, quarantine };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  projectKey: string;
  model: DataModel;
  entityKey: string;
}

type LoadState = "idle" | "loading" | "loaded" | "error";

export function LoadReconcile({ projectKey, model, entityKey }: Props) {
  const setLoadVerified = useAppStore((s) => s.setLoadVerified);
  const isVerified = useAppStore((s) => !!(s.loadVerified[projectKey]?.[entityKey]));

  const entity = model.entities.find((e) => e.key === entityKey);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [response, setResponse] = useState<ReconcileResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [gate, setGate] = useState<GateResult | null>(null);

  async function runLoad() {
    if (!entity) return;
    setLoadState("loading");
    setResponse(null);
    setGate(null);
    setErrorMsg("");
    try {
      const resp = await invoke<ReconcileResponse>("data_load_reconciled", {
        projectKey,
        entityKey,
        modelJson: JSON.stringify(model),
      });
      const gateResult = runQualityGate(resp.records, entity);
      setResponse(resp);
      setGate(gateResult);
      setLoadState("loaded");
    } catch (e) {
      setErrorMsg(String(e));
      setLoadState("error");
    }
  }

  function handleVerify() {
    setLoadVerified(projectKey, entityKey, true);
  }

  if (!entity) {
    return (
      <div style={{ padding: 20, fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>
        Entity <strong>{entityKey}</strong> not found in model.
      </div>
    );
  }

  return (
    <div style={{ padding: "16px 20px", fontFamily: mono, fontSize: 12 }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>{entity.label || entityKey}</span>
          <span style={{ marginLeft: 8, color: "var(--fg-dim)" }}>
            {entity.fields.length} fields · identity: {entity.identity.join(", ") || "—"}
          </span>
        </div>

        {isVerified ? (
          <span aria-label="Load verified" style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 11,
            background: "color-mix(in oklch, var(--accent) 20%, var(--bg-panel))",
            border: "1px solid color-mix(in oklch, var(--accent) 40%, transparent)",
            color: "var(--accent)",
          }}>
            Verified
          </span>
        ) : (
          <button
            className="btn ghost"
            onClick={runLoad}
            disabled={loadState === "loading"}
            style={{ height: 28, fontSize: 11 }}
          >
            {loadState === "loading" ? "Loading…" : "Load & Reconcile"}
          </button>
        )}
      </div>

      {/* Error */}
      {loadState === "error" && (
        <div role="alert" style={{
          padding: "10px 14px", borderRadius: 6, marginBottom: 12,
          background: "color-mix(in oklch, red 12%, var(--bg-panel))",
          border: "1px solid color-mix(in oklch, red 30%, transparent)",
          color: "var(--fg-muted)", fontSize: 12,
        }}>
          {errorMsg}
        </div>
      )}

      {response && gate && (
        <>
          {/* Summary bar */}
          <div style={{
            display: "flex", gap: 16, padding: "8px 12px", borderRadius: 6, marginBottom: 12,
            background: "var(--bg-panel)", border: "1px solid var(--border-soft)",
          }}>
            <Chip label="Records" value={response.records.length} />
            <Chip label="Conflicts" value={response.conflicts} />
            <Chip label="Clean" value={gate.clean.length} accent />
            {gate.quarantine.length > 0 && (
              <Chip label="Quarantined" value={gate.quarantine.length} warn />
            )}
            {response.source_precedence.length > 0 && (
              <span style={{ color: "var(--fg-dim)", marginLeft: "auto" }}>
                Precedence: {response.source_precedence.join(" › ")}
              </span>
            )}
          </div>

          {/* Quarantine section */}
          {gate.quarantine.length > 0 && (
            <section aria-label="Quarantine" style={{ marginBottom: 16 }}>
              <div style={{
                padding: "6px 12px", borderRadius: "6px 6px 0 0",
                background: "color-mix(in oklch, orange 20%, var(--bg-panel))",
                border: "1px solid color-mix(in oklch, orange 35%, transparent)",
                borderBottom: "none", fontWeight: 600, fontSize: 11,
                textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-muted)",
              }}>
                Quarantined — {gate.quarantine.length} {gate.quarantine.length === 1 ? "record" : "records"} failed quality gate
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
                    <Th>Identity</Th>
                    <Th>Field</Th>
                    <Th>Rule</Th>
                    <Th>Value</Th>
                  </tr>
                </thead>
                <tbody>
                  {gate.quarantine.map((q) =>
                    q.failures.map((f, i) => (
                      <tr key={`${q.record.identity}-${f.field}-${i}`}
                        style={{ borderBottom: "1px solid var(--border-soft)" }}>
                        <Td mono>{i === 0 ? q.record.identity : ""}</Td>
                        <Td mono>{f.field}</Td>
                        <Td>{f.rule}</Td>
                        <Td mono>{f.value || "(empty)"}</Td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </section>
          )}

          {/* Clean records — lineage view */}
          {gate.clean.length > 0 && (
            <section aria-label="Reconciled records">
              <table aria-label="Reconciled records" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)" }}>
                    <Th>Identity</Th>
                    {entity.fields.map((f) => <Th key={f.key}>{f.label || f.key}</Th>)}
                  </tr>
                </thead>
                <tbody>
                  {gate.clean.map((rec) => (
                    <tr key={rec.identity} style={{ borderBottom: "1px solid var(--border-soft)" }}>
                      <Td mono>{rec.identity}</Td>
                      {entity.fields.map((f) => (
                        <Td key={f.key}>
                          <LineageCell value={rec.values[f.key]} lineage={rec.lineage[f.key]} />
                        </Td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Verify load CTA */}
          {gate.quarantine.length === 0 && !isVerified && (
            <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
              <button
                className="btn"
                onClick={handleVerify}
                aria-label="Verify load"
                style={{ height: 32, fontSize: 12, paddingInline: 20 }}
              >
                Verify load
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Chip({ label, value, accent, warn }: { label: string; value: number; accent?: boolean; warn?: boolean }) {
  const color = warn ? "orange" : accent ? "var(--accent)" : "var(--fg-dim)";
  return (
    <span style={{ display: "flex", gap: 5, alignItems: "baseline" }}>
      <span style={{ color: "var(--fg-dim)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em" }}>{label}</span>
      <span style={{ color, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th style={{
      padding: "6px 10px", textAlign: "left", fontFamily: mono, fontSize: 11,
      fontWeight: 600, color: "var(--fg-muted)", textTransform: "uppercase",
      letterSpacing: ".05em", whiteSpace: "nowrap",
    }}>
      {children}
    </th>
  );
}

function Td({ children, mono: isMono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td style={{
      padding: "5px 10px", color: "var(--fg)",
      fontFamily: isMono ? "var(--mono)" : undefined,
      fontSize: 12, verticalAlign: "top",
    }}>
      {children}
    </td>
  );
}

function LineageCell({ value, lineage }: { value?: string; lineage?: FieldLineage }) {
  if (!value) return <span style={{ color: "var(--fg-dim)" }}>—</span>;
  return (
    <span>
      <span>{value}</span>
      {lineage && (
        <span
          title={`source: ${lineage.source} · ${lineage.loaded_at} · ${lineage.license}`}
          style={{
            marginLeft: 6, fontSize: 10, color: "var(--fg-dim)",
            borderBottom: "1px dashed var(--border-soft)", cursor: "help",
          }}
        >
          {lineage.source}
        </span>
      )}
    </span>
  );
}
