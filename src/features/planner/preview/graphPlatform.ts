// The preview chain's graph-platform surface (#4238, epic #3604).
//
// #4238 made `PreviewPaneShell` a `provides` record, so the loader vendors its source instead of handing
// back the module — and vendoring makes the loader responsible for what the shell reaches. These three are
// what it reaches and nothing else registered: the preview dispatcher, the Claude-Design brief builder, and
// the renderer registry (`getRenderer` / `RendererHandle`, the html · gltf · canvas surfaces).
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545).
// Hand-written rather than generated: it is one record's dependency set, not a directory's, and the
// generator for this slice deliberately emits no platform file — every other component it authored was
// already registered by whichever platform its CONSUMER needed.
//
// `stageScreens` is NOT here, and deliberately not a record either: it is a registry with load-bearing
// module-init side effects (three renderer imports, then `registerStageScreen` calls at load). It stays a
// single code module so those registrations happen exactly once.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as PreviewBundle from "@/features/planner/preview/previewBundle";
import * as StreamingRuntime from "@/features/planner/preview/streamingRuntime";
import * as RenderPreview from "@/features/planner/preview/renderPreview";
import * as ClaudeDesignBrief from "@/features/planner/preview/claudeDesignBrief";
import * as Registry from "./registry";

let done = false;

/** Register the preview chain's injected graph-platform modules. Idempotent. */
export function registerPreviewPlatform(): void {
  if (done) return;
  done = true;
  // The two preview leaves records reach that nothing answered. Feature-scoped rather than shell:
  // registration is eager, and previewBundle pulls the esbuild-wasm chain — in appModules that would
  // land in the boot bundle for every user, where here it is loaded by the surface already paying for it.
  registerAppModule("@/features/planner/preview/previewBundle", PreviewBundle);
  registerAppModule("@/features/planner/preview/streamingRuntime", StreamingRuntime);
  registerAppModule("@/features/planner/preview/renderPreview", RenderPreview);
  registerAppModule("@/features/planner/preview/claudeDesignBrief", ClaudeDesignBrief);
  registerAppModule("@/features/planner/preview/registry", Registry);
}
