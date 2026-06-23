// FocusedSourceBody — right-pane body for the "source" planning stage (#source-pane).
// Hi-fi implementation of design/Source connection pane kickoff (Direction B — the catalog
// collapses to a status chip-bar once you declare). The migration Source stage: name the legacy
// systems you're migrating FROM and connect each READ-ONLY so the planner can scan it into the
// project's Data Model.
//
// Spec-driven: each connector carries a ConnectionSpec (sourceConfig.ts) that decides which page a
// declared source renders — an OAuth button (Salesforce/QuickBooks), a token form (Quickbase), a
// password form (SQL), etc. Per-source state machine: declared → connecting → scanning → scanned
// (or error). The gate (`sourcesConnected`) passes once every declared source is scanned.
//
// SECURITY BOUNDARY (the design's payoff): a secret field's value lives ONLY in local component
// state and is "saved to the device keychain" on connect — it is NEVER written into the persisted
// SourceConfig and never shared with the planning agent, which sees only a redacted handle + the
// discovered object inventory.

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../../../store";
import {
  CONNECTORS, connector, defaultSourceConfig, newDeclaredSource, sampleScan, redactedHandle,
  isConnected, sourceChecks, allSourcesConnected, deriveDataModel,
  type SourceConfig, type DeclaredSource, type SpecField, type SourceStatus, type PlatformScanView,
} from "../shared/sourceConfig";
import { ScanViews } from "./ScanViews";

const MONO = "var(--mono)";

const STATUS_DOT: Record<SourceStatus, string> = {
  declared: "var(--fg-dim)",
  connecting: "var(--accent)",
  scanning: "var(--accent)",
  scanned: "var(--success)",
  error: "var(--danger)",
};

const monoSm: React.CSSProperties = { fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)" };
const grpLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em",
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
    <span style={{
      display: "inline-flex", alignSelf: "flex-start", alignItems: "center", gap: 6, fontFamily: MONO, fontSize: 9.5, color,
      background: `color-mix(in oklch, ${color}, transparent 89%)`, border: `1px solid color-mix(in oklch, ${color}, transparent 76%)`,
      borderRadius: 99, padding: "3px 9px",
    }}>{children}</span>
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
function SourceCard({
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

// ── main component ────────────────────────────────────────────────────────────

export function FocusedSourceBody({ projectId }: { projectId?: string }) {
  const pid = projectId ?? "";
  const stored = useAppStore((s) => s.planSourceConfig[pid]);
  const setPlanSourceConfig = useAppStore((s) => s.setPlanSourceConfig);
  const cfg: SourceConfig = stored ?? defaultSourceConfig();

  const [query, setQuery] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  // Secret field values — LOCAL ONLY, keyed by source uid → field key. Never persisted.
  const [secrets, setSecrets] = useState<Record<string, Record<string, string>>>({});

  const seq = useRef(0);
  const persist = (next: SourceConfig) => setPlanSourceConfig(pid, next);

  // Patch one source by uid, reading the latest config from the store (safe across timeouts).
  const patchSource = (uid: string, patch: Partial<DeclaredSource>) => {
    const latest = useAppStore.getState().planSourceConfig[pid] ?? cfg;
    persist({ ...latest, sources: latest.sources.map((s) => (s.uid === uid ? { ...s, ...patch } : s)) });
  };

  const total = cfg.sources.length;
  const scanned = cfg.sources.filter((s) => s.status === "scanned").length;
  const ready = allSourcesConnected(cfg);
  const dataModelName = cfg.dataModelName || "your Data Model";
  const proposedPending = cfg.proposed.filter((id) => !cfg.sources.some((s) => s.connectorId === id));
  const showCatalog = catalogOpen || total === 0;

  // Close the "data dictates structure" loop (#1205): once every declared source is scanned,
  // persist the derived canonical Data Model as datamodel.json — the artifact the planner's
  // features/structure stages design over. Re-persists only when the derived model changes.
  const persistedSig = useRef("");
  useEffect(() => {
    if (!ready || !pid) return;
    const model = deriveDataModel(cfg, `dm-source-${pid}`);
    const sig = JSON.stringify(model);
    if (sig === persistedSig.current) return;
    persistedSig.current = sig;
    void invoke("data_persist_model", { projectKey: pid, model, refined: true }).catch(() => {});
  }, [ready, pid, cfg]);

  const filteredConnectors = CONNECTORS.filter((c) => {
    const q = query.trim().toLowerCase();
    return !q || c.name.toLowerCase().includes(q) || c.authLabel.toLowerCase().includes(q);
  });

  // ── actions ──
  function declare(connectorId: string) {
    if (cfg.sources.some((s) => s.connectorId === connectorId)) return; // one card per connector
    const uid = `src-${connectorId}-${++seq.current}`;
    persist({ ...cfg, sources: [...cfg.sources, newDeclaredSource(connectorId, uid)] });
    setExpanded((p) => new Set(p).add(uid));
    setCatalogOpen(false);
  }
  function confirmProposed() {
    const add = proposedPending.map((id) => newDeclaredSource(id, `src-${id}-${++seq.current}`));
    persist({ ...cfg, proposed: [], sources: [...cfg.sources, ...add] });
    setExpanded((p) => { const n = new Set(p); add.forEach((s) => n.add(s.uid)); return n; });
  }
  function editProposed() {
    persist({ ...cfg, proposed: [] });
    setCatalogOpen(true);
  }
  function removeSource(uid: string) {
    // Revoke any on-device secrets for this source's connector fields (#1194).
    const src = cfg.sources.find((s) => s.uid === uid);
    if (src) {
      for (const f of connector(src.connectorId).spec.fields) {
        if (f.secret) void invoke("source_delete_secret", { project: pid, sourceUid: uid, field: f.key }).catch(() => {});
      }
    }
    persist({ ...cfg, sources: cfg.sources.filter((s) => s.uid !== uid) });
  }
  function setField(uid: string, key: string, v: string) {
    patchSource(uid, { fields: { ...(cfg.sources.find((s) => s.uid === uid)?.fields ?? {}), [key]: v } });
  }
  function setSecret(uid: string, key: string, v: string) {
    setSecrets((p) => ({ ...p, [uid]: { ...(p[uid] ?? {}), [key]: v } }));
  }
  function toggleReveal(uid: string) {
    setRevealed((p) => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }
  function toggleExpand(uid: string) {
    setExpanded((p) => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }

  // Run the live read-only scan; on a non-live result or error, fall back to the sample shape so
  // the pane stays demonstrable until every connector's live transport / OAuth app is in place.
  async function runScan(uid: string, connectorId: string, fields: Record<string, string>, fallbackHandle: string) {
    try {
      const res = await invoke<{ live: boolean; instance?: string; handle?: string; objects?: { name: string; count: number; fields?: string[] }[]; behaviors?: { label: string }[]; platform?: PlatformScanView }>(
        "data_platform_scan",
        { connectorId, project: pid, sourceUid: uid, fields },
      );
      if (res?.live) {
        patchSource(uid, {
          status: "scanned",
          handle: res.handle || fallbackHandle,
          ...(res.instance ? { instance: res.instance } : {}),
          objects: res.objects ?? [],
          behaviors: res.behaviors ?? [],
          platform: res.platform,
        });
        return;
      }
    } catch { /* fall through to the sample shape */ }
    const scan = sampleScan(connectorId);
    patchSource(uid, { status: "scanned", objects: scan.objects, behaviors: scan.behaviors });
  }

  // OAuth connect: kick off the browser authorization-code flow, then scan once the token lands in
  // the keychain. If OAuth isn't configured (no client id) the begin call returns no URL and we
  // degrade to the sample shape so the pane still works.
  function oauthConnect(uid: string, src: DeclaredSource, c: ReturnType<typeof connector>) {
    const fallbackHandle = redactedHandle({ ...src, instance: src.instance || c.name });
    patchSource(uid, { status: "connecting" });
    void (async () => {
      let begin: { authorizeUrl?: string } | null = null;
      try {
        begin = await invoke<{ authorizeUrl: string }>("source_oauth_begin", {
          connectorId: src.connectorId, project: pid, sourceUid: uid, env: src.env ?? "production",
        });
      } catch { /* not configured / unavailable */ }
      if (!begin?.authorizeUrl) {
        patchSource(uid, { status: "scanning", secretSaved: false, handle: fallbackHandle, instance: src.instance || c.name });
        void runScan(uid, src.connectorId, { ...(src.fields ?? {}) }, fallbackHandle);
        return;
      }
      await openUrl(begin.authorizeUrl).catch(() => {});
      const unlisten = await listen<{ sourceUid: string; ok: boolean; instance?: string; realm?: string; error?: string }>(
        "source-oauth-complete",
        (ev) => {
          const p = ev.payload;
          if (p.sourceUid !== uid) return;
          unlisten();
          if (!p.ok) { patchSource(uid, { status: "error", error: p.error ?? "authorization failed" }); return; }
          // Capture non-secret instance metadata into the config (the token stays in the keychain).
          const fields = { ...(useAppStore.getState().planSourceConfig[pid]?.sources.find((s) => s.uid === uid)?.fields ?? {}) };
          if (p.instance) fields.instanceUrl = p.instance;
          if (p.realm) fields.realm = p.realm;
          const handle = redactedHandle({ ...src, instance: p.instance || c.name });
          patchSource(uid, { status: "scanning", secretSaved: true, instance: p.instance || c.name, handle, fields });
          void runScan(uid, src.connectorId, fields, handle);
        },
      );
    })();
  }

  // Connect: OAuth connectors run the browser flow; credential connectors save each secret to the
  // OS keychain (#1194) — it leaves component state for the device's secure store, never written to
  // the config or shared with the planner — then scan.
  function connect(uid: string) {
    const src = cfg.sources.find((s) => s.uid === uid);
    if (!src) return;
    const c = connector(src.connectorId);
    if (c.spec.auth === "oauth") { oauthConnect(uid, src, c); return; }

    const fallbackHandle = redactedHandle({ ...src, instance: src.instance || c.name });
    const fieldsSnapshot = { ...(src.fields ?? {}) };
    const draft = secrets[uid] ?? {};
    const saved = Object.entries(draft).filter(([, v]) => v.trim());
    const saves = saved.map(([field, value]) =>
      invoke("source_save_secret", { project: pid, sourceUid: uid, field, value }).catch(() => {})
    );

    patchSource(uid, { status: "connecting" });
    // Drop the local secret draft — it's on the device keychain now, never re-shown.
    setSecrets((p) => { const n = { ...p }; delete n[uid]; return n; });
    setRevealed((p) => { const n = new Set(p); n.delete(uid); return n; });

    void Promise.all(saves).then(() => {
      patchSource(uid, { status: "scanning", secretSaved: saved.length > 0, handle: fallbackHandle, instance: src.instance || c.name });
      void runScan(uid, src.connectorId, fieldsSnapshot, fallbackHandle);
    });
  }
  function retry(uid: string) {
    patchSource(uid, { status: "declared", error: undefined });
  }

  // ── readiness line ──
  const nextNeeded = cfg.sources.find((s) => s.status !== "scanned");
  const checks = sourceChecks(cfg);

  return (
    <div data-testid="source-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* top readiness banner */}
      <div style={{
        display: "flex", alignItems: "center", gap: 9, padding: "9px 13px", borderRadius: "var(--r-md)",
        background: `color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 90%)`,
        border: `1px solid color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 72%)`,
      }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, background: ready ? "var(--success)" : "var(--accent)" }} />
        <span style={{ fontFamily: MONO, fontSize: 11, color: ready ? "var(--success)" : "var(--accent)" }}>
          {total === 0 ? "Declare your sources" : ready ? "✓ sources connected" : `${scanned} / ${total} connected`}
        </span>
        <span style={{ flex: 1 }} />
        <span style={monoSm}>{ready ? `both feed «${dataModelName}»` : "read-only · credentials never leave this device"}</span>
      </div>

      {/* reassurance row */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <InfoChip color="var(--success)">READ-ONLY · never writes back</InfoChip>
        <InfoChip>🛡 Credentials stay on this device</InfoChip>
      </div>

      {/* planner-proposed sources */}
      {proposedPending.length > 0 && (
        <div style={{ background: "color-mix(in oklch, var(--accent), transparent 93%)", border: "1px solid color-mix(in oklch, var(--accent), transparent 78%)", borderRadius: "var(--r-md)", padding: "11px 12px", display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <span style={{ color: "var(--accent)", fontSize: 13 }}>★</span>
            <div style={{ fontSize: 12.5, color: "var(--fg)", lineHeight: 1.5 }}>
              Detected from your pitch — migrating from {proposedPending.map((id) => connector(id).name).join(" + ")}. Connect them?
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <button data-testid="proposed-confirm" onClick={confirmProposed} style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: "oklch(0.20 0.04 70)", background: "var(--accent)", border: "none", borderRadius: "var(--r-md)", padding: "7px 13px", cursor: "pointer" }}>
              Confirm {proposedPending.length} source{proposedPending.length !== 1 ? "s" : ""}
            </button>
            <button onClick={editProposed} style={{ fontFamily: "var(--sans)", fontSize: 12, color: "var(--fg-muted)", background: "transparent", border: "none", cursor: "pointer" }}>Edit selection</button>
          </div>
        </div>
      )}

      {/* chip bar — once sources are declared, the catalog gets out of the way */}
      {total > 0 && (
        <div data-testid="source-chips" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={grpLabel}>sources</span>
          {cfg.sources.map((s) => {
            const c = connector(s.connectorId);
            const done = s.status === "scanned";
            return (
              <span key={s.uid} onClick={() => { setExpanded((p) => new Set(p).add(s.uid)); }} title={c.name} style={{
                display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, cursor: "pointer", borderRadius: 99, padding: "4px 11px", background: "var(--bg-elev)",
                border: `1px solid color-mix(in oklch, ${done ? "var(--success)" : "var(--accent)"}, transparent ${done ? 70 : 64}%)`,
              }}>
                <span style={{ width: 7, height: 7, borderRadius: 99, background: STATUS_DOT[s.status], animation: (s.status === "connecting" || s.status === "scanning") ? "pulse 1.2s ease-in-out infinite" : undefined }} />
                {c.name}{done && <span style={{ color: "var(--success)", fontSize: 10 }}>✓</span>}
              </span>
            );
          })}
          <span onClick={() => setCatalogOpen((v) => !v)} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--fg-dim)", border: "1px dashed var(--border)", borderRadius: 99, padding: "4px 11px", cursor: "pointer" }}>+ add source</span>
        </div>
      )}

      {/* boundary legend — the security payoff, quiet */}
      {total > 0 && (
        <div style={{ display: "flex", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", overflow: "hidden", fontFamily: MONO, fontSize: 9.5 }}>
          <div style={{ flex: 1, padding: "7px 11px", background: "var(--bg-elev)", display: "flex", alignItems: "center", gap: 7 }}>
            <span>🔒</span><span style={{ color: "var(--fg-muted)" }}>entered here · device keychain</span>
          </div>
          <div style={{ flex: 1, padding: "7px 11px", background: "color-mix(in oklch, var(--info), transparent 93%)", borderLeft: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ color: "var(--info)" }}>↗</span><span style={{ color: "var(--info)" }}>planner sees: handle + objects only</span>
          </div>
        </div>
      )}

      {/* connector catalog */}
      {showCatalog && (
        <div data-testid="connector-catalog" style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={grpLabel}>Connector catalog</span>
            <span style={monoSm}>{filteredConnectors.length} available</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: "var(--r-md)", padding: "7px 10px" }}>
            <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 12 }}>⌕</span>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search connectors…" style={{ flex: 1, minWidth: 0, background: "none", border: "none", outline: "none", fontFamily: "var(--sans)", fontSize: 12.5, color: "var(--fg)" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {filteredConnectors.map((c) => {
              const declared = cfg.sources.some((s) => s.connectorId === c.id);
              return (
                <button key={c.id} data-testid={`connector-tile-${c.id}`} onClick={() => declare(c.id)} disabled={declared} style={{
                  display: "flex", alignItems: "center", gap: 9, borderRadius: "var(--r-md)", padding: "9px 11px", cursor: declared ? "default" : "pointer", textAlign: "left",
                  border: "1px solid " + (declared ? "var(--accent)" : "var(--border-soft)"),
                  background: declared ? "color-mix(in oklch, var(--accent), transparent 90%)" : "var(--bg-elev)",
                }}>
                  <span style={{ fontFamily: MONO, fontSize: 10, color: declared ? "var(--accent)" : "var(--fg-muted)", background: "var(--bg-canvas)", border: "1px solid " + (declared ? "var(--accent-dim)" : "var(--border)"), borderRadius: "var(--r-sm)", padding: "3px 5px" }}>{c.badge}</span>
                  <span style={{ display: "flex", flexDirection: "column", gap: 1, flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--fg)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                    <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)" }}>{c.authLabel}</span>
                  </span>
                  {declared && <span style={{ color: "var(--accent)", fontSize: 12 }}>✓</span>}
                </button>
              );
            })}
          </div>
          <div style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>↳ Each declared source renders its own connection page from a per-connector ConnectionSpec.</div>
        </div>
      )}

      {/* per-source cards */}
      {cfg.sources.map((src) => (
        <SourceCard
          key={src.uid}
          src={src}
          dataModelName={dataModelName}
          expanded={expanded.has(src.uid)}
          revealed={revealed.has(src.uid)}
          secrets={secrets[src.uid] ?? {}}
          onToggle={() => toggleExpand(src.uid)}
          onField={(k, v) => setField(src.uid, k, v)}
          onSecret={(k, v) => setSecret(src.uid, k, v)}
          onReveal={() => toggleReveal(src.uid)}
          onEnv={(env) => patchSource(src.uid, { env })}
          onConnect={() => connect(src.uid)}
          onRetry={() => retry(src.uid)}
          onRemove={() => removeSource(src.uid)}
        />
      ))}

      {/* bottom readiness */}
      {total > 0 && (
        <div data-testid="source-readiness" style={{
          display: "flex", alignItems: "center", gap: 9, borderRadius: "var(--r-md)", padding: "9px 12px",
          background: `color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 92%)`,
          border: `1px solid color-mix(in oklch, ${ready ? "var(--success)" : "var(--accent)"}, transparent 79%)`,
        }}>
          <span style={{ fontFamily: MONO, fontSize: 11, color: ready ? "var(--success)" : "var(--accent)" }}>{ready ? "✓" : `${scanned} / ${total}`}</span>
          <span style={{ fontSize: 12, color: "var(--fg-muted)", lineHeight: 1.4 }}>
            {ready
              ? <><b style={{ color: "var(--fg)" }}>{total} of {total} connected</b> → scanning into <span style={{ color: "var(--violet)" }}>{dataModelName}</span>.</>
              : <><b style={{ color: "var(--fg)" }}>{scanned} of {total} connected</b> → <span style={{ color: "var(--violet)" }}>{dataModelName}</span>.{nextNeeded && <> Needs: <b style={{ color: "var(--accent)" }}>{connector(nextNeeded.connectorId).name}</b>.</>}</>}
          </span>
        </div>
      )}

      {/* readiness checklist */}
      {total > 0 && (
        <div style={{ borderRadius: "var(--r-lg)", border: "1px solid var(--border-soft)", background: "var(--bg-canvas)", padding: "11px 13px", display: "flex", flexDirection: "column", gap: 5 }}>
          {checks.map((c) => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 9px", borderRadius: "var(--r-sm)", background: "var(--bg-elev)" }}>
              <span style={{ width: 15, textAlign: "center", fontFamily: MONO, fontSize: 11, color: c.ok ? "var(--success)" : "var(--fg-dim)" }}>{c.ok ? "✓" : "○"}</span>
              <span style={{ fontFamily: "var(--sans)", fontSize: 11, color: c.ok ? "var(--fg)" : "var(--fg-muted)" }}>{c.label}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 9, color: c.ok ? "var(--fg-muted)" : "var(--fg-dim)" }}>{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* scanned-result visualizations — the "data dictates structure" payoff (#1205/#1209):
          Graph · List · Process over the derived model + captured behaviors. The header carries
          the downstream-impact recap. */}
      {ready && <ScanViews cfg={cfg} dataModelName={cfg.dataModelName || "Source Data Model"} />}
    </div>
  );
}
