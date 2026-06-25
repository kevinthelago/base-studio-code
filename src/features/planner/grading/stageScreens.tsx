// Stage "second screens" — the render-surface registry for the planning page.
//
// Sections are static and own the planning UI; *stage modules* are how capability is added
// (builtin or external). A stage module may declare a second screen: a render surface that
// appears in the planning page when the module's STAGE is the current (reached) one.
// The planning page reads the active blueprint directly, finds the current stage's
// enabled modules, and renders whichever of them registered a screen here.
//
// Keyed by stage id so builtin and external modules alike can plug a screen in.
// React lives here (not in the pure stageRun), mirroring how renderPreview's
// handler is pure but its surface, PlanPreviewPane, is a component.

import type { ComponentType } from "react";
// Preview module: import renderers (side-effects) + the new shell component (#581).
import "../preview/renderers/htmlRenderer";
import "../preview/renderers/gltfRenderer";
import "../preview/renderers/canvasRenderer";
import { PreviewPaneShell } from "../preview/PreviewPaneShell";
import { RENDER_PREVIEW_ID } from "../preview/renderPreview";
import { FileIntakePane } from "../bodies/FileIntakePane";
import { FILE_INTAKE_ID } from "../shared/fileIntake";
import { GradeReportPane } from "./GradeReportPane";
import { GRADE_RUBRIC_ID } from "./gradeDispatch";
import { GRADE_LLM_ID } from "./gradeLLM";

/** Props every pipeline second screen receives. `onClose`, when provided, renders a
 *  dismiss affordance (stage-driven screens omit it — they're bound to the stage). */
export interface StageScreenProps {
  projectKey: string;
  /** The current (reached) section's key — screens bound to a section (e.g. grading)
   *  use it; section-agnostic screens (render-preview) ignore it. (#615) */
  sectionKey?: string;
  /** The current section's plan markdown, when available (e.g. for content grading). */
  sectionContent?: string;
  onClose?: () => void;
}

export type StageScreenComponent = ComponentType<StageScreenProps>;

const STAGE_SCREENS: Record<string, StageScreenComponent> = {
  // Modular streaming feed consumer (#581): PreviewPaneShell routes chunks through the
  // renderer registry; renderer side-effects above register html/gltf/canvas renderers.
  [RENDER_PREVIEW_ID]: PreviewPaneShell,
  // Drag-and-drop file intake (#604): stage design/any files for the planner to route.
  [FILE_INTAKE_ID]: FileIntakePane,
  // Grade report card (#615): renders the section's grader results (multiple → tabs).
  [GRADE_RUBRIC_ID]: GradeReportPane,
  [GRADE_LLM_ID]: GradeReportPane,
};

/** The second screen for a stage id, or undefined when it has none. */
export function stageScreen(id: string): StageScreenComponent | undefined {
  return STAGE_SCREENS[id];
}

/** Whether a stage module declares a second screen. */
export function hasStageScreen(id: string): boolean {
  return id in STAGE_SCREENS;
}

/** Register (or replace) a stage module's second screen. Lets external stage modules plug a
 *  render surface into the planning page. Idempotent — last registration wins. */
export function registerStageScreen(id: string, screen: StageScreenComponent): void {
  STAGE_SCREENS[id] = screen;
}
