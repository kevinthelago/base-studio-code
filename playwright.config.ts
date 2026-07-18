/// <reference types="node" />
// Playwright config for the OPT-IN preview interaction harness (#3264).
//
// This is not part of the repo's gate. The gate is `npm run typecheck` + `npm run lint` + `npm test`
// (+ optional `npx vite build`), and none of them touch this file: `vitest.config.ts` only discovers
// `src/**`, and `tsconfig.json` does not include `e2e/`, so a worktree agent that never asks for the
// browser never pays for it. PR workflows are disabled in this repo and the gate is local-only, so this
// is designed for a human running it deliberately — there is no CI hook to hide behind.
//
// To run it (the browser download is the one-time cost, ~150 MB, and is NOT implied by `npm install`):
//     npm install                      # brings in @playwright/test (no browser)
//     npx playwright install chromium  # ONE TIME — downloads the browser
//     npm run test:e2e                 # boots Vite on :1421 and drives real Chromium
//     npm run test:e2e -- --headed     # …watch it happen
//
// Chromium only, on purpose: the app ships in a Tauri WebView (Chromium-family on Windows via WebView2),
// so a Firefox/WebKit matrix would test engines the product never runs on while tripling the download.
import { defineConfig, devices } from "@playwright/test";

const PORT = 1421;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Serial: the suite drives real OS-level mouse input through a shared browser; parallel workers each
  // hold their own page, but the value here is a clean, reproducible input stream over a fast suite.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: {
    // Spread the device profile FIRST so the explicit settings below actually win — the reverse order
    // silently loses `viewport` to the device's own.
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    // The harness page pins its iframe to the viewport origin at a fixed size; the viewport just has to
    // be big enough to contain it so no page-level scrolling shifts the coordinate mapping.
    viewport: { width: 1000, height: 800 },
    trace: "retain-on-failure",
  },
  webServer: {
    // `npx` so this works whether it is launched via `npm run test:e2e` (which puts every ancestor
    // node_modules/.bin on PATH) or `npx playwright test` directly.
    command: "npx vite --config e2e/vite.config.ts",
    url: `${BASE_URL}/e2e/harness/preview-harness.html`,
    reuseExistingServer: true,
    // Generous: a cold Vite start in this repo is tens of seconds (see vite.config.ts's warmup notes).
    timeout: 180_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
