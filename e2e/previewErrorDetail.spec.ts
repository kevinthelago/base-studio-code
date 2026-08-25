// previewErrorDetail.spec (#108) — the srcdoc's error/unhandledrejection listeners must report the REAL
// error, not the browser's sanitized stub.
//
// jsdom can't observe this: the defect only shows up under real browser error-reporting rules for a
// `<script type="module">` mounted in a sandboxed, opaque-origin iframe (`sandbox="allow-scripts"`, no
// `allow-same-origin` — the same iframe `ComponentPreviewFrame` ships). For a module script, the browser
// hands `ErrorEvent.message` a near-empty stub ("Uncaught ") regardless of same-origin-ness, discarding the
// name/message/stack — which is what a design-studio designer session saw as a bare, undiagnosable "Script
// error." (request #108). The real detail is still on `ErrorEvent.error` — this only reproduces with a real
// browser mounting the actual shipped srcdoc.
import { test, expect, type Page } from "@playwright/test";

const HARNESS = "/e2e/harness/preview-harness.html";

const THROW_FIXTURE = `
throw new Error("boom from top-level module code");
export {};
`;

// `localStorage` throws a SYNCHRONOUS SecurityError in this sandbox (no `allow-same-origin`) rather than
// rejecting a promise — the exact shape request #108 called out for settings-shellselectorcard /
// settings-storagecard, which call it with no props and no way to fabricate around it.
const LOCALSTORAGE_FIXTURE = `
const x = localStorage.getItem("foo");
export {};
`;

const REJECTION_FIXTURE = `
Promise.reject(new Error("boom from a rejected promise"));
export {};
`;

// A rejection with a non-Error reason must still surface SOMETHING (the old \`String(e.reason)\` path),
// not silently vanish.
const STRING_REJECTION_FIXTURE = `
Promise.reject("boom string reason");
export {};
`;

async function mountRawExpectingError(page: Page, source: string): Promise<string> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  return page.evaluate(async (src) => {
    try {
      await window.__previewHarness!.mountRaw(src);
      return "NO ERROR REPORTED";
    } catch (e) {
      return String((e as Error).message);
    }
  }, source);
}

/**
 * An `unhandledrejection` is a MICROTASK — it fires after the module script's synchronous body finishes,
 * which is also when the srcdoc posts `ready`. So `mountRaw`'s reject-on-`error` race (built for a
 * SYNCHRONOUS throw) resolves via `ready` first and never observes it. This mounts, then listens on the
 * SAME correlated `message` channel the harness itself uses for a follow-up `__preview:"error"`.
 */
async function mountRawCapturingAsyncError(page: Page, source: string): Promise<string> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  return page.evaluate(async (src) => {
    const iframe = document.getElementById("preview") as HTMLIFrameElement;
    const errorPromise = new Promise<string>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (e.source !== iframe.contentWindow) return;
        const d = e.data as { __preview?: string; message?: unknown } | null;
        if (d && d.__preview === "error") {
          window.removeEventListener("message", onMsg);
          resolve(String(d.message));
        }
      };
      window.addEventListener("message", onMsg);
      setTimeout(() => { window.removeEventListener("message", onMsg); resolve("NO ERROR REPORTED"); }, 2000);
    });
    await window.__previewHarness!.mountRaw(src);
    return errorPromise;
  }, source);
}

test("a top-level module throw reports its message AND stack, not just 'Uncaught'", async ({ page }) => {
  const message = await mountRawExpectingError(page, THROW_FIXTURE);
  expect(message).toContain("boom from top-level module code");
  expect(message).toMatch(/at .+:\d+:\d+/); // a real stack frame rode along
});

test("a synchronous sandboxed-origin throw (localStorage) reports its name + message, not a bare stub", async ({ page }) => {
  const message = await mountRawExpectingError(page, LOCALSTORAGE_FIXTURE);
  expect(message).toContain("SecurityError");
  expect(message).toContain("sandboxed");
  expect(message).not.toContain("Uncaught \n"); // the sanitized stub this bug reported
});

test("a rejected promise with an Error reason reports its message AND stack", async ({ page }) => {
  const message = await mountRawCapturingAsyncError(page, REJECTION_FIXTURE);
  expect(message).toContain("boom from a rejected promise");
  expect(message).toMatch(/at .+:\d+:\d+/);
});

test("a rejected promise with a non-Error reason still reports the reason", async ({ page }) => {
  const message = await mountRawCapturingAsyncError(page, STRING_REJECTION_FIXTURE);
  expect(message).toContain("boom string reason");
});
