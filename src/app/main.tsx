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

// The App module graph (the ~1.5 MB bundle) evaluates at the dynamic import below — the gap from the
// document's navigation start to this mark is the pre-App bundle download + parse + eval cost (#perf).
markBoot("eval");
const { default: App } = await import("./App");

markBoot("render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="the app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
