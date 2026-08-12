// The designs feature's graph-platform surface (register-the-feature-logic-surface) — the modules a
// graph-loaded record imports from this feature but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545)
// and eager-importing them from `app/` would de-lazy the whole feature at boot. The feature's BARREL
// calls this at module load, so the shadow catalogue's `ensurePlatform: () => import("@/features/designs")`
// is what registers them — the same shape `registerAutomationsPlatform` already uses.
//
// These files STAY on disk: registration is not migration. It makes a record that imports them
// loadable, which is the prerequisite for migrating the modules that import THEM.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as GraphHealth from "@/features/designs/lib/graphHealth";
import * as CompositionLayout from "@/features/designs/lib/compositionLayout";
import * as ComponentScan from "@/features/designs/lib/componentScan";
import * as Model from "@/features/designs/lib/model";
import * as ComponentPreview from "@/features/designs/lib/componentPreview";
import * as UsePreviewData from "@/features/designs/usePreviewData";
import * as ComponentBridge from "@/features/designs/lib/componentBridge";
import * as PreviewRegistry from "@/features/designs/lib/previewRegistry";
import * as LibraryModules from "@/features/designs/lib/libraryModules";
import * as UseActiveSoundKit from "@/features/designs/lib/useActiveSoundKit";
import * as DesignGenBridge from "@/features/designs/lib/designGenBridge";
import * as UseDesignerLoopState from "@/features/designs/useDesignerLoopState";
import * as UseDesignerLoopPump from "@/features/designs/useDesignerLoopPump";
import * as EdgeBatch from "@/features/designs/lib/edgeBatch";
import * as LibraryComposition from "@/features/designs/lib/libraryComposition";
import * as UiActivity from "@/features/designs/lib/uiActivity";
import * as UseComponentScan from "@/features/designs/lib/useComponentScan";
import * as StudioVisibility from "@/features/designs/lib/studioVisibility";
import * as KitGroups from "@/features/designs/lib/kitGroups";
import * as UsePreviewStateCycle from "@/features/designs/lib/usePreviewStateCycle";
import * as ExpandedPreviewFit from "@/features/designs/lib/expandedPreviewFit";
import * as Themes from "@/features/designs/lib/themes";
import * as KitGist from "@/features/designs/lib/kitGist";
import * as Palette from "@/features/designs/lib/palette";

let done = false;

/** Register this feature's injected graph-platform modules by the specifiers a record imports. Idempotent. */
export function registerDesignsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/designs/lib/graphHealth", GraphHealth);
  registerAppModule("@/features/designs/lib/compositionLayout", CompositionLayout);
  registerAppModule("@/features/designs/lib/componentScan", ComponentScan);
  registerAppModule("@/features/designs/lib/model", Model);
  registerAppModule("@/features/designs/lib/componentPreview", ComponentPreview);
  registerAppModule("@/features/designs/usePreviewData", UsePreviewData);
  registerAppModule("@/features/designs/lib/componentBridge", ComponentBridge);
  registerAppModule("@/features/designs/lib/previewRegistry", PreviewRegistry);
  registerAppModule("@/features/designs/lib/libraryModules", LibraryModules);
  registerAppModule("@/features/designs/lib/useActiveSoundKit", UseActiveSoundKit);
  registerAppModule("@/features/designs/lib/designGenBridge", DesignGenBridge);
  registerAppModule("@/features/designs/useDesignerLoopState", UseDesignerLoopState);
  registerAppModule("@/features/designs/useDesignerLoopPump", UseDesignerLoopPump);
  registerAppModule("@/features/designs/lib/edgeBatch", EdgeBatch);
  registerAppModule("@/features/designs/lib/libraryComposition", LibraryComposition);
  registerAppModule("@/features/designs/lib/uiActivity", UiActivity);
  registerAppModule("@/features/designs/lib/useComponentScan", UseComponentScan);
  registerAppModule("@/features/designs/lib/studioVisibility", StudioVisibility);
  registerAppModule("@/features/designs/lib/kitGroups", KitGroups);
  registerAppModule("@/features/designs/lib/usePreviewStateCycle", UsePreviewStateCycle);
  registerAppModule("@/features/designs/lib/expandedPreviewFit", ExpandedPreviewFit);
  registerAppModule("@/features/designs/lib/themes", Themes);
  registerAppModule("@/features/designs/lib/kitGist", KitGist);
  registerAppModule("@/features/designs/lib/palette", Palette);
}
