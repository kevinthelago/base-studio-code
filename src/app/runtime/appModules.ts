// The platform module registration (#3605, epic #3604) — the shell's list of the app's OWN modules that
// graph-loaded code is allowed to import, wired to the LIVE instances. This is the platform ↔ graph
// boundary: everything registered here stays real code (React, the store, shared primitives); everything
// else the graph provides. Lives in `app/` because only the shell knows the whole module set (features
// don't), and it must register the SAME React/store instances the running app uses — a second copy would
// break hooks.
//
// #3606 grows the shared/ui primitive list so a graph-loaded page can compose the real Card/Grid/charts.
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Store from "@/store";
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";

let done = false;

/** Register every platform module by its import specifier. Idempotent — safe to call at each boot / HMR. */
export function registerPlatformModules(): void {
  if (done) return;
  done = true;
  // React itself — the app's ONE instance, so a loaded component's hooks share the app's dispatcher.
  registerAppModule("react", React);
  registerAppModule("react/jsx-runtime", JsxRuntime); // esbuild `jsx: "automatic"` emits this
  // The live app state — a loaded page reads/subscribes to the REAL store, not a stub.
  registerAppModule("@/store", Store);
}
