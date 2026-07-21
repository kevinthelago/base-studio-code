// previewInteraction.spec (#3264) — INTERACTION verification over the pure srcdoc, in real Chromium.
//
// The class of bug this exists to catch: #3251, where drag stopped panning the Design Studio preview
// because the crisp engine lost its text-selection guard. Three regressions in the #3190 arc shipped
// green, because jsdom has no text selection, no native drag, no layout and no CSS cascade — a synthetic
// `mousedown`/`mousemove` pans perfectly there whether or not a browser would. The test environment
// could not observe the property under test.
//
// Everything below is driven by `page.mouse`, which dispatches through Chromium's REAL input pipeline
// (CDP `Input.dispatchMouseEvent`), so a drag across a paragraph genuinely tries to select text and a
// press on an `<img>` genuinely tries to start a native drag. The srcdoc under test is the shipped
// `buildComponentSrcDoc` output — see `harness/previewHarness.ts` for why that is the real path.
import { test, expect, type Page, type Frame } from "@playwright/test";

const HARNESS = "/e2e/harness/preview-harness.html";

/** A rect in iframe-local CSS pixels. The harness pins the iframe to the page origin, so these are also
 *  page coordinates — no offset conversion, and therefore no place for an off-by-one to hide. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The srcdoc frame. `contentFrame()` crosses the sandbox's opaque origin, which `page.frame({url})`
 *  cannot be relied on to match (a srcdoc frame's url is the bare `about:srcdoc`). */
async function previewFrame(page: Page): Promise<Frame> {
  const handle = await page.locator("#preview").elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error("preview iframe has no content frame");
  return frame;
}

/** Mount the fixture through the shipped bundle → srcdoc chain and hand back its frame. */
async function mount(page: Page, opts: { zoomEngine?: boolean; tall?: boolean } = {}): Promise<Frame> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__previewHarness);
  await page.evaluate((o) => window.__previewHarness!.mount(o), opts);
  return previewFrame(page);
}

/** `#root`'s live translation, read from the COMPUTED transform — i.e. what the browser actually applied,
 *  not what the engine believes it set. A pan moves e/f of the matrix. */
async function pan(frame: Frame): Promise<{ x: number; y: number }> {
  const t = await frame.evaluate(() => {
    const root = document.getElementById("root");
    return root ? getComputedStyle(root).transform : "none";
  });
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return { x: 0, y: 0 }; // "none" — identity
  const parts = m[1].split(",").map((s) => Number(s.trim()));
  return { x: parts[4] ?? 0, y: parts[5] ?? 0 };
}

/** `#root`'s live scale, read from the COMPUTED transform matrix (`a`) — what the browser actually applied. */
async function scaleOf(frame: Frame): Promise<number> {
  const t = await frame.evaluate(() => {
    const root = document.getElementById("root");
    return root ? getComputedStyle(root).transform : "none";
  });
  const m = /matrix\(([^)]+)\)/.exec(t);
  if (!m) return 1; // "none" — identity
  return Number(m[1].split(",")[0]?.trim() ?? 1);
}

async function rectOf(frame: Frame, selector: string): Promise<Rect> {
  return frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`fixture element not found: ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }, selector);
}

/**
 * A real press-move-release, at HUMAN gesture granularity — roughly 2 CSS px per move.
 *
 * The step size is load-bearing, not cosmetic, and getting it wrong silently defeats the whole harness.
 * The engine only starts panning (and only starts calling `preventDefault`) once the pointer has moved
 * past a 5px threshold. A coarse drag — say `{ steps: 24 }` over 300px, i.e. 12.5px per move — clears
 * that threshold on the FIRST move, so the engine suppresses the browser's default action before a text
 * selection can ever begin. Under that gesture the #3251 build passes: the bug is invisible.
 *
 * A real drag emits many sub-5px moves first. Those land while the engine is still below its threshold
 * and doing nothing, which is exactly the window in which Chromium starts a selection drag — and once
 * started, `preventDefault` on later mousemoves does not cancel it (only `mousedown` could have). That
 * window is where #3251 lived, so the harness has to reproduce it.
 */
async function dragBy(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  const steps = Math.max(24, Math.ceil(Math.hypot(dx, dy) / 2));
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps });
  await page.mouse.up();
}

/** What the browser currently has selected inside the preview document. Empty string ⇒ nothing selected. */
async function selectedText(frame: Frame): Promise<string> {
  return frame.evaluate(() => String(document.getSelection() ?? ""));
}

test.describe("preview srcdoc — real interaction", () => {
  test("#3251 regression — dragging over text PANS and selects nothing", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const text = await rectOf(frame, "#txt");
    expect(await pan(frame)).toEqual({ x: 0, y: 0 });

    // The exact gesture that broke: a horizontal drag straight across a paragraph — indistinguishable
    // from a user selecting a sentence, which is precisely why the guard has to be inside the iframe.
    await dragBy(page, { x: text.x + 40, y: text.y + text.h / 2 }, 300, 0);

    // Panned. (Tolerance absorbs sub-pixel rounding in the interpolated move stream.)
    const moved = await pan(frame);
    expect(moved.x).toBeGreaterThan(280);
    expect(moved.x).toBeLessThan(320);

    // …and nothing was selected. NOTE ON WHAT THIS DOES AND DOES NOT PROVE: this assertion pins the
    // user-visible outcome, but it is NOT on its own a discriminating test of #3251's `user-select`
    // guard. Measured in real Chromium (see the sibling cascade test): once the pan engages, `#root`
    // translates in lockstep with the cursor, so there is no relative motion between pointer and text;
    // the only window with any relative motion is the sub-threshold prefix, which is bounded at <5px —
    // narrower than one character. So a drag cannot grow a selection here even with the guard removed.
    // The guard is pinned by `user-select is suppressed…` below; this keeps the end-to-end outcome honest.
    expect(await selectedText(frame)).toBe("");
  });

  test("#3251 regression — user-select is suppressed on the body but preserved on form fields", async ({ page }) => {
    // The discriminating assertion for #3251's first fix. It is a COMPUTED-STYLE read inside the
    // srcdoc — which is precisely what jsdom cannot do: jsdom has no cascade, so it reports the
    // specified value of whatever rule it happens to see and cannot tell you which declaration won
    // across the srcdoc's four `<style>` blocks (base, engine, injected app CSS in that order). Here the
    // browser resolves the real cascade, so removing the guard from `engineCss` flips these to "auto".
    const frame = await mount(page, { zoomEngine: true });
    const computed = await frame.evaluate(() => ({
      body: getComputedStyle(document.body).userSelect,
      field: getComputedStyle(document.getElementById("field")!).userSelect,
      text: getComputedStyle(document.getElementById("txt")!).userSelect,
    }));
    expect(computed.body).toBe("none");
    expect(computed.text).toBe("none"); // inherited — the whole preview surface is drag-safe
    expect(computed.field).toBe("text"); // …except form fields, which keep caret + selection
  });

  test("#3251 regression — dragging from an <img> pans instead of starting a native drag", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const pic = await rectOf(frame, "#pic");

    // A press on a replaced element is a native image-drag candidate. If `dragstart` is not cancelled the
    // browser takes over the gesture and the mousemove stream stops dead, so the pan dies mid-drag.
    await dragBy(page, { x: pic.x + pic.w / 2, y: pic.y + pic.h / 2 }, 200, 0);

    const moved = await pan(frame);
    expect(moved.x).toBeGreaterThan(180);
    expect(await selectedText(frame)).toBe("");
  });

  test("a plain click still reaches a control", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const btn = await rectOf(frame, "#btn");

    await page.mouse.click(btn.x + btn.w / 2, btn.y + btn.h / 2);

    // The engine intercepts mousedown on EVERYTHING (that is how a drag over a button can pan), so a
    // press-without-move still reaching the button's own click handler is a real, breakable property.
    expect(await frame.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(1);
    expect(await pan(frame)).toEqual({ x: 0, y: 0 });

    // …and the control took FOCUS. This is the half of the #3251 arc that pulls the other way: the
    // obvious way to stop a drag selecting text is to `preventDefault()` the mousedown, and that is
    // exactly what 0cadb3f7 had to REMOVE, because it also swallows focus on real controls. Without this
    // assertion the suite would happily green-light "fixing" #3251 by reintroducing that regression.
    expect(await frame.evaluate(() => document.activeElement?.id ?? "")).toBe("btn");
  });

  test("a moved drag STARTING on a control pans and suppresses its trailing click", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const btn = await rectOf(frame, "#btn");

    await dragBy(page, { x: btn.x + btn.w / 2, y: btn.y + btn.h / 2 }, 160, 60);

    expect((await pan(frame)).x).toBeGreaterThan(140);
    expect(await frame.evaluate(() => (window as unknown as { __clicks: number }).__clicks)).toBe(0);
  });

  test("a form field still selects text, and does not pan", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const field = await rectOf(frame, "#field");

    // The engine's DRAG_NATIVE carve-out must leave a form field its native caret + selection drag.
    await dragBy(page, { x: field.x + 12, y: field.y + field.h / 2 }, 180, 0);

    const selection = await frame.evaluate(() => {
      const el = document.getElementById("field") as HTMLInputElement;
      return { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 };
    });
    expect(selection.end).toBeGreaterThan(selection.start);

    // …and the drag was NOT stolen by the pan.
    expect(await pan(frame)).toEqual({ x: 0, y: 0 });
  });

  test("the app's real CSS cascade reaches the iframe", async ({ page }) => {
    // `collectAppCss()` is exercised unmodified against a live document (see previewHarness.ts). Assert
    // its output actually LANDED — a design token resolving inside the opaque-origin srcdoc is the only
    // honest proof the injected cascade crossed the document boundary.
    const frame = await mount(page, { zoomEngine: true });
    const token = await frame.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim(),
    );
    // `oklch()` is one of the things the issue calls out as unresolvable in jsdom — seeing the real
    // token value arrive is proof the harness is looking at a real cascade.
    expect(token).toContain("oklch");
  });

  test("opens FIT — the whole component is visible (#3551)", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    // Fit runs after the deferred module mounts, so poll. It never upscales past 1:1 (crisp) …
    await expect.poll(() => scaleOf(frame)).toBeLessThanOrEqual(1);
    expect(await scaleOf(frame)).toBeGreaterThan(0);
    // …and the LAST element (the image at the bottom of the fixture) sits within the viewport, so the
    // whole component is shown rather than the top being cropped — the "full component rendered in" goal.
    await expect
      .poll(() =>
        frame.evaluate(() => {
          const last = document.getElementById("pic");
          if (!last) return false;
          return last.getBoundingClientRect().bottom <= (window.innerHeight || 1) + 1;
        }),
      )
      .toBe(true);
  });

  test("renders the ENTIRE height — off-screen overflow is not clipped away (#3551)", async ({ page }) => {
    // A component ~1900px tall in the 600px frame: it MUST scale down and show the whole thing, including
    // the bottom edge that starts off-screen. The earlier bug clipped `#root`/the wrapper to the frame
    // height, so scaling only shrank the clip window and the bottom never rendered.
    const frame = await mount(page, { zoomEngine: true, tall: true });
    // Fit fires after the deferred mount; poll until the tall component is scaled down to fit.
    await expect.poll(() => scaleOf(frame)).toBeLessThan(1);

    const bottom = await frame.evaluate(() => {
      const el = document.getElementById("bottom");
      if (!el) return { inView: false, painted: false };
      const r = el.getBoundingClientRect();
      const inView = r.top >= -1 && r.bottom <= (window.innerHeight || 1) + 1;
      // elementFromPoint RESPECTS clipping: if #root/the wrapper clipped the bottom away, the point hits the
      // clipper (or nothing), not the marker. So this is the discriminating check the layout-only test missed.
      const hit = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
      const painted = !!hit && (hit === el || el.contains(hit));
      return { inView, painted };
    });
    expect(bottom.inView).toBe(true);  // fit brought the off-screen bottom into the frame
    expect(bottom.painted).toBe(true); // …and it is actually rendered, not clipped
  });

  test("scroll wheel ZOOMS (up = in, down = out); drag is what pans (#3551)", async ({ page }) => {
    const frame = await mount(page, { zoomEngine: true });
    const box = (await page.locator("#preview").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const s0 = await scaleOf(frame);
    await page.mouse.wheel(0, -300); // scroll UP → zoom IN
    await expect.poll(() => scaleOf(frame)).toBeGreaterThan(s0);

    const s1 = await scaleOf(frame);
    await page.mouse.wheel(0, 600); // scroll DOWN → zoom OUT
    await expect.poll(() => scaleOf(frame)).toBeLessThan(s1);

    // The wheel did NOT pan (translation stays put beyond the zoom-about-cursor adjustment is fine, but a
    // pure scroll must not run away horizontally the way the old wheel-pan did): a drag is what pans.
    await dragBy(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, 120, 0);
    expect((await pan(frame)).x).not.toBe(0);
  });
});
