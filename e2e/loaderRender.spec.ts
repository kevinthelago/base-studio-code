// loaderRender.spec.ts (#3635) — the runtime loader end-to-end in real Chromium. jsdom structurally cannot
// run the loader's esbuild-WASM compile, so this drives the REAL chain (source → esbuild → eval → registry →
// render) in a browser: the coverage the deleted Fleet.tsx render tests (#3608) point to, on the mechanism
// rather than the fragile store/Tauri-bound live page (see harness/loaderHarness.ts for why).
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/loader-harness.html";

test("runtime loader: graph source compiles + renders with real modules + a vendored sibling", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__loaderHarness);
  await page.evaluate(() => window.__loaderHarness!.load());

  // esbuild compiled the source, `@/store` resolved to the registered module, and a real React hook ran.
  await expect(page.getByTestId("probe")).toHaveText("tally:7 clicks:0");
  // A REAL shared/ui primitive (Text) resolved through the registry and rendered — not a stub.
  await expect(page.getByText("from a real shared/ui Text")).toBeVisible();
  // The graph SIBLING was VENDORED (from the resolver) into the same compile and rendered.
  await expect(page.getByTestId("sibling")).toHaveText("sibling:vendored");
  // GRAPH-FIRST (#3660): a graph component PROVIDES "@/shared/ui/probe-tile", overriding the registered
  // platform module → the DATA version renders ("graph"), not the bundled one ("platform").
  await expect(page.getByTestId("provide")).toHaveText("graph");
  // The loaded component's OWN useState updates on click — proof it shares the app's ONE React instance
  // (a second copy would throw "Invalid hook call" instead of re-rendering).
  await page.getByTestId("bump").click();
  await expect(page.getByTestId("probe")).toHaveText("tally:7 clicks:1");

  expect(errors).toEqual([]);
});
