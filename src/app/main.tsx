// Import FIRST: self-installs a pure-DOM crash overlay so even module-eval / pre-React failures in
// this window are visible (a detached window's logs may never reach the Tauri sink — #tab-tearoff).
import "./safety/fatalOverlay";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./safety/ErrorBoundary";
import { markBoot } from "@/shared/lib/core/startupTrace";
import "@/styles/tokens.css";

// The module graph (the ~1.5 MB bundle) has finished evaluating by here — the gap from the
// document's navigation start to this mark is the bundle download + parse + eval cost (#perf).
markBoot("eval");

markBoot("render");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="the app">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
