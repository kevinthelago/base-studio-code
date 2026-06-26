// connectorForm — the spec-driven connector form + per-source card for FocusedSourceBody (#1637).
//
// Split out of FocusedSourceBody.tsx: every PURE presentational piece that renders a declared
// source from its ConnectionSpec lives here — the field/secret inputs, the status badges, the scan
// bar/result, and the collapsible SourceCard that drives the spec → connect form. These take props
// only (no store, no invoke/listen) — the connection lifecycle lives in sourceConnection.ts.
//
// SECURITY BOUNDARY (the design's payoff): a secret field's value lives ONLY in local component
// state and is "saved to the device keychain" on connect — it is NEVER written into the persisted
// SourceConfig and never shared with the planning agent, which sees only a redacted handle + the
// discovered object inventory.

import {
  connector, isConnected,
  type DeclaredSource, type SpecField, type SourceStatus,
} from "../lib/sourceConfig";
import { MONO, grpLabel } from "./bodyStyles";
import { Chip } from "@/shared/ui/Chip";

export const STATUS_DOT: Record<SourceStatus, string> = {
  declared: "var(--fg-dim)",
  connecting: "var(--accent)",
  scanning: "var(--accent)",
  scanned: "var(--success)",
  error: "var(--danger)",
};

/** READ-ONLY badge — every source is read-only; the design repeats this as the core reassurance. */
function ReadOnlyPill() {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 9, color: "var(--success)", whiteSpace: "nowrap",
      background: "color-mix(in oklch, var(--success), transparent 88%)",
      border: "1px solid color-mix(in oklch, var(--success), transparent 74%)",
      borderRadius: 99, padding: "2px 7px",
    }}>READ-ONLY</span>
  );
}

/** A small mono badge tile, e.g. "QB". */
function Badge({ text }: { text: string }) {
  return (
    <span style={{
      fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)", background: "var(--bg-canvas)",
      border: "1px solid var(--border)", borderRadius: "var(--r-sm)", padding: "2px 5px", whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

/** A labeled, non-secret text field — its value is persisted into the source's config. */
function Field({ field, value, onChange }: { field: SpecField; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)" }}>
        {field.label}{field.optional && <span style={{ color: "var(--fg-dim)" }}> · optional{field.hint ? `, ${field.hint}` : ""}</span>}
      </span>
      <input
        value={value}
        placeholder={field.placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{
          height: 30, padding: "0 11px", background: "var(--bg-elev)", border: "1px solid var(--border)",
          borderRadius: "var(--r-md)", outline: "none", fontFamily: MONO, fontSize: 12.5, color: "var(--fg)",
        }}
      />
    </label>
  );
}

/** A secret field — masked, reveal-toggle, value held ONLY in local state (keychain-bound). */
function SecretField({ field, value, revealed, onChange, onReveal, testid }: {
  field: SpecField; value: string; revealed: boolean; onChange: (v: string) => void; onReveal: () => void; testid?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)" }}>
        {field.label} <span style={{ color: "var(--accent)" }}>●</span> <span style={{ color: "var(--fg-dim)" }}>secret</span>
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type={revealed ? "text" : "password"}
          value={value}
          aria-label={field.label}
          data-testid={testid}
          onChange={(e) => onChange(e.target.value)}
          style={{
            flex: 1, minWidth: 0, height: 32, padding: "0 11px", background: "var(--bg-elev)",
            border: "1px solid var(--accent-dim)", borderRadius: "var(--r-md)", outline: "none",
            fontFamily: MONO, fontSize: 13, letterSpacing: revealed ? 0 : ".06em", color: "var(--fg)",
          }}
        />
        <button
          onClick={onReveal} title={revealed ? "Hide" : "Reveal"} aria-label={`${revealed ? "Hide" : "Reveal"} ${field.label}`}
          style={{
            width: 34, height: 32, flex: "0 0 34px", display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", cursor: "pointer", fontSize: 13,
          }}
        >👁</button>
      </div>
    </label>
  );
}

/** Info / boundary chip ("🛡 Credentials stay on this device …"). */
function InfoChip({ children, color = "var(--info)" }: { children: React.ReactNode; color?: string }) {
  return (
    <Chip color={color} alignSelf="flex-start" gap={6} padding="3px 9px" bgAlpha={89} borderAlpha={76}>{children}</Chip>
  );
}

/** Indeterminate scan bar (the only place the pane animates — a genuinely live op). */
function ScanBar() {
  return (
    <div style={{ height: 5, borderRadius: 99, background: "var(--bg-elev)", overflow: "hidden", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, height: "100%", width: "30%", background: "var(--accent)", borderRadius: 99, animation: "scan 1.3s ease-in-out infinite" }} />
    </div>
  );
}

/** The discovered-object grid + behaviors a scanned source surfaces. */
function ScanResult({ src, dataModelName }: { src: DeclaredSource; dataModelName: string }) {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
        {(src.objects ?? []).map((o) => (
          <div key={o.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "5px 9px" }}>
            <span style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>{o.name}</span>
            <span style={{ fontFamily: MONO, fontSize: 11.5, color: "var(--fg)" }}>{o.count.toLocaleString()}</span>
          </div>
        ))}
      </div>
      {(src.behaviors ?? []).length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "color-mix(in oklch, var(--violet), transparent 92%)", border: "1px solid color-mix(in oklch, var(--violet), transparent 80%)", borderRadius: "var(--r-sm)", padding: "6px 10px" }}>
          <span style={{ fontFamily: MONO, fontSize: 9, letterSpacing: ".06em", color: "var(--violet)" }}>BEHAVIORS</span>
          {(src.behaviors ?? []).map((b) => <span key={b.label} style={{ fontSize: 11.5, color: "var(--fg-muted)" }}>⚙ {b.label}</span>)}
        </div>
      )}
      <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--violet)" }}>→ feeds the «{dataModelName}» Data Model</div>
    </>
  );
}

/** One declared source's collapsible card — header + a spec/state-driven body. */
export function SourceCard({
  src, dataModelName, expanded, revealed, secrets,
  onToggle, onField, onSecret, onReveal, onEnv, onConnect, onRetry, onRemove,
}: {
  src: DeclaredSource;
  dataModelName: string;
  expanded: boolean;
  revealed: boolean;
  secrets: Record<string, string>;
  onToggle: () => void;
  onField: (key: string, v: string) => void;
  onSecret: (key: string, v: string) => void;
  onReveal: (key: string) => void;
  onEnv: (env: "production" | "sandbox") => void;
  onConnect: () => void;
  onRetry: () => void;
  onRemove: () => void;
}) {
  const c = connector(src.connectorId);
  const spec = c.spec;
  const connected = isConnected(src);
  const borderColor = src.status === "error" ? "color-mix(in oklch, var(--danger), transparent 62%)"
    : src.status === "scanned" ? "var(--border-soft)"
    : src.status === "declared" ? "color-mix(in oklch, var(--accent), transparent 72%)"
    : "color-mix(in oklch, var(--accent), transparent 64%)";

  // Connectable once every required (non-optional) field has a value — secrets from local state.
  const filled = (f: SpecField) => f.optional || (f.secret ? !!secrets[f.key]?.trim() : !!src.fields[f.key]?.trim());
  const canConnect = spec.auth === "oauth" || spec.auth === "upload" || spec.fields.every(filled);

  return (
    <div data-testid={`source-card-${src.uid}`} style={{ background: "var(--bg-panel)", border: `1px solid ${borderColor}`, borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      {/* header */}
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 13px", background: "var(--bg-elev)", cursor: "pointer" }}>
        <span style={{ width: 8, height: 8, borderRadius: 99, flex: "0 0 8px", background: STATUS_DOT[src.status], animation: (src.status === "connecting" || src.status === "scanning") ? "pulse 1.2s ease-in-out infinite" : undefined }} />
        <Badge text={c.badge} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.name}{src.instance && <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)", fontWeight: 400 }}> · {src.instance}</span>}
        </span>
        {src.status === "error" ? (
          <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 88%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 72%)", borderRadius: 99, padding: "2px 7px" }}>FAILED</span>
        ) : <ReadOnlyPill />}
        <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>{expanded ? "▾" : "▸"}</span>
      </div>

      {expanded && (
        <div style={{ padding: "12px 13px", display: "flex", flexDirection: "column", gap: 10 }}>
          {/* declared / not connected → the spec-driven connect form */}
          {src.status === "declared" && (
            <>
              <InfoChip>🛡 Credentials stay on this device — the planning agent never sees them</InfoChip>
              {spec.auth === "oauth" ? (
                <>
                  <button data-testid={`connect-${src.uid}`} onClick={onConnect} style={{
                    alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 9, fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600,
                    color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 91%)", border: "1px solid var(--accent-dim)", borderRadius: "var(--r-md)", padding: "10px 16px", cursor: "pointer",
                  }}>⟳ {spec.oauthLabel} ↗</button>
                  {spec.envs && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                      <span style={grpLabel}>environment</span>
                      <div style={{ display: "flex", gap: 7 }}>
                        {(["production", "sandbox"] as const).map((env) => {
                          const on = (src.env ?? "production") === env;
                          return (
                            <button key={env} onClick={() => onEnv(env)} style={{
                              fontFamily: MONO, fontSize: 11, cursor: "pointer", borderRadius: "var(--r-sm)", padding: "5px 11px",
                              color: on ? "var(--fg)" : "var(--fg-dim)", background: on ? "var(--bg-elev2)" : "var(--bg-elev)", border: "1px solid " + (on ? "var(--border)" : "var(--border-soft)"),
                            }}>{on ? "◉" : "○"} {env[0].toUpperCase() + env.slice(1)}</button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </>
              ) : spec.auth === "upload" ? (
                <button data-testid={`connect-${src.uid}`} onClick={onConnect} style={{
                  alignSelf: "flex-start", fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--accent)",
                  background: "color-mix(in oklch, var(--accent), transparent 91%)", border: "1px solid var(--accent-dim)", borderRadius: "var(--r-md)", padding: "9px 15px", cursor: "pointer",
                }}>Choose file… ↗</button>
              ) : (
                <>
                  {spec.fields.map((f) => f.secret ? (
                    <SecretField key={f.key} field={f} value={secrets[f.key] ?? ""} revealed={revealed} onChange={(v) => onSecret(f.key, v)} onReveal={() => onReveal(f.key)} testid={`secret-${src.uid}`} />
                  ) : (
                    <Field key={f.key} field={f} value={src.fields[f.key] ?? ""} onChange={(v) => onField(f.key, v)} />
                  ))}
                  <button data-testid={`connect-${src.uid}`} onClick={onConnect} disabled={!canConnect} style={{
                    alignSelf: "flex-start", fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "oklch(0.20 0.04 70)",
                    background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "8px 15px", cursor: canConnect ? "pointer" : "not-allowed", opacity: canConnect ? 1 : 0.45,
                  }}>Save &amp; connect →</button>
                </>
              )}
              <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5, borderTop: "1px dashed var(--border-soft)", paddingTop: 9 }}>
                will contribute → {spec.contributes}
              </div>
            </>
          )}

          {/* connecting / validating */}
          {src.status === "connecting" && (
            <>
              <div style={{ fontSize: 12.5, color: "var(--accent)" }}>Validating {c.name} credentials…</div>
              <ScanBar />
              <div style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>checking scopes · read-only</div>
            </>
          )}

          {/* connected + scanning */}
          {src.status === "scanning" && (
            <>
              <InfoChip color="var(--success)">🔑 saved to keychain</InfoChip>
              {src.handle && <InfoChip>↗ planner sees: «{src.handle}»</InfoChip>}
              <div style={{ fontSize: 12.5, color: "var(--accent)" }}>scanning… discovering objects</div>
              <ScanBar />
            </>
          )}

          {/* connected (scanned) */}
          {src.status === "scanned" && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <InfoChip color="var(--success)">🔑 saved to keychain</InfoChip>
                {src.handle && <InfoChip>↗ shared: «{src.handle}»</InfoChip>}
              </div>
              <ScanResult src={src} dataModelName={dataModelName} />
            </>
          )}

          {/* error / auth failed */}
          {src.status === "error" && (
            <>
              <div style={{ background: "color-mix(in oklch, var(--danger), transparent 92%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 78%)", borderRadius: "var(--r-md)", padding: "8px 10px", display: "flex", flexDirection: "column", gap: 3 }}>
                <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--danger)" }}>✕ {src.error ?? "connection failed"}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>check the connection details and try again</span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button data-testid={`retry-${src.uid}`} onClick={onRetry} style={{ fontFamily: "var(--sans)", fontSize: 11, fontWeight: 600, color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 90%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 72%)", borderRadius: "var(--r-md)", padding: "5px 12px", cursor: "pointer" }}>↻ retry</button>
                <button onClick={onRemove} style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg-dim)", background: "transparent", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "5px 12px", cursor: "pointer" }}>remove source</button>
              </div>
              <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>⚠ gate held until resolved</span>
            </>
          )}

          {/* a connected source can always be removed (collapsed footer affordance) */}
          {connected && (
            <button onClick={onRemove} style={{ alignSelf: "flex-start", fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", background: "transparent", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "3px 10px", cursor: "pointer" }}>remove source</button>
          )}
        </div>
      )}
    </div>
  );
}
