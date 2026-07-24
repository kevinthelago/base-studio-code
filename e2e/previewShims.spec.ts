// previewShims.spec (#3696) — dynamic + safe module resolution, verified in real Chromium.
//
// jsdom can't run the esbuild-WASM bundle, so it can't observe the property under test: that a component
// importing native / unknown packages (react-native, expo-router, a made-up package) BUNDLES and RENDERS
// instead of throwing "Failed to resolve module specifier" in the iframe. This drives the REAL shipped
// chain (`bundleComponent` → `buildComponentSrcDoc`) and asserts the imports resolve to bundled-in local
// stubs and run without error — under the real preview CSP. Offline: the universal stub needs no React, so
// there is no CDN fetch.
import { test, expect, type Page } from "@playwright/test";

const HARNESS = "/e2e/harness/preview-harness.html";

// A component importing packages the preview does NOT curate as externals: `expo-router` (a real native
// package → universal stub) and a package that does not exist anywhere (→ universal stub). Neither pulls in
// React, so the whole resolution path is exercised with zero network. It also CALLS the stubbed values to
// prove they are safe to use (no-op router, black-hole hook), not merely importable.
const NATIVE_FIXTURE = `
import { Stack, useRouter, router } from "expo-router";
import { thing } from "totally-made-up-package-xyz";
const root = document.getElementById("root");
let out;
try {
  router.push("/x");            // a stubbed method call — must not throw
  const r = useRouter();        // a stubbed hook → a black-hole value
  r.push();                     // nested call on the hook result — must not throw
  const [a, b] = r.useSomething ? r.useSomething() : [1, 2]; // destructuring a black-hole is safe
  void a; void b;
  out = [typeof Stack, typeof useRouter, typeof thing].join(",");
} catch (e) {
  out = "ERR:" + (e && e.message);
}
const el = document.createElement("div");
el.id = "marker";
el.textContent = out;
root.appendChild(el);
export {};
`;

test("a component importing native/unknown packages bundles + renders under CSP (never 'failed to resolve')", async ({ page }: { page: Page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  // mountRaw rejects if the iframe posts an `error` (e.g. "Failed to resolve module specifier") — so a
  // resolution failure fails the test HERE, loudly, rather than as a missing element later.
  await page.evaluate((src) => window.__previewHarness!.mountRaw(src), NATIVE_FIXTURE);

  // The shipped srcdoc carries the CSP (read from the parent's iframe attribute — same-origin).
  const srcdoc = await page.locator("#preview").getAttribute("srcdoc");
  expect(srcdoc).toContain('http-equiv="Content-Security-Policy"');
  expect(srcdoc).toContain("connect-src 'none'");

  // Cross the sandbox's opaque origin to read what actually rendered inside the iframe.
  const frame = await (await page.locator("#preview").elementHandle())!.contentFrame();
  const marker = await frame!.evaluate(() => document.getElementById("marker")?.textContent ?? "");
  // Every native/unknown import resolved to a callable stub and every call was safe → no ERR.
  expect(marker).toBe("function,function,function");

  // The CSP did not refuse the inlined bundle, and nothing threw.
  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to|resolve module/i.test(e))).toEqual([]);
});
