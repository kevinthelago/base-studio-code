// glanceGraph.spec.ts (#4185, epic #3604) — the Glance record set compiles and loads in real Chromium.
//
// The migration's own gate. `platformBoundary.test.ts` asks a TEXTUAL question (is each import line's
// specifier registered?); the loader asks a different one — it compiles with esbuild-wasm, vendoring the
// eight siblings into one module, and then every emitted `require()` must resolve. esbuild-wasm cannot run
// in jsdom, so this is the only place the real question gets asked before a dev instance.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/glance-harness.html";

test("the Glance records compile as one module and export a component", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__glanceHarness);
  const result = await page.evaluate(() => window.__glanceHarness!.load());

  // All nine records ship — a glob that stopped matching would make the load below trivially small.
  expect(result.ids).toEqual([
    "glance-canvas",
    "glance-chat-dock",
    "glance-inspector",
    "glance-node",
    "glance-plan-screen",
    "glance-preview-morph",
    "glance-session-log",
    "glance-stream-morph",
    "glancepage",
  ]);
  // …and the loader picked the PAGE, not a sibling or a re-exported helper — the #3874 failure, where
  // `pickComponent` took the first exported function and mounted the wrong one.
  expect(result.component).toBe("GlanceWorkspace");

  // An unresolved import throws a NAMED error from `makeRequire` at eval time, which would surface here.
  expect(errors).toEqual([]);
});
