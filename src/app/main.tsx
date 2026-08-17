// Import FIRST: self-installs a pure-DOM crash overlay so even module-eval / pre-React failures in
// this window are visible (a detached window's logs may never reach the Tauri sink — #tab-tearoff).
import "@/app/safety/fatalOverlay";
import React from "react";
import ReactDOM from "react-dom/client";
import { ErrorBoundary } from "@/app/safety/ErrorBoundary";
import { markBoot } from "@/shared/lib/core/startupTrace";
import { primeConfigOverrides } from "@/shared/lib/core/configOverrides";
import "@/styles/tokens.css";

// EVERY stylesheet, eagerly — because a component can no longer be trusted to import its own.
//
// A component's CSS used to reach the bundle because the component's FILE imported it
// (`import "./banner.css"`). A RECORD cannot do that: the runtime loader resolves each import against
// the platform registry and the record store, and a stylesheet is in neither, so the seed projection
// drops it. That is harmless while the file still exists and does the importing — and the moment the
// file is RETIRED, the last importer goes with it. Ten stylesheets stopped shipping that way (banner,
// rail, sessionDock, pane, statTile, dataTable, cardListRow, dropdown, segmentedControl, sectionHeader)
// and every component they style rendered unstyled.
//
// Nothing caught it, and nothing could have: every module still RESOLVED, so typecheck, lint, vitest,
// `vite build`, `dev-boot-check` and the e2e mount sweep were all green. A missing stylesheet is not a
// missing module — the app boots, mounts, and looks wrong.
//
// A glob makes the whole class impossible rather than fixing the ten: styling stops depending on which
// modules happen to still be files. `tokens.css` keeps its explicit import ABOVE this one so the token
// layer is always first in the cascade; re-importing it here is a no-op (module cache).
import.meta.glob("@/**/*.css", { eager: true });

// PACKAGE stylesheets, explicitly — the glob above is `@/**`, which is `src/` and NOTHING ELSE.
//
// `xterm.css` used to reach the bundle because `TerminalView` and `useScreenSession` imported it. That
// is the same dependency the glob exists to remove, and it is the half the glob cannot cover: a
// node_modules path is not under `@/`. Dropping those two imports to unblock the modules for record
// migration would have left the terminal unstyled with every gate green — a missing stylesheet is not a
// missing module. So the entry owns this one too, and `styleReachability.test.ts` now asserts that no
// module under `src/` imports a stylesheet at all, package or local.
import "@xterm/xterm/css/xterm.css";

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

// #runtime-attests-what-actually-ran — turn the attestation sink ON, so every record the loader serves or
// DECLINES from here is recorded rather than logged and forgotten. Installed beside the registry because
// that is what the loader resolves against: a decline before this point would be a decline the registry
// could not have satisfied anyway.
//
// NOT gated on DEV, unlike shadow mode above, and that asymmetry is the point. Shadow mode diffs records
// against FILES, which only a dev server has; this records what actually served, and the install where
// that matters most is the shipped one. It costs a coalesced row per record per version per outcome per
// session, flushed in batches — not a message per load.
const { enableAttestation, flushAttestations } = await import("@/shared/lib/runtime/attest");
enableAttestation();
// Flush on the way out, so a session's last batch is not lost with the window. `visibilitychange` rather
// than `beforeunload`: the latter is unreliable when a webview is killed rather than closed, and hidden
// fires on the path to both.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushAttestations();
});

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
