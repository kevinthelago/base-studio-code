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
// This is the lean container: it owns the catalog + proposal + readiness UI and wires the per-source
// connection FSM (sourceConnection.ts) into the presentational cards (connectorForm.tsx).
//
// SECURITY BOUNDARY (the design's payoff): a secret field's value lives ONLY in local component
// state and is "saved to the device keychain" on connect — it is NEVER written into the persisted
// SourceConfig and never shared with the planning agent, which sees only a redacted handle + the
// discovered object inventory.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { Banner } from "@/shared/ui/Banner";
import {
  CONNECTORS, connector, defaultSourceConfig, newDeclaredSource, sourceChecks, allSourcesConnected,
  deriveDataModel, presetToConnector, registerPresetConnectors, proposeFromPitch,
  type SourceConfig, type Connector, type ConnectorCatalogEntry,
} from "../lib/sourceConfig";
import { ScanViews } from "./ScanViews";
import { MONO, grpLabel, monoSm } from "./bodyStyles";
import { STATUS_DOT, SourceCard } from "./connectorForm";
import { useSourceConnection } from "./sourceConnection";

// ── main component ────────────────────────────────────────────────────────────

export function FocusedSourceBody({ projectId }: { projectId?: string }) {
  const pid = projectId ?? "";
  const stored = useAppStore((s) => s.planSourceConfig[pid]);
  const setPlanSourceConfig = useAppStore((s) => s.setPlanSourceConfig);
  const planningPitch = useAppStore((s) => s.planningPitch);
  const cfg: SourceConfig = stored ?? defaultSourceConfig();

  // Seed the "Confirm N sources" banner from the planner's pitch (#1349): on first open of a fresh
  // config (nothing declared, nothing already proposed), scan the pitch for mentioned legacy systems
  // and stage them as `proposed`. The existing banner + `confirmProposed` then declare them on a
  // single click. Guarded per-project so re-renders and a later user edit (clearing `proposed`)
  // don't re-seed.
  const seededRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!pid || seededRef.current.has(pid)) return;
    if ((stored?.sources.length ?? 0) > 0 || (stored?.proposed.length ?? 0) > 0) {
      seededRef.current.add(pid); // already declared/proposed — don't override
      return;
    }
    const ids = proposeFromPitch(planningPitch);
    seededRef.current.add(pid);
    if (ids.length === 0) return;
    const base = stored ?? defaultSourceConfig();
    setPlanSourceConfig(pid, { ...base, proposed: ids });
  }, [pid, planningPitch, stored, setPlanSourceConfig]);

  const [query, setQuery] = useState("");
  const [catalogOpen, setCatalogOpen] = useState(false);
  // Packaged vendor presets from the backend catalog (#1288) — the 100+ generic-REST integrations
  // beyond the dedicated connectors. Loaded once; turned into generic-REST Connectors.
  const [presetConnectors, setPresetConnectors] = useState<Connector[]>([]);
  useEffect(() => {
    let alive = true;
    invoke<ConnectorCatalogEntry[]>("data_connector_catalog")
      .then((entries) => {
        if (!alive) return;
        const list = entries.map(presetToConnector);
        registerPresetConnectors(list); // so connector(id) resolves a declared preset's connect spec
        setPresetConnectors(list);
      })
      .catch(() => { /* source-stage off or backend unavailable — dedicated connectors still show */ });
    return () => { alive = false; };
  }, []);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const seq = useRef(0);
  const persist = (next: SourceConfig) => setPlanSourceConfig(pid, next);

  // Per-source connection FSM + secret-masking state (declared → connecting → scanning → scanned).
  const { secrets, revealed, patchSource, setField, setSecret, toggleReveal, connect, retry, revokeSecrets } =
    useSourceConnection(pid, cfg, persist);

  const total = cfg.sources.length;
  const scanned = cfg.sources.filter((s) => s.status === "scanned").length;
  const ready = allSourcesConnected(cfg);
  const dataModelName = cfg.dataModelName || "your Data Model";
  const proposedPending = cfg.proposed.filter((id) => !cfg.sources.some((s) => s.connectorId === id));
  const showCatalog = catalogOpen || total === 0;

  // Close the "data dictates structure" loop (#1205): once every declared source is scanned,
  // persist the derived canonical Data Model to the project's DuckDB store (#1446) — what the planner's
  // features/structure stages design over. Re-persists only when the derived model changes.
  const persistedSig = useRef("");
  useEffect(() => {
    if (!ready || !pid) return;
    const model = deriveDataModel(cfg, `dm-source-${pid}`);
    const sig = JSON.stringify(model);
    if (sig === persistedSig.current) return;
    persistedSig.current = sig;
    fireInvoke("data_persist_model", { projectKey: pid, model, refined: true });
  }, [ready, pid, cfg]);

  // The full catalog (#1288): the dedicated connectors (rich connect specs) + every packaged vendor
  // preset, deduped by id (a dedicated connector wins over a same-id preset). Search matches the
  // name, auth, category, AND what the connector pulls — so "CRM" / "invoices" / "sheets" find one.
  const allConnectors = useMemo(() => {
    const dedicated = new Set(CONNECTORS.map((c) => c.id));
    return [...CONNECTORS, ...presetConnectors.filter((p) => !dedicated.has(p.id))];
  }, [presetConnectors]);
  const filteredConnectors = allConnectors.filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return c.name.toLowerCase().includes(q)
      || c.authLabel.toLowerCase().includes(q)
      || (c.category ?? "").toLowerCase().includes(q)
      || c.spec.contributes.toLowerCase().includes(q);
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
    revokeSecrets(uid);
    persist({ ...cfg, sources: cfg.sources.filter((s) => s.uid !== uid) });
  }
  function toggleExpand(uid: string) {
    setExpanded((p) => { const n = new Set(p); if (n.has(uid)) n.delete(uid); else n.add(uid); return n; });
  }

  // ── readiness line ──
  const checks = sourceChecks(cfg);

  return (
    <div data-testid="source-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* top readiness banner */}
      <Banner tone={ready ? "success" : "accent"} dot loud right={
        <span style={monoSm}>{ready ? `both feed «${dataModelName}»` : "read-only integrations · credentials never leave this device"}</span>
      }>
        {total === 0 ? "Declare your sources" : ready ? "✓ sources connected" : `${scanned} / ${total} connected`}
      </Banner>

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
