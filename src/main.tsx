import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { markBoot } from "./lib/core/startupTrace";
import "./styles/tokens.css";

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
