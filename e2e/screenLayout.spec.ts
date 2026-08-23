// The Screen body must CONSTRAIN a filling page, not grow to it.
//
// WHY THIS IS AN E2E AND NOT A UNIT TEST. The bug is a computed `display` on a shared class, and its
// symptom is a height — jsdom has no layout and no cascade, so it cannot observe either. This renders the
// REAL `tokens.css` in real Chromium against the same DOM shape the Screen produces.
//
// The shape it pins, measured in the app before the fix: `.screen-body` height 732 with scrollHeight
// 15330, because it was `display: block` and the page's `flex: 1` meant nothing. The rail's ~15,000px
// component tree set the height and the whole screen became a scroller, while the rail itself — the thing
// that should have scrolled — never did.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/screen-layout-harness.html";

test("the Screen body constrains a filling page instead of growing to it", async ({ page }) => {
  await page.goto(HARNESS);
  const m = await page.evaluate(() => {
    const body = document.querySelector(".screen-body") as HTMLElement;
    const fill = document.querySelector(".fill-page") as HTMLElement;
    const pane = document.querySelector(".tall-pane") as HTMLElement;
    return {
      bodyDisplay: getComputedStyle(body).display,
      bodyH: Math.round(body.getBoundingClientRect().height),
      bodyScrollH: body.scrollHeight,
      fillH: Math.round(fill.getBoundingClientRect().height),
      paneH: Math.round(pane.getBoundingClientRect().height),
      paneScrollH: pane.scrollHeight,
    };
  });

  // The body must be a flex CONTAINER, not merely a flex item.
  expect(m.bodyDisplay).toBe("flex");
  // It must not scroll: a filling page is clamped to it, not the other way round.
  expect(m.bodyScrollH, `body scrollHeight ${m.bodyScrollH} vs height ${m.bodyH}`).toBeLessThanOrEqual(m.bodyH + 2);
  // The page fills the body rather than the 9000px its content wants.
  expect(m.fillH).toBeGreaterThan(0);
  expect(m.fillH).toBeLessThanOrEqual(m.bodyH + 2);
  // And the TALL PANE scrolls internally — the behaviour that was missing, and the reason the left pane
  // dragged the whole screen instead of overflowing on its own.
  expect(m.paneH).toBeLessThanOrEqual(m.bodyH + 2);
  expect(m.paneScrollH, "the pane's own content must overflow IT, not the screen").toBeGreaterThan(m.paneH + 100);
});
