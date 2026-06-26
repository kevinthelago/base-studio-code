// Destination + Sync focused-pane bodies (#1207) for the Integration blueprint. Store-backed
// (planIntegrationConfig keyed by projectId), pure presentational over integrationConfig — the user
// fills the sink + cadence here; the `destinationDefined` / `syncDefined` gate signals derive from it.

import { useAppStore } from "@/store";
import {
  DESTINATIONS, destinationMeta, WRITE_MODES, SYNC_MODES,
  defaultIntegrationConfig, destinationChecks, syncChecks,
  type IntegrationConfig, type DestinationConfig, type SyncConfig, type DestinationType, type WriteMode, type SyncMode,
} from "../lib/integrationConfig";
import { MONO, grpLabel } from "./bodyStyles";

function Readiness({ checks, label }: { checks: { ok: boolean }[]; label: string }) {
  const ok = checks.filter((c) => c.ok).length;
  const ready = ok === checks.length;
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 9, padding: "9px 13px", borderRadius: "var(--r-md)",
      background: `color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 90%)`,
      border: `1px solid color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 72%)`,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, background: ready ? "var(--success)" : "var(--accent)" }} />
      <span style={{ fontFamily: MONO, fontSize: 11, color: ready ? "var(--success)" : "var(--accent)" }}>{ready ? `${label} defined` : `${ok}/${checks.length} set`}</span>
    </div>
  );
}

function Field({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={grpLabel}>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} style={{
        height: 30, padding: "0 11px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)", outline: "none", fontFamily: MONO, fontSize: 12, color: "var(--fg)",
      }} />
    </label>
  );
}

function Seg<T extends string>({ value, options, labels, onChange }: { value: T | ""; options: readonly T[]; labels?: Record<string, string>; onChange: (v: T) => void }) {
  return (
    <div style={{ display: "inline-flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden", flexWrap: "wrap" }}>
      {options.map((o, i) => {
        const on = value === o;
        return (
          <button key={o} onClick={() => onChange(o)} style={{
            height: 24, padding: "0 11px", border: 0, borderLeft: i ? "1px solid var(--border-soft)" : "none", cursor: "pointer",
            fontFamily: MONO, fontSize: 10.5, background: on ? "var(--bg-elev2)" : "transparent", color: on ? "var(--fg)" : "var(--fg-dim)",
          }}>{labels?.[o] ?? o}</button>
        );
      })}
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span onClick={onClick} style={{
        width: 26, height: 15, borderRadius: 99, flexShrink: 0, cursor: "pointer", position: "relative",
        background: on ? "color-mix(in oklch, var(--success), transparent 50%)" : "var(--bg-elev2)",
        border: "1px solid " + (on ? "var(--success)" : "var(--border-soft)"),
      }}>
        <span style={{ position: "absolute", top: 1, left: on ? 12 : 1, width: 11, height: 11, borderRadius: 99, background: on ? "var(--success)" : "var(--fg-dim)" }} />
      </span>
      <span style={{ fontFamily: MONO, fontSize: 10.5, color: on ? "var(--fg)" : "var(--fg-muted)" }}>{label}</span>
    </div>
  );
}

function useIntegration(projectId?: string): [IntegrationConfig, (cfg: IntegrationConfig) => void] {
  const pid = projectId ?? "";
  const stored = useAppStore((s) => s.planIntegrationConfig[pid]);
  const set = useAppStore((s) => s.setPlanIntegrationConfig);
  return [stored ?? defaultIntegrationConfig(), (cfg) => set(pid, cfg)];
}

/** Destination stage body — the sink the integration delivers to. */
export function FocusedDestinationBody({ projectId }: { projectId?: string }) {
  const [cfg, setCfg] = useIntegration(projectId);
  const d = cfg.destination;
  const setDest = (patch: Partial<DestinationConfig>) => setCfg({ ...cfg, destination: { ...d, ...patch } });

  return (
    <div data-testid="destination-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Readiness checks={destinationChecks(d)} label="Destination" />

      <div>
        <div style={{ ...grpLabel, marginBottom: 7 }}>destination type</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
          {DESTINATIONS.map((dest) => {
            const on = d.type === dest.id;
            return (
              <button key={dest.id} data-testid={`dest-${dest.id}`} onClick={() => setDest({ type: dest.id as DestinationType })} style={{
                display: "flex", alignItems: "center", gap: 9, padding: "9px 11px", cursor: "pointer", textAlign: "left",
                borderRadius: "var(--r-md)", border: "1px solid " + (on ? "var(--accent)" : "var(--border-soft)"),
                background: on ? "color-mix(in oklch, var(--accent), transparent 90%)" : "var(--bg-elev)",
              }}>
                <span style={{ fontSize: 14, color: on ? "var(--accent)" : "var(--fg-muted)" }}>{dest.glyph}</span>
                <span style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg)" }}>{dest.name}</span>
                {on && <span style={{ marginLeft: "auto", color: "var(--accent)", fontSize: 11 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </div>

      <Field label="target" value={d.target} placeholder={d.type ? destinationMeta(d.type).targetHint : "connection string / bucket / path / URL"} onChange={(v) => setDest({ target: v })} />

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={grpLabel}>write mode</span>
        <Seg value={d.writeMode} options={WRITE_MODES.map((w) => w.id)} onChange={(v) => setDest({ writeMode: v as WriteMode })} />
        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>{d.writeMode ? (WRITE_MODES.find((w) => w.id === d.writeMode)?.desc ?? "") : "append · upsert (idempotent) · replace"}</span>
      </div>

      <Field label="layout · optional" value={d.layout} placeholder="raw.{object} or {object}/dt={date}" onChange={(v) => setDest({ layout: v })} />

      <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", lineHeight: 1.5 }}>
        🛡 Destination credentials are entered on this device (keychain) — never written into the plan or shared with the planner.
      </span>
    </div>
  );
}

/** Sync stage body — how/when the data syncs into the destination. */
export function FocusedSyncBody({ projectId }: { projectId?: string }) {
  const [cfg, setCfg] = useIntegration(projectId);
  const s = cfg.sync;
  const setSync = (patch: Partial<SyncConfig>) => setCfg({ ...cfg, sync: { ...s, ...patch } });

  return (
    <div data-testid="sync-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Readiness checks={syncChecks(s)} label="Sync" />

      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={grpLabel}>sync mode</span>
        <Seg value={s.mode} options={SYNC_MODES.map((m) => m.id)} onChange={(v) => setSync({ mode: v as SyncMode })} />
        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>{s.mode ? (SYNC_MODES.find((m) => m.id === s.mode)?.desc ?? "") : "full re-extract · incremental (CDC since a watermark)"}</span>
      </div>

      <Field label="schedule · cron or trigger" value={s.schedule} placeholder="0 2 * * *  ·  @hourly  ·  manual" onChange={(v) => setSync({ schedule: v })} />

      {s.mode === "incremental" && (
        <Field label="watermark field" value={s.watermark} placeholder="updated_at · sequence id · CDC position" onChange={(v) => setSync({ watermark: v })} />
      )}

      <Toggle on={s.idempotent} onClick={() => setSync({ idempotent: !s.idempotent })} label="Idempotent upserts by the source identity key (safe re-runs / backfills)" />
    </div>
  );
}
