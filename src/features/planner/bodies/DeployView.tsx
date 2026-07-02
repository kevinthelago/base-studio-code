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

import {
  platform, WORKLOAD,
  serviceReady, serviceMode, serviceTargetDefined,
  type DeployService,
} from "../lib/deployConfig";
import { MONO } from "./bodyStyles";
import { chip } from "./deployPrimitives";
import { ServiceTargetEditor } from "./deployTargetSection";
import { ServiceDeploySections } from "./deployShipSections";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";

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
      <Row onClick={onToggle} gap={9} style={{ padding: "11px 13px", cursor: "pointer", userSelect: "none" }}>
        <span style={{ width: 7, height: 7, borderRadius: 99, flex: "0 0 7px", background: dot, boxShadow: ready ? `0 0 7px color-mix(in oklch, ${dot}, transparent 60%)` : undefined }} />
        <span style={{ fontFamily: MONO, fontSize: 12, color: "var(--fg)" }}>{svc.repo || svc.id}</span>
        {meta}
        <Spacer />
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
      </Row>
      {open && (
        <Stack gap={12} style={{ borderTop: "1px solid var(--border-soft)", padding: "12px 13px" }}>
          {lead}
          <ServiceTargetEditor svc={svc} setSvc={setSvc} />
          {targeted && <ServiceDeploySections svc={svc} setSvc={setSvc} />}
        </Stack>
      )}
    </div>
  );
}
