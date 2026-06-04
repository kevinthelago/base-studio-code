// The planning progress bar, driven by the modular stage registry (#512). One
// segment per ENABLED stage (in configured order), each a track with a fill sized
// by that stage's progress and colored by its status. Keeps the half-clipped
// "tucked under the divider" look from #508: the 12px pills sit in a 6px clipping
// strip, so only their top rounded half shows.

import { enabledOrderedStages, stageStatus, type PlanStageState, type StageConfig } from "./planStages";

function fillColor(status: string): string {
  switch (status) {
    case "complete":    return "var(--accent)";
    case "in-progress": return "color-mix(in oklch, var(--accent), transparent 45%)";
    case "locked":      return "var(--border)";
    default:            return "var(--bg-elev2)";
  }
}

export function PlanStageBar({ config, state }: { config: StageConfig; state: PlanStageState }) {
  // N/A stages (e.g. UI when the project needs no UI) are hidden entirely.
  const segments = enabledOrderedStages(config)
    .map((stage) => ({ stage, ...stageStatus(stage, state, config) }))
    .filter((s) => s.status !== "na");

  return (
    <div style={{ height: 6, overflow: "hidden", display: "flex", gap: 6, padding: "0 24px", alignItems: "flex-start", flex: "0 0 auto" }}>
      {segments.map(({ stage, status, fraction }) => {
        const pct = Math.round((status === "complete" ? 1 : fraction) * 100);
        return (
          <div
            key={stage.id}
            title={`${stage.label} — ${status}`}
            style={{ flex: 1, height: 12, borderRadius: 6, background: "var(--bg-elev2)", overflow: "hidden", position: "relative" }}
          >
            <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: fillColor(status), borderRadius: 6 }} />
          </div>
        );
      })}
    </div>
  );
}
