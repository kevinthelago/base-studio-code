// Pipeline "second screens" — the render-surface registry for the planning page.
//
// Sections are static and own the planning UI; *pipelines* are how capability is added
// (builtin or external). A pipeline may declare a second screen: a render surface that
// appears in the planning page when the pipeline's STAGE is the current (reached) one.
// The planning page reads the active blueprint directly, finds the current stage's
// enabled pipelines, and renders whichever of them registered a screen here.
//
// Keyed by pipeline id so builtin and external pipelines alike can plug a screen in.
// React lives here (not in the pure pipelineRuntime), mirroring how renderPreview's
// handler is pure but its surface, PlanPreviewPane, is a component.

import type { ComponentType } from "react";
import { PlanPreviewPane } from "./PlanPreviewPane";
import { RENDER_PREVIEW_ID } from "./renderPreview";
import { FileIntakePane } from "./FileIntakePane";
import { FILE_INTAKE_ID } from "./fileIntake";
import { GradeReportPane } from "./GradeReportPane";
import { GRADE_RUBRIC_ID } from "./gradeDispatch";

/** Props every pipeline second screen receives. `onClose`, when provided, renders a
 *  dismiss affordance (stage-driven screens omit it — they're bound to the stage). */
export interface PipelineScreenProps {
  projectKey: string;
  /** The current (reached) section's key — screens bound to a section (e.g. grading)
   *  use it; section-agnostic screens (render-preview) ignore it. (#615) */
  sectionKey?: string;
  /** The current section's plan markdown, when available (e.g. for content grading). */
  sectionContent?: string;
  onClose?: () => void;
}

export type PipelineScreenComponent = ComponentType<PipelineScreenProps>;

const PIPELINE_SCREENS: Record<string, PipelineScreenComponent> = {
  // The flagship second screen: the live UI preview, shown when the `ui` stage is reached.
  [RENDER_PREVIEW_ID]: PlanPreviewPane,
  // Drag-and-drop file intake (#604): stage design/any files for the planner to route.
  [FILE_INTAKE_ID]: FileIntakePane,
  // Grade report card (#615): renders the section's grader results (multiple → tabs).
  [GRADE_RUBRIC_ID]: GradeReportPane,
};

/** The second screen for a pipeline id, or undefined when it has none. */
export function pipelineScreen(id: string): PipelineScreenComponent | undefined {
  return PIPELINE_SCREENS[id];
}

/** Whether a pipeline declares a second screen. */
export function hasPipelineScreen(id: string): boolean {
  return id in PIPELINE_SCREENS;
}

/** Register (or replace) a pipeline's second screen. Lets external pipelines plug a
 *  render surface into the planning page. Idempotent — last registration wins. */
export function registerPipelineScreen(id: string, screen: PipelineScreenComponent): void {
  PIPELINE_SCREENS[id] = screen;
}
