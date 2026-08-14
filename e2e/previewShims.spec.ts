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

// The DECLARED BOUNDARY (#3897). A registered platform module is not in the preview's mem filesystem, so
// before its stub arm existed esbuild failed the whole bundle with "Could not resolve @/store" — which is
// why the doctor called these components healthy and the preview refused to build them. jsdom can't run
// esbuild-wasm, so only real Chromium can observe that the stub actually BUILDS and its bindings are usable.
const BOUNDARY_FIXTURE = `
import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
const root = document.getElementById("root");
let out;
try {
  const projects = useAppStore((s) => s.projects); // a stubbed hook → a black-hole value
  const n = [...projects].length;                  // iterating a black-hole is safe
  void n;
  out = [typeof useAppStore, typeof Stack].join(",");
} catch (e) {
  out = "ERR:" + (e && e.message);
}
const el = document.createElement("div");
el.id = "marker";
el.textContent = out;
root.appendChild(el);
export {};
`;

// An INDEX module must be identified by its index file, or its own `./sibling` imports resolve against
// the index's PARENT. jsdom cannot see this — only a real esbuild run resolves module identities — and it
// is what made `@/shared/ui/kit` fail with 19 "module not found: shared/ui/<x>" errors for files that sit
// at `shared/ui/kit/<x>`, breaking every component that reaches the kit barrel transitively.
const INDEX_FIXTURE = `
import { ThemeScope, token } from "@/shared/ui/kit";
const root = document.getElementById("root");
const el = document.createElement("div");
el.id = "marker";
el.textContent = [typeof ThemeScope, token].join(",");
root.appendChild(el);
export {};
`;

test("an index module resolves its OWN siblings, not its parent's (the kit barrel, #57)", async ({ page }: { page: Page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  // A hand-built mem filesystem standing in for the packaged closure: the barrel re-exports two
  // siblings by RELATIVE path, exactly as `shared/ui/kit/index.ts` does.
  await page.evaluate((src) => window.__previewHarness!.mountFiles!({
    "fixture.ts": src,
    "shared/ui/kit/index.ts": 'export { ThemeScope } from "./ThemeScope";\nexport { token } from "./theme";\n',
    "shared/ui/kit/ThemeScope.tsx": "export function ThemeScope() { return null; }\n",
    "shared/ui/kit/theme.ts": 'export const token = "kit-theme";\n',
  }, "fixture.ts"), INDEX_FIXTURE);

  const frame = await (await page.locator("#preview").elementHandle())!.contentFrame();
  expect(await frame!.evaluate(() => document.getElementById("marker")?.textContent ?? "")).toBe("function,kit-theme");
  expect(consoleErrors.filter((e) => /resolve module|module not found/i.test(e))).toEqual([]);
});

test("a component importing a REGISTERED platform module bundles + renders (the declared boundary, #3897)", async ({ page }: { page: Page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  // `files` holds ONLY the fixture, so `@/store` and `@/shared/ui/layout/Stack` are unvendored — exactly
  // the path under test. Without the boundary stub, bundleComponent throws here and mountRaw rejects.
  await page.evaluate((src) => window.__previewHarness!.mountRaw(src), BOUNDARY_FIXTURE);

  const frame = await (await page.locator("#preview").elementHandle())!.contentFrame();
  const marker = await frame!.evaluate(() => document.getElementById("marker")?.textContent ?? "");
  expect(marker).toBe("function,function");

  expect(consoleErrors.filter((e) => /Content Security Policy|Refused to|resolve module/i.test(e))).toEqual([]);
});

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
