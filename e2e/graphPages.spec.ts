// graphPages.spec.ts (#4188, epic #3604) — EVERY graph page loads in real Chromium.
//
// The runtime's own question, asked of the whole catalogue. `platformBoundary.test.ts` asks a textual one
// (does each import line's specifier resolve?); the loader compiles with esbuild-wasm, vendors the siblings
// into one module, and demands that every emitted `require()` resolve. esbuild-wasm cannot run in jsdom, so
// before this the only check on that was one hand-written spec for one page (#4185).
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";

test("every packaged graph page compiles and exports a component", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const results = await page.evaluate(() => window.__graphPagesHarness!.loadAll());

  // Non-vacuity: a catalogue that stopped resolving would make an empty pass look like a green sweep.
  expect(results.length).toBeGreaterThanOrEqual(8);

  const failed = results.filter((r) => r.error);
  expect(failed, `pages that failed to load:\n${failed.map((r) => `  ${r.pageId} → ${r.error}`).join("\n")}`)
    .toEqual([]);

  // …and each one picked a component, not `null` — `pickComponent` returning the wrong export is the #3874
  // failure, which mounted a row component instead of the page.
  for (const r of results) expect(r.component, `${r.pageId} exported a component`).toBeTruthy();
});
