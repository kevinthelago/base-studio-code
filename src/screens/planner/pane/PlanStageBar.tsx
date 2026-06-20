// The planning progress bar — one segment per ENABLED blueprint SECTION (in declared
// order), each a track with a fill sized by that section's progress and colored by its
// status. Driven entirely by the blueprint's sections + the signal bag (#…): no
// PLAN_STAGES enum, so a custom / cloud-distributed section renders here too. Keeps the
// half-clipped "tucked under the divider" look from #508: the 12px pills sit in a 6px
// clipping strip, so only their top rounded half shows.

import { sectionStatus, type BlueprintSection } from "../stages/blueprints";
import type { PlanSignals } from "../stages/stageGate";

function fillColor(status: string): string {
  switch (status) {
    case "complete":    return "var(--accent)";
    case "in-progress": return "color-mix(in oklch, var(--accent), transparent 45%)";
    case "locked":      return "var(--border)";
    default:            return "var(--bg-elev2)";
  }
}

export function PlanStageBar({ sections, signals, blocked, highlight }: {
  sections: BlueprintSection[];
  signals: PlanSignals;
  /** Section keys with an unpassed gate pipeline (#532). */
  blocked?: Set<string>;
  /** Section keys to flag for attention (e.g. a locked-Triage click); they pulse. */
  highlight?: Set<string>;
}) {
  // N/A sections (e.g. UI when the project needs no UI) are hidden entirely.
  const segments = sections
    .filter((s) => s.enabled)
    .map((section) => ({ section, ...sectionStatus(section, sections, signals) }))
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
