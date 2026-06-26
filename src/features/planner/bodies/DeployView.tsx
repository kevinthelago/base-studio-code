// Deploy stage pane (#919, redesign per design/Base studio code deployment) — the focused-pane
// body for the planner's Deploy stage (right after Repos). Pure presentational: reads a DeployConfig
// (+ the locked dependency manifest) and calls onChange with the next config. The `deploymentDefined`
// gate signal is derived from the same deployChecks(); a card turns green once its check passes.
//
// Structure mirrors the design: A · HOW IT SHIPS (target+hosting · pipeline · environments ·
// config+secrets) → B · WHAT IT DEPENDS ON (dependencies, grouped by source) → C · RELEASE & HEALTH
// → D · READINESS (checklist + the stream:deploy issues this config generates at publish).
//
// Split into focused modules (#1636): the Deploy-local form primitives live in `deployPrimitives`,
// the target editor (Cloud/Local picker) in `deployTargetSection`, and the per-repo ship sections
// (pipeline · environments · config · rollout) in `deployShipSections`. This file is now the
// composition shell — the per-repo card and the top-level body that owns the open/expand state.

import { useState } from "react";
import {
  platform, WORKLOAD,
  serviceReady, serviceMode, serviceTargetDefined,
  type DeployConfig, type DeployService,
} from "../lib/deployConfig";
import { MONO } from "./bodyStyles";
import { chip } from "./deployPrimitives";
import { ServiceTargetEditor } from "./deployTargetSection";
import { ServiceDeploySections } from "./deployShipSections";

// Re-exported for API compatibility (#1636) — these moved to focused modules but keep their old
// import path here so existing consumers (ReposDeployView, tests) and any external imports work.
export { Card, Divider } from "./deployPrimitives";
export { ServiceTargetEditor } from "./deployTargetSection";
export { ServiceDeploySections } from "./deployShipSections";

/** One collapsible per-repo deployment card (#1421) — the unit of the new design. Collapsed row =
 *  status · id · target · workload · ready/✓ · chevron; expanded = the target editor + (once a
 *  target is set) the repo's ship sections. `lead` lets the merged Repos & Deployment pane inject
 *  the repo's git identity row. */
export function RepoDeployCard({ svc, setSvc, open, onToggle, lead, meta, trailing }: {
  svc: DeployService; setSvc: (patch: Partial<DeployService>) => void;
  open: boolean; onToggle: () => void; lead?: React.ReactNode;
  /** Collapsed-row identity extras shown after the repo name (language · ahead/behind · agents) —
   *  the merged Repositories & Deployment pane folds the repo's git identity in here. */
  meta?: React.ReactNode;
  /** Collapsed-row trailing slot before the chevron (e.g. the per-repo visibility toggle). */
  trailing?: React.ReactNode;
}) {
  const targeted = serviceTargetDefined(svc);
  const ready = serviceReady(svc);
  const local = serviceMode(svc) === "local";
  const p = svc.platform ? platform(svc.platform) : null;
  const dot = ready ? "var(--success)" : targeted ? "var(--accent)" : "var(--warn)";
  return (
    <div style={{ background: "var(--bg-elev)", border: "1px solid " + (open ? "var(--accent-dim)" : "var(--border-soft)"), borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      <div onClick={onToggle} style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 13px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: dot, boxShadow: ready ? `0 0 7px color-mix(in oklch, ${dot}, transparent 60%)` : undefined }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg)" }}>{svc.repo || svc.id}</span>
        {meta}
        <span style={{ flex: 1 }} />
        {targeted ? (
          <>
            <span style={{ ...chip, color: local ? "var(--violet)" : "var(--accent)", borderColor: local ? "color-mix(in oklch, var(--violet), transparent 60%)" : "var(--accent-dim)", background: `color-mix(in oklch, ${local ? "var(--violet)" : "var(--accent)"}, transparent 86%)` }}>
              {local ? `⬢ ${svc.localKind ?? "local"}` : <>{p && <span style={{ color: `oklch(0.78 0.12 ${p.h})` }}>{p.glyph} </span>}{p?.name}</>}
            </span>
            {!local && <span style={{ ...chip, fontSize: 8, color: WORKLOAD[svc.workload].c, borderColor: `color-mix(in oklch, ${WORKLOAD[svc.workload].c}, transparent 60%)` }}>{WORKLOAD[svc.workload].label}</span>}
            <span style={{ width: 18, height: 18, borderRadius: 99, display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: MONO, fontSize: 10, color: ready ? "var(--success)" : "var(--fg-dim)", background: ready ? "color-mix(in oklch, var(--success), transparent 84%)" : "var(--bg-elev2)" }}>{ready ? "✓" : "·"}</span>
          </>
        ) : (
          <span style={{ ...chip, color: "var(--warn)", borderColor: "color-mix(in oklch, var(--warn), transparent 55%)", background: "transparent", borderStyle: "dashed" }}>set target →</span>
        )}
        {trailing}
        <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11, width: 12, textAlign: "center" }}>{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div style={{ borderTop: "1px solid var(--border-soft)", padding: "12px 13px", display: "flex", flexDirection: "column", gap: 12 }}>
          {lead}
          <ServiceTargetEditor svc={svc} setSvc={setSvc} />
          {targeted && <ServiceDeploySections svc={svc} setSvc={setSvc} />}
        </div>
      )}
    </div>
  );
}

/** The Deployment stage body (#1421) — one collapsible card per repo, each a self-contained
 *  deployable unit (target & build · pipeline · environments · config & secrets · rollout).
 *  Dependencies live OUTSIDE this pane now (#1429) — they're locked by the planner and gate
 *  separately. No in-body header (#1430): the focused pane's phase header already titles the stage. */
export function FocusedDeployBody({ deploy, onChange }: {
  deploy?: DeployConfig;
  onChange?: (next: DeployConfig) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (!deploy) {
    return <div style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg-dim)", padding: "8px 2px" }}>Deployment config loads once the repos are linked.</div>;
  }
  const d = deploy;
  const setSvcFor = (id: string, patch: Partial<DeployService>) =>
    onChange?.({ ...d, services: d.services.map((s) => s.id === id ? { ...s, ...patch } : s) });

  if (d.services.length === 0) {
    return (
      <div style={{ border: "1px dashed var(--border)", borderRadius: "var(--r-lg)", padding: "40px 24px", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, textAlign: "center", background: "var(--bg-canvas)" }}>
        <span style={{ fontSize: 26, opacity: 0.5 }}>⎇</span>
        <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No repositories linked</span>
        <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg-muted)", maxWidth: 380, lineHeight: 1.6 }}>Deployment is configured per repository — each repo carries its own pipeline, environments and secrets. Link one to define how it ships.</span>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
      {d.services.map((svc) => (
        <RepoDeployCard key={svc.id} svc={svc} setSvc={(patch) => setSvcFor(svc.id, patch)}
          open={openId === svc.id} onToggle={() => setOpenId((cur) => (cur === svc.id ? null : svc.id))} />
      ))}
    </div>
  );
}
