// previewSnapshot.spec (epic-job-applications) — the preview document describes itself on request.
//
// The host cannot READ the preview iframe: it is `sandbox="allow-scripts"` with an opaque origin. The Jobs screen
// still has to PRINT exactly what that iframe shows, so the srcdoc answers `{ __snapshot: { id, selector } }` with
// the matching element's outerHTML. This drives the shipped `bundleComponent` → `buildComponentSrcDoc` chain in
// real Chromium, where jsdom could not run the srcdoc at all. Offline: the fixture is plain DOM, no React.
import { test, expect, type Page } from "@playwright/test";

const HARNESS = "/e2e/harness/preview-harness.html";

const FIXTURE = `
const a = document.createElement("article");
a.setAttribute("data-document", "resume");
a.innerHTML = '<style>@page { size: A4; margin: 15mm; } .sheet { color: #111 }</style><h1 class="sheet">Sam Park</h1><p>Cut p99 by 40%.</p>';
document.getElementById("root").appendChild(a);
`;

async function snapshot(page: Page, selector: string): Promise<string | null> {
  return page.evaluate(
    (sel) =>
      new Promise<string | null>((resolve, reject) => {
        const frame = document.getElementById("preview") as HTMLIFrameElement;
        const id = Math.random();
        const onMsg = (e: MessageEvent) => {
          const r = e.data && e.data.__snapshotReply;
          if (!r || r.id !== id || e.source !== frame.contentWindow) return;
          window.removeEventListener("message", onMsg);
          resolve(r.html);
        };
        window.addEventListener("message", onMsg);
        frame.contentWindow!.postMessage({ __snapshot: { id, selector: sel } }, "*");
        setTimeout(() => reject(new Error("the preview never answered the snapshot")), 5000);
      }),
    selector,
  );
}

test("the preview answers a snapshot with the element's markup, print CSS included", async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  await page.evaluate((src) => window.__previewHarness!.mountRaw(src), FIXTURE);
  const html = await snapshot(page, "[data-document]");
  expect(html).toContain('data-document="resume"');
  expect(html).toContain("@page { size: A4; margin: 15mm; }");
  expect(html).toContain("<h1 class=\"sheet\">Sam Park</h1>");
});

test("a selector that matches nothing answers null rather than hanging", async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  await page.evaluate((src) => window.__previewHarness!.mountRaw(src), FIXTURE);
  expect(await snapshot(page, "[data-nothing]")).toBeNull();
  expect(await snapshot(page, "::not a selector")).toBeNull();
});
