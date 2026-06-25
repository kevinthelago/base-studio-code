// The planning progress bar — one segment per ENABLED blueprint SECTION (in declared
// order), each a track with a fill sized by that section's progress and colored by its
// status. Driven entirely by the blueprint's sections + the signal bag (#…): no
// PLAN_STAGES enum, so a custom / cloud-distributed section renders here too. Keeps the
// half-clipped "tucked under the divider" look from #508: the 12px pills sit in a 6px
// clipping strip, so only their top rounded half shows.

import { Fragment, type CSSProperties } from "react";
import { sectionStatus, type BlueprintSection } from "../stages/blueprints";
import type { PlanSignals } from "../stages/stageGate";
import { stageKind } from "../blueprints/blueprintCatalog";
import { Ic } from "../blueprints/blueprintIcons";

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

/** Per-status node styling for {@link PlanGateRow} — mirrors the focused-pane stepper's
 *  seqrail node (complete = filled success, locked = soft-ringed dim, else accent-ringed). */
function nodeStyle(status: string): CSSProperties {
  const base: CSSProperties = {
    width: 24, height: 24, flex: "0 0 24px", borderRadius: 7,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "var(--mono)", fontSize: 13, lineHeight: 1, fontWeight: 700,
  };
  switch (status) {
    case "complete":
      return { ...base, background: "var(--success)", color: "oklch(0.20 0.04 145)" };
    case "locked":
      return { ...base, background: "var(--bg-elev2)", color: "var(--fg-dim)", boxShadow: "inset 0 0 0 1.5px var(--border)" };
    default: // in-progress / available
      return { ...base, background: "var(--bg-elev2)", color: "var(--accent)", boxShadow: "inset 0 0 0 1.5px var(--accent-dim)" };
  }
}

/**
 * A compact gated-icon progression for cards (#blueprints): one node per enabled, applicable
 * section, showing that stage's icon, status-colored like the focused-pane stepper, and joined by
 * connectors. Each node's `title` carries the stage name + blurb + gate (the on-hover help text).
 * Driven by blueprint data + the signal bag — on a signal-less blueprint card it reads as the
 * lifecycle's stage sequence; each gate adds width, so the host pane widens with it.
 *
 * The icon is resolved through the built-in stage→icon map ({@link stageKind}, keyed by
 * `section.key`) and rendered as inline SVG via {@link Ic}, exactly like every other blueprint
 * surface (the editor, StageSummary, the catalog preview). It is deliberately NOT the per-section
 * `glyph` string: an imported / authored blueprint's sections carry untrusted (or empty) glyph
 * values, so reading the map keyed by the stage's identity guarantees a real icon for every known
 * stage and a `category` fallback otherwise — never a blank or a stray literal character.
 */
export function PlanGateRow({ sections, signals }: {
  sections: BlueprintSection[];
  signals: PlanSignals;
}) {
  const segments = sections
    .filter((s) => s.enabled)
    .map((section) => ({ section, ...sectionStatus(section, sections, signals) }))
    .filter((s) => s.status !== "na");
  if (segments.length === 0) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 0, marginTop: 11 }}>
      {segments.map(({ section, status }, i) => (
        <Fragment key={section.key}>
          <span
            title={`${section.name} · ${status}\n${section.blurb}${section.gate ? `\nGate: ${section.gate}` : ""}`}
            style={nodeStyle(status)}
          >
            {status === "complete" ? "✓" : <Ic n={stageKind(section.key).glyph} size={13} />}
          </span>
          {i < segments.length - 1 && (
            <span style={{
              flex: "1 1 0", minWidth: 6, height: 2, margin: "0 2px", borderRadius: 2,
              background: status === "complete" ? "var(--success)" : "var(--border-soft)",
            }} />
          )}
        </Fragment>
      ))}
    </div>
  );
}
