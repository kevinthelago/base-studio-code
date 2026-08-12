// graphPrimitive.spec.ts (ui-registry-resolves-from-the-graph) — the render seam, with the REAL compile.
//
// The vitest twin (`src/shared/ui/spec/graphPrimitive.test.tsx`) mocks the loader, because esbuild-WASM has
// no Node path. So it proves the wiring and stops there. This proves the thing that actually matters: a
// record's source, compiled for real, is what KitRenderer puts in the DOM — and the bundled component is
// what survives when there is no record or the record is broken.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/primitive-harness.html";

test("the spec renderer mounts the RECORD's primitive, and falls back to the bundled one", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__primitiveHarness);

  // 1 · No record provides the specifier → the bundled Text renders. 24 of 69 manifest primitives are in
  //     this state today (Slot permanently), so this is the common path, not an edge case.
  await page.evaluate(() => window.__primitiveHarness!.mountBundled());
  await expect(page.getByText("hello")).toBeVisible();
  await expect(page.getByTestId("from-the-graph")).toHaveCount(0);

  // 2 · A record provides it → the GRAPH copy replaces the bundled fallback. Both render "hello", so the
  //     marker is the only thing that distinguishes them — "it rendered" would prove nothing.
  await page.evaluate(() => window.__primitiveHarness!.mountGraph());
  await expect(page.getByTestId("from-the-graph")).toHaveText("hello");

  // 3 · A BROKEN EDIT to a record that has compiled before keeps rendering the LAST GOOD graph version —
  //     GraphComponent's gate (path 1) prefers it over an empty surface, and it outranks the bundled
  //     fallback. Asserted because it is easy to mistake for "the fallback did not fire".
  await page.evaluate(() => window.__primitiveHarness!.mountBrokenEdit());
  await expect(page.getByTestId("from-the-graph")).toHaveText("hello");

  // 4 · A record that has NEVER compiled has no last-good, so the BUNDLED component is what survives.
  //     Never a blank: a primitive that renders nothing is indistinguishable from "the data said render
  //     nothing". This is the path a bad record takes on a cold load, which is the one that ships.
  await page.evaluate(() => window.__primitiveHarness!.mountBrokenFresh());
  await expect(page.getByText("hello")).toBeVisible();
  await expect(page.getByTestId("from-the-graph")).toHaveCount(0);

  expect(errors).toEqual([]);
});
