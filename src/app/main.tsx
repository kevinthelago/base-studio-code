// Import FIRST: self-installs a pure-DOM crash overlay so even module-eval / pre-React failures in
// this window are visible (a detached window's logs may never reach the Tauri sink — #tab-tearoff).
import "./safety/fatalOverlay";
import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "./safety/ErrorBoundary";
import { markBoot } from "@/shared/lib/core/startupTrace";
import { primeConfigOverrides } from "@/shared/lib/core/configOverrides";
import "@/styles/tokens.css";

// #2047: prime the runtime config-dir overrides BEFORE importing App (and its config modules), so
// their eager `@data` consts (STAGE_DEFS / blueprints / roles / skills / taxonomies) build from the
// config dir over the embedded default. Fail-safe (a no-op without a Tauri backend), and the dynamic
// `import("./App")` below keeps the config modules OUT of the pre-prime module graph.
await primeConfigOverrides();

// #3605/#3606: register the app's OWN modules so a component LOADED from the graph at runtime resolves its
// imports to the live app — the same React (a second copy breaks hooks), the real store, and the shared/ui
// design system + injected fleet leaves. Dynamically imported AFTER the prime because appModules pulls in
// `@data`-backed modules (like App does), so its consts must build from the config dir, not the default.
const { registerPlatformModules } = await import("./runtime/appModules");
registerPlatformModules();

// The App module graph (the ~1.5 MB bundle) evaluates at the dynamic import below — the gap from the
// document's navigation start to this mark is the pre-App bundle download + parse + eval cost (#perf).
markBoot("eval");
const { default: App } = await import("./App");

// #4169 shadow mode — build every page from the graph alongside the app, diff it against the files, and
// report. It renders nothing; the sweep runs only when asked (`window.__bscShadow.run()`), so this just
// installs the handle. DEV-only: the file half of each diff is a Vite `?raw` glob a dev server serves, and
// gating the dynamic import on `import.meta.env.DEV` (statically `false` in a build) keeps the whole
// module — and those raw sources — out of the production bundle.
if (import.meta.env.DEV) {
  void import("./runtime/shadowMode").then((m) => m.initShadowMode());
}

markBoot("render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="the app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
