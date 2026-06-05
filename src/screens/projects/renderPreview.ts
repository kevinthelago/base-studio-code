// render-preview pipeline (#528/#531) — the flagship builtin. Reads the UI stage's
// skeleton artifacts, bundles them (previewBundle #530), and surfaces the iframe
// srcdoc so PlanPreviewPane renders the mock UI live in the planning page.
//
// 2D and 3D share one transport: a 3D skeleton just renders an r3f <Canvas>
// (react-three-fiber is externalized + resolved via esm.sh), so `mode` only tunes the
// pane chrome. The dispatch glue runs the pipeline through the engine (#529) and
// writes the result to the store; #533 wires the triggers (tag / watch / manual).

import { useAppStore } from "../../store";
import { bundleSkeleton, buildPreviewSrcDoc } from "./previewBundle";
import {
  registerPipelineHandler, runPipeline,
  type PipelineHandler, type StageContext, type PipelineRunResult,
} from "./pipelineRuntime";
import type { Pipeline } from "./blueprints";

export type PreviewMode = "2d" | "3d";
export interface PreviewOutput { srcDoc: string; mode: PreviewMode; screen?: string }

export const RENDER_PREVIEW_ID = "render-preview";

/** Pick the screen entry: ctx.entry if it's a real file, else the first source file. */
export function resolveEntry(artifacts: Record<string, string>, entry?: string): string | null {
  if (entry && artifacts[entry] != null) return entry;
  const src = Object.keys(artifacts).filter((k) => /\.(jsx|tsx|js|ts)$/.test(k));
  return src[0] ?? null;
}

export const renderPreviewHandler: PipelineHandler = async (ctx: StageContext): Promise<PipelineRunResult> => {
  const artifacts = ctx.artifacts as Record<string, string>;
  const entry = resolveEntry(artifacts, ctx.entry);
  if (!entry) return { status: "fail", message: "render-preview: no screen file in the skeleton" };
  const mode: PreviewMode = ctx.mode === "3d" ? "3d" : "2d";
  const js = await bundleSkeleton(artifacts, entry);
  const srcDoc = buildPreviewSrcDoc(js);
  return { status: "ok", output: { srcDoc, mode } satisfies PreviewOutput };
};

/** Register the builtin (idempotent). Called at module load + safe to call in tests. */
export function registerRenderPreview(): void {
  registerPipelineHandler(RENDER_PREVIEW_ID, renderPreviewHandler);
}
registerRenderPreview();

const RENDER_PREVIEW_PIPELINE: Pipeline = {
  uid: RENDER_PREVIEW_ID, id: RENDER_PREVIEW_ID, name: "Render preview",
  desc: "Visualize screens as a 2D / 3D walkthrough", suits: ["ui"], kind: "builtin",
  trigger: "manual", enabled: true,
};

/**
 * Run render-preview for a project and reflect the result in the store: the bundled
 * srcdoc (→ PlanPreviewPane) and the run status (→ Blueprints rows / gate). This is
 * the integration point the triggers (#533) call.
 */
export async function dispatchRenderPreview(args: {
  projectKey: string; stageId?: string; artifacts: Record<string, string>; entry?: string; mode?: PreviewMode; screen?: string;
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  store.setStagePipelineRun(args.projectKey, RENDER_PREVIEW_ID, { status: "running", lastRun: null });
  const ctx: StageContext = {
    projectKey: args.projectKey, stageId: args.stageId ?? "ui", artifacts: args.artifacts,
    trigger: "manual", entry: args.entry, mode: args.mode,
  };
  const result = await runPipeline(RENDER_PREVIEW_PIPELINE, ctx);
  if (result.status === "ok" && result.output) {
    // Tag the stored preview with the screen so the pane's approve button targets it (#546).
    store.setStagePreview(args.projectKey, { ...(result.output as PreviewOutput), screen: args.screen ?? args.entry });
  }
  store.setStagePipelineRun(args.projectKey, RENDER_PREVIEW_ID, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}
