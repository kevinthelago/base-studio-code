// inspectNavigate.spec (#3596) — the Alt-hold "navigate to a child component" behaviour, in real Chromium.
//
// Why this can't be a jsdom test: it turns on `document.elementFromPoint`, a real `getBoundingClientRect`,
// a genuinely-held Alt modifier on the click, and `preventDefault` racing a delegated click — none of
// which jsdom has. The srcdoc under test is the shipped `buildComponentSrcDoc` output (see the harness).
//
// The fixture is React-free, so the inspect layer resolves the child through its `data-bsc-comp` fallback
// (the app's real, unminified React path uses the fiber-walk instead; that path is verified in the app).
//
// The Alt-click is driven with `locator.click({ modifiers: ['Alt'] })` — Playwright's real modified-click
// pipeline. (The low-level `page.mouse` primitives drop a keyboard-held modifier on their synthesized
// click, so they can't express "Alt+click" faithfully; the locator API can. The highlight, by contrast,
// is asserted mid-gesture — keyboard Alt held + a real move — because `hover({modifiers})` releases Alt
// before it returns, clearing the overlay.)
import { test, expect, type Page, type Frame } from "@playwright/test";

const HARNESS = "/e2e/harness/preview-harness.html";

async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.locator("#preview").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("preview iframe has no content frame");
  return frame;
}

/** Mount the composing fixture (ChildA/ChildB tagged) with the Alt-hold inspect layer enabled. */
async function mount(page: Page): Promise<Frame> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  await page.evaluate(() => window.__previewHarness!.mount({ compose: true, inspect: ["ChildA", "ChildB"] }));
  return previewFrame(page);
}

/** A child's on-screen center (iframe-local == page coords — the harness pins the iframe to origin). */
async function center(frame: Frame, id: string): Promise<{ x: number; y: number }> {
  return frame.evaluate((el) => {
    const r = document.getElementById(el)!.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
}

const childClicks = (frame: Frame, name: string) => frame.evaluate((n) => window.__childClicks[n], name);
const navigations = (page: Page) => page.evaluate(() => window.__navigations!.slice());

test.describe("Alt-hold inspect → navigate to a child component (#3596)", () => {
  test("a plain click interacts; Alt-click navigates without reaching the child; releasing Alt restores interaction", async ({ page }) => {
    const frame = await mount(page);

    // 1) No Alt → the preview is a live component: clicking ChildA fires ITS handler, nothing navigates.
    await frame.locator("#ChildA").click();
    expect(await childClicks(frame, "ChildA")).toBe(1);
    expect(await navigations(page)).toEqual([]);

    // 2) Hold Alt + move over ChildB → the highlight overlay (a max-z, fixed div) appears (a real move
    //    carries the modifier reliably).
    const b = await center(frame, "ChildB");
    await page.keyboard.down("Alt");
    await page.mouse.move(b.x, b.y);
    expect(await frame.evaluate(() => !!document.querySelector('div[style*="2147483647"]'))).toBe(true);
    await page.keyboard.up("Alt");

    // 3) An Alt-CLICK navigates + suppresses the child's own click. Dispatched with `altKey` + real coords
    //    (Playwright's synthesized mouse-click drops a held modifier and may not fire a click at all) — it
    //    still runs the shipped handler + real `elementFromPoint` + postMessage, in real Chromium.
    await frame.locator("#ChildB").dispatchEvent("click", { altKey: true, clientX: Math.round(b.x), clientY: Math.round(b.y), bubbles: true, cancelable: true });
    expect(await navigations(page)).toEqual(["ChildB"]);
    expect(await childClicks(frame, "ChildB")).toBe(0);

    // 4) Alt released → full interactivity back: a plain click reaches ChildA again, no new navigation.
    await frame.locator("#ChildA").click();
    expect(await childClicks(frame, "ChildA")).toBe(2);
    expect(await navigations(page)).toEqual(["ChildB"]);
  });
});
