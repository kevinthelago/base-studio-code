// connectorForm — the spec-driven connector form + per-source card for SourceBody (#1637).
//
// Split out of SourceBody.tsx: every PURE presentational piece that renders a declared
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
  type DeclaredSource, type SpecField, type SourceStatus, type RuntimeConnectorView,
} from "../lib/sourceConfig";
import { MONO, grpLabel } from "./bodyStyles";
import { Chip } from "@/shared/ui/data/Chip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

export const STATUS_DOT: Record<SourceStatus, string> = {
  declared: "var(--fg-dim)",
  connecting: "var(--accent)",
  scanning: "var(--accent)",
  scanned: "var(--success)",
  error: "var(--danger)",
};

/** READ-ONLY badge — every source is read-only; the design repeats this as the core reassurance.
 *  Folded onto the shared color-mix Chip (#2160) — same shape as InfoChip below. */
function ReadOnlyPill() {
  return (
    <Chip color="var(--success)" fontSize={9} padding="2px 7px" borderAlpha={74} style={{ whiteSpace: "nowrap" }}>READ-ONLY</Chip>
  );
}

/** A small mono badge tile, e.g. "QB". */
function Badge({ text }: { text: string }) {
  return (
    <Box as="span" pad={[2, 5]} bg="var(--bg-canvas)" border radius="sm" style={{
      fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)", whiteSpace: "nowrap",
    }}>{text}</Box>
  );
}

/** A labeled, non-secret text field — its value is persisted into the source's config. */
function Field({ field, value, onChange }: { field: SpecField; value: string; onChange: (v: string) => void }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <Text as="span" mono size={10} tone="muted">
        {field.label}{field.optional && <Text as="span" tone="dim"> · optional{field.hint ? `, ${field.hint}` : ""}</Text>}
      </Text>
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled field input (local Field component; not the shared .input/.field) */}
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
      <Text as="span" mono size={10} tone="muted">
        {field.label} <Text as="span" tone="accent">●</Text> <Text as="span" tone="dim">secret</Text>
      </Text>
      <Row gap={8}>
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled secret input (masked, keychain-bound; not the shared .input) */}
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
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled reveal toggle (custom dimensions, no .icon-btn hover state) */}
        <button
          onClick={onReveal} title={revealed ? "Hide" : "Reveal"} aria-label={`${revealed ? "Hide" : "Reveal"} ${field.label}`}
          style={{
            width: 34, height: 32, flex: "0 0 34px", display: "flex", alignItems: "center", justifyContent: "center",
            background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", cursor: "pointer", fontSize: 13,
          }}
        >👁</button>
      </Row>
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
    <Box bg="var(--bg-elev)" radius={99} style={{ height: 5, overflow: "hidden", position: "relative" }}>
      <Box bg="var(--accent)" radius={99} style={{ position: "absolute", top: 0, left: 0, height: "100%", width: "30%", animation: "scan 1.3s ease-in-out infinite" }} />
    </Box>
  );
}

/** The discovered-object grid + behaviors a scanned source surfaces. */
function ScanResult({ src, dataModelName }: { src: DeclaredSource; dataModelName: string }) {
  return (
    <>
      <Grid cols={2} gap={6}>
        {(src.objects ?? []).map((o) => (
          <Row key={o.name} justify="between" style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "5px 9px" }}>
            <Text as="span" size={11.5} tone="muted">{o.name}</Text>
            <Text as="span" mono size={11.5} style={{ color: "var(--fg)" }}>{o.count.toLocaleString()}</Text>
          </Row>
        ))}
      </Grid>
      {(src.behaviors ?? []).length > 0 && (
        <Row gap={8} wrap style={{ background: "color-mix(in oklch, var(--violet), transparent 92%)", border: "1px solid color-mix(in oklch, var(--violet), transparent 80%)", borderRadius: "var(--r-sm)", padding: "6px 10px" }}>
          <Text as="span" mono size={9} style={{ letterSpacing: ".06em", color: "var(--violet)" }}>BEHAVIORS</Text>
          {(src.behaviors ?? []).map((b) => <Text as="span" key={b.label} size={11.5} tone="muted">⚙ {b.label}</Text>)}
        </Row>
      )}
      <Text as="div" mono size={10} style={{ color: "var(--violet)" }}>→ feeds the «{dataModelName}» Data Model</Text>
    </>
  );
}

/** One declared source's collapsible card — header + a spec/state-driven body. */
export function SourceCard({
  src, runtime, dataModelName, expanded, revealed, secrets,
  onToggle, onField, onSecret, onReveal, onEnv, onConnect, onRetry, onRemove,
}: {
  src: DeclaredSource;
  /** Agent-authored runtime connector list (#1980) — resolves the source's real connector identity. */
  runtime?: readonly RuntimeConnectorView[];
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
  const c = connector(src.connectorId, runtime);
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
    <Box data-testid={`source-card-${src.uid}`} bg="var(--bg-panel)" radius="lg" style={{ border: `1px solid ${borderColor}`, overflow: "hidden" }}>
      {/* header */}
      <Row onClick={onToggle} gap={9} style={{ padding: "11px 13px", background: "var(--bg-elev)", cursor: "pointer" }}>
        <Box as="span" bg={STATUS_DOT[src.status]} radius={99} style={{ width: 8, height: 8, flex: "0 0 8px", animation: (src.status === "connecting" || src.status === "scanning") ? "pulse 1.2s ease-in-out infinite" : undefined }} />
        <Badge text={c.badge} />
        <Box as="span" style={{ fontSize: 13.5, fontWeight: 600, color: "var(--fg)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {c.name}{src.instance && <Text as="span" mono size={10.5} tone="muted" weight={400}> · {src.instance}</Text>}
        </Box>
        {src.status === "error" ? (
          <Box as="span" pad={[2, 7]} bg="color-mix(in oklch, var(--danger), transparent 88%)" radius={99} style={{ fontFamily: MONO, fontSize: 9, color: "var(--danger)", border: "1px solid color-mix(in oklch, var(--danger), transparent 72%)"}}>FAILED</Box>
        ) : <ReadOnlyPill />}
        <Text as="span" tone="dim" size={11}>{expanded ? "▾" : "▸"}</Text>
      </Row>

      {expanded && (
        <Stack gap={10} style={{ padding: "12px 13px" }}>
          {/* declared / not connected → the spec-driven connect form */}
          {src.status === "declared" && (
            <>
              <InfoChip>🛡 Credentials stay on this device — the planning agent never sees them</InfoChip>
              {spec.auth === "oauth" ? (
                <>
                  {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled OAuth connect button */}
                  <button data-testid={`connect-${src.uid}`} onClick={onConnect} style={{
                    alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 9, fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600,
                    color: "var(--accent)", background: "color-mix(in oklch, var(--accent), transparent 91%)", border: "1px solid var(--accent-dim)", borderRadius: "var(--r-md)", padding: "10px 16px", cursor: "pointer",
                  }}>⟳ {spec.oauthLabel} ↗</button>
                  {spec.envs && (
                    <Stack gap={5}>
                      <Box as="span" style={grpLabel}>environment</Box>
                      <Row gap={7} align="stretch">
                        {(["production", "sandbox"] as const).map((env) => {
                          const on = (src.env ?? "production") === env;
                          return (
                            // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled environment toggle
                            <button key={env} onClick={() => onEnv(env)} style={{
                              fontFamily: MONO, fontSize: 11, cursor: "pointer", borderRadius: "var(--r-sm)", padding: "5px 11px",
                              color: on ? "var(--fg)" : "var(--fg-dim)", background: on ? "var(--bg-elev2)" : "var(--bg-elev)", border: "1px solid " + (on ? "var(--border)" : "var(--border-soft)"),
                            }}>{on ? "◉" : "○"} {env[0].toUpperCase() + env.slice(1)}</button>
                          );
                        })}
                      </Row>
                    </Stack>
                  )}
                </>
              ) : spec.auth === "upload" ? (
                // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled upload connect button
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
                  {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled save-and-connect button */}
                  <button data-testid={`connect-${src.uid}`} onClick={onConnect} disabled={!canConnect} style={{
                    alignSelf: "flex-start", fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "oklch(0.20 0.04 70)",
                    background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "8px 15px", cursor: canConnect ? "pointer" : "not-allowed", opacity: canConnect ? 1 : 0.45,
                  }}>Save &amp; connect →</button>
                </>
              )}
              <Box style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5, borderTop: "1px dashed var(--border-soft)", paddingTop: 9 }}>
                will contribute → {spec.contributes}
              </Box>
            </>
          )}

          {/* connecting / validating */}
          {src.status === "connecting" && (
            <>
              <Text as="div" size={12.5} tone="accent">Validating {c.name} credentials…</Text>
              <ScanBar />
              <Text as="div" mono size={9} tone="dim">checking scopes · read-only</Text>
            </>
          )}

          {/* connected + scanning */}
          {src.status === "scanning" && (
            <>
              <InfoChip color="var(--success)">🔑 saved to keychain</InfoChip>
              {src.handle && <InfoChip>↗ planner sees: «{src.handle}»</InfoChip>}
              <Text as="div" size={12.5} tone="accent">scanning… discovering objects</Text>
              <ScanBar />
            </>
          )}

          {/* connected (scanned) */}
          {src.status === "scanned" && (
            <>
              <Row gap={8} wrap>
                <InfoChip color="var(--success)">🔑 saved to keychain</InfoChip>
                {src.handle && <InfoChip>↗ shared: «{src.handle}»</InfoChip>}
              </Row>
              <ScanResult src={src} dataModelName={dataModelName} />
            </>
          )}

          {/* error / auth failed */}
          {src.status === "error" && (
            <>
              <Stack gap={3} style={{ background: "color-mix(in oklch, var(--danger), transparent 92%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 78%)", borderRadius: "var(--r-md)", padding: "8px 10px" }}>
                <Text as="span" mono size={10.5} tone="danger">✕ {src.error ?? "connection failed"}</Text>
                <Text as="span" mono size={9} tone="dim">check the connection details and try again</Text>
              </Stack>
              <Row gap={8} align="stretch">
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled retry button */}
                <button data-testid={`retry-${src.uid}`} onClick={onRetry} style={{ fontFamily: "var(--sans)", fontSize: 11, fontWeight: 600, color: "var(--danger)", background: "color-mix(in oklch, var(--danger), transparent 90%)", border: "1px solid color-mix(in oklch, var(--danger), transparent 72%)", borderRadius: "var(--r-md)", padding: "5px 12px", cursor: "pointer" }}>↻ retry</button>
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled remove-source button */}
                <button onClick={onRemove} style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg-dim)", background: "transparent", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "5px 12px", cursor: "pointer" }}>remove source</button>
              </Row>
              <Text as="span" mono size={9} tone="dim">⚠ gate held until resolved</Text>
            </>
          )}

          {/* a connected source can always be removed (collapsed footer affordance) */}
          {connected && (
            // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled remove-source affordance
            <button onClick={onRemove} style={{ alignSelf: "flex-start", fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", background: "transparent", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "3px 10px", cursor: "pointer" }}>remove source</button>
          )}
        </Stack>
      )}
    </Box>
  );
}
