// Project classification (#3783/#3784) — the planner's discovery output that shapes the plan:
// which UI surface the `ui` stage renders, and which optional stages (source / mcp / skills) the
// project actually needs. Written by the planner during discovery via `bsc plan classify set`,
// polled into the store, and read by the UI-stage body + the stage-visibility signals.
//
// Every field is OPTIONAL: an unclassified project (the planner hasn't run `classify` yet) coerces
// to `{}`, and each read site applies its own non-regressing default (uiMode → "custom", the
// needs-flags → their stage's prior default). So adding classification never hides a pane that
// showed before the planner classified.

/** The two UI-stage surfaces (#3783). "custom" = the in-app designer preview (PreviewPaneShell —
 *  the navigable shell the designer commissions); "external" = the Claude-Design drop-files intake
 *  (FileIntakePane). */
export type UiMode = "custom" | "external";

export interface ClassifyConfig {
  /** Which surface the `ui` stage renders. Unset → the body defaults to "custom". */
  uiMode?: UiMode;
  /** The project connects to an external system → show the `source` stage. */
  needsSource?: boolean;
  /** The project uses MCP servers → show the `mcps` stage. */
  needsMcp?: boolean;
  /** The project needs attached skills → show the `skills` stage. */
  needsSkills?: boolean;
  /** The project needs cron automations → show the `automations` stage. */
  needsAutomations?: boolean;
}

/** Coerce a `bsc plan classify get` blob into a typed config — a light structural check (the CLI
 *  validates hard at write). A non-object reads as null; unknown/mistyped fields are dropped, so a
 *  partial blob (e.g. only `uiMode`) coerces cleanly. */
export function coerceClassifyConfig(raw: unknown): ClassifyConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cfg: ClassifyConfig = {};
  if (r.uiMode === "custom" || r.uiMode === "external") cfg.uiMode = r.uiMode;
  if (typeof r.needsSource === "boolean") cfg.needsSource = r.needsSource;
  if (typeof r.needsMcp === "boolean") cfg.needsMcp = r.needsMcp;
  if (typeof r.needsSkills === "boolean") cfg.needsSkills = r.needsSkills;
  if (typeof r.needsAutomations === "boolean") cfg.needsAutomations = r.needsAutomations;
  return cfg;
}
