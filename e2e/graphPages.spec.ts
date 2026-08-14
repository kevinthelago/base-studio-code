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

// The oracle the compile sweep above is NOT. A record can compile, export a good component, and still
// take the app down the moment something mounts it — `Cannot read properties of null (reading
// 'useCallback')` is a hook resolving against a null dispatcher, which is a property of the RUNNING
// module and has no static signature. At 02:00 a designer's five rewrites left 8 of 9 workspaces dead
// while every compile-level check stayed green, and `bsc ui set`'s syntax gate had passed each write.
test("every packaged graph page MOUNTS, not merely compiles", async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const results = await page.evaluate(() => window.__graphPagesHarness!.mountAll());

  expect(results.length).toBeGreaterThanOrEqual(8); // non-vacuity, as above

  const failed = results.filter((r) => r.error);
  expect(failed, `pages that failed to MOUNT:\n${failed.map((r) => `  ${r.pageId} → ${r.error}`).join("\n")}`)
    .toEqual([]);

  // A page that mounts to an EMPTY tree passed the boundary without rendering anything, which reads as a
  // pass and is not one. Every real page paints SOME DOM — a header, an empty state, a grid shell.
  //
  // Elements, not text: `consolepage` on a pristine store renders its grid with zero panes in it, so a
  // character count called the app's central surface blank on the first run. That is the false finding
  // the harness header warns about, and the cheapest place to not have it is here.
  const blank = results.filter((r) => !r.error && !r.nodes);
  expect(blank, `pages that mounted but rendered no DOM:\n${blank.map((r) => `  ${r.pageId}`).join("\n")}`)
    .toEqual([]);
});
