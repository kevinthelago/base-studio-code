// The algorithms feature's graph-platform surface (#4219, epic #3604) — the modules a graph-loaded
// Algorithms workspace imports but does NOT redraw: the knowledge model, the graph hook, and the
// visualiser. Registered HERE, inside the feature, because the shell must not reach a feature's internals
// (#1545). The algorithms host calls this at module load, before the graph page loads.
//
// The viz panel stays code on purpose. It runs the instrumented executor (#3215) — real algorithm code
// driving an animation through `Traced<X>` — which is behaviour by any reading, and the least suitable
// thing in the feature to express as layout data.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Knowledge from "./lib/knowledge";
import * as UseKnowledgeGraph from "./useKnowledgeGraph";
import * as VizPanel from "./viz/VizPanel";
import * as UseVizForImpl from "./viz/useVizForImpl";
// The librarian terminal is hosted by the studio-session surface — a cross-feature BARREL, which #1545
// permits and the live file already imports.
import * as StudioSessions from "@/features/studio-sessions";

let done = false;

/** Register the Algorithms page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerAlgorithmsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/algorithms/lib/knowledge", Knowledge);
  registerAppModule("@/features/algorithms/useKnowledgeGraph", UseKnowledgeGraph);
  registerAppModule("@/features/algorithms/viz/VizPanel", VizPanel);
  registerAppModule("@/features/algorithms/viz/useVizForImpl", UseVizForImpl);
  registerAppModule("@/features/studio-sessions", StudioSessions);
}
