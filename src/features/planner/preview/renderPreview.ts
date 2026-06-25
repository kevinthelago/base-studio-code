// render-preview pipeline (#528/#531) — the flagship builtin. Reads the UI stage's
// skeleton artifacts, bundles them (previewBundle #530), and surfaces the iframe
// srcdoc so PlanPreviewPane renders the mock UI live in the planning page.
//
// 2D and 3D share one transport: a 3D skeleton just renders an r3f <Canvas>
// (react-three-fiber is externalized + resolved via esm.sh), so `mode` only tunes the
// pane chrome. The dispatch glue runs the pipeline through the engine (#529) and
// writes the result to the store; #533 wires the triggers (tag / watch / manual).

import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { bundleSkeleton, buildPreviewSrcDoc } from "./previewBundle";
import { type StageContext, type PipelineRunResult } from "../grading/pipelineRuntime";
import { registerPipeline } from "../grading/pipelineCommands";

export type PreviewMode = "2d" | "3d";
export interface PreviewOutput { srcDoc: string; mode: PreviewMode; screen?: string }

export const RENDER_PREVIEW_ID = "render-preview";

/** Pick the screen entry: ctx.entry if it's a real file, else the first source file. */
export function resolveEntry(artifacts: Record<string, string>, entry?: string): string | null {
  if (entry && artifacts[entry] != null) return entry;
  const src = Object.keys(artifacts).filter((k) => /\.(jsx|tsx|js|ts)$/.test(k));
  return src[0] ?? null;
}

/** The render-preview stage helper: bundle the UI skeleton into an iframe srcDoc. Runs by
 *  direct dispatch (#897 Phase 4c removed the generic engine); never throws. */
export async function renderPreviewHandler(ctx: StageContext): Promise<PipelineRunResult> {
  const artifacts = ctx.artifacts as Record<string, string>;
  const entry = resolveEntry(artifacts, ctx.entry);
  if (!entry) return { status: "fail", message: "render-preview: no screen file in the skeleton" };
  const mode: PreviewMode = ctx.mode === "3d" ? "3d" : "2d";
  const js = await bundleSkeleton(artifacts, entry);
  const srcDoc = buildPreviewSrcDoc(js);
  return { status: "ok", output: { srcDoc, mode } satisfies PreviewOutput };
}

/**
 * Run render-preview for a project and reflect the result in the store: the bundled
 * srcdoc (→ the preview pane) and the run status. Calls the handler directly.
 */
export async function dispatchRenderPreview(args: {
  projectKey: string; stageId?: string; artifacts: Record<string, string>; entry?: string; mode?: PreviewMode; screen?: string;
}): Promise<PipelineRunResult> {
  const store = useAppStore.getState();
  store.setStagePipelineRun(args.projectKey, RENDER_PREVIEW_ID, { status: "running", lastRun: null });
  const ctx: StageContext = {
    projectKey: args.projectKey, stageId: args.stageId ?? "ui", artifacts: args.artifacts,
    entry: args.entry, mode: args.mode,
  };
  let result: PipelineRunResult;
  try { result = await renderPreviewHandler(ctx); }
  catch (e) { result = { status: "fail", message: String(e) }; }
  if (result.status === "ok" && result.output) {
    // Tag the stored preview with the screen so the pane's approve button targets it (#546).
    store.setStagePreview(args.projectKey, { ...(result.output as PreviewOutput), screen: args.screen ?? args.entry });
  }
  store.setStagePipelineRun(args.projectKey, RENDER_PREVIEW_ID, { status: result.status, lastRun: Date.now(), message: result.message });
  return result;
}

// Register render-preview as the first command module. Its `run` reads the project's
// .ui-skeleton and dispatches a render for the requested screen/mode — the behavior the
// <ui_preview> tag triggers today. Richer commands (save/confirm/persist, navigation)
// are render-preview's OWN later behavior; the bus stays generic. Idempotent on import.
registerPipeline({
  id: RENDER_PREVIEW_ID,
  async command(cmd, ctx) {
    if (cmd !== "run") return; // other commands are this pipeline's future behavior
    const screen = ctx.args.screen || undefined;
    const mode: PreviewMode = ctx.args.mode === "3d" ? "3d" : "2d";
    const files = await invoke<[string, string][]>("read_ui_skeleton", { projectKey: ctx.projectKey });
    if (files.length === 0) return;
    await dispatchRenderPreview({
      projectKey: ctx.projectKey, artifacts: Object.fromEntries(files), entry: screen, mode, screen,
    });
  },
});
