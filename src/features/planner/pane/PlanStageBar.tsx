// The planning progress bar — one segment per ENABLED blueprint SECTION (in declared
// order), each a track with a fill sized by that section's progress and colored by its
// status. Driven entirely by the blueprint's sections + the signal bag (#…): no
// PLAN_STAGES enum, so a custom / cloud-distributed section renders here too. Keeps the
// half-clipped "tucked under the divider" look from #508: the 12px pills sit in a 6px
// clipping strip, so only their top rounded half shows.

import { stageStatus, type BlueprintStage } from "../stages/blueprints";
import type { PlanSignals } from "../stages/stageGate";
import { stageKind } from "../blueprints/blueprintCatalog";
import { ProgressionRail, type RailNode, type RailStatus } from "./ProgressionRail";

function fillColor(status: string): string {
  switch (status) {
    case "complete":    return "var(--accent)";
    case "in-progress": return "color-mix(in oklch, var(--accent), transparent 45%)";
    case "locked":      return "var(--border)";
    default:            return "var(--bg-elev2)";
  }
}

export function PlanStageBar({ sections, signals, blocked, highlight }: {
  sections: BlueprintStage[];
  signals: PlanSignals;
  /** Section keys with an unpassed gate pipeline (#532). */
  blocked?: Set<string>;
  /** Section keys to flag for attention (e.g. a locked-Triage click); they pulse. */
  highlight?: Set<string>;
}) {
  // N/A sections (e.g. UI when the project needs no UI) are hidden entirely.
  const segments = sections
    .filter((s) => s.enabled)
    .map((section) => ({ section, ...stageStatus(section, sections, signals) }))
    .filter((s) => s.status !== "na");

  return (
    <div style={{ height: 6, overflow: "hidden", display: "flex", gap: 6, padding: "0 24px", alignItems: "flex-start", flex: "0 0 auto" }}>
      {segments.map(({ section, status, fraction }) => {
        const isBlocked = blocked?.has(section.key) ?? false;
        const isHighlit = highlight?.has(section.key) ?? false;
        const pct = Math.round((status === "complete" ? 1 : fraction) * 100);
        return (
          <div
            key={section.key}
            className={isHighlit ? "attn-pulse" : undefined}
            title={`${section.name} — ${status}${isBlocked ? " · gate blocked" : ""}${isHighlit ? " · incomplete" : ""}`}
            style={{
              flex: 1, height: 12, borderRadius: 6, overflow: "hidden", position: "relative",
              background: isHighlit ? "color-mix(in oklch, var(--danger), transparent 70%)" : "var(--bg-elev2)",
            }}
          >
            <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: isBlocked ? "var(--danger)" : fillColor(status), borderRadius: 6 }} />
          </div>
        );
      })}
    </div>
  );
}

/** Map the blueprint section render-status onto the rail's unified status set. "in-progress" (the
 *  current/available stage) becomes "active" — rendered as a static accent ring on the card (the
 *  stepper variant is what pulses it). "complete"/"locked" pass through; "na" is filtered upstream. */
function railStatus(status: string): RailStatus {
  return status === "complete" ? "complete" : status === "locked" ? "locked" : "active";
}

/**
 * A compact gated-icon progression for cards (#blueprints): one node per enabled, applicable
 * section, showing that stage's icon, status-colored, joined by connectors — a preview of the
 * lifecycle this blueprint walks through. A thin adapter over the shared {@link ProgressionRail}
 * (#1869): it maps the blueprint's sections (via {@link stageStatus}) into rail nodes. Each node's
 * `title` carries the stage name + blurb + gate (the on-hover help text).
 *
 * The icon is resolved through the built-in stage→icon map ({@link stageKind}, keyed by
 * `section.key`) — exactly like every other blueprint surface (the editor, StageSummary, the catalog
 * preview). It is deliberately NOT the per-section `glyph` string: an imported / authored blueprint's
 * sections carry untrusted (or empty) glyph values, so reading the map keyed by the stage's identity
 * guarantees a real icon for every known stage and a `category` fallback otherwise — never a blank.
 */
export function PlanGateRow({ sections, signals }: {
  sections: BlueprintStage[];
  signals: PlanSignals;
}) {
  const nodes: RailNode[] = sections
    .filter((s) => s.enabled)
    .map((section) => ({ section, ...stageStatus(section, sections, signals) }))
    .filter((s) => s.status !== "na")
    .map(({ section, status }) => ({
      key: section.key,
      status: railStatus(status),
      icon: stageKind(section.key).glyph,
      title: `${section.name} · ${status}\n${section.blurb}${section.gate ? `\nGate: ${section.gate}` : ""}`,
    }));
  if (nodes.length === 0) return null;
  return (
    <div style={{ marginTop: 11 }}>
      <ProgressionRail nodes={nodes} variant="compact" />
    </div>
  );
}
