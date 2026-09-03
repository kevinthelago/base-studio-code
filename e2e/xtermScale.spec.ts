// xtermScale.spec.ts (`a-real-xterm-under-a-css-scale-is-only-observable-in-a-browser`)
//
// THE QUESTION: when the Glance graph is zoomed, does a click on an in-graph agent terminal land on the
// cell it visually points at?
//
// It is a real question because of how xterm resolves a click — by dividing a TRANSFORM-ADJUSTED offset
// (`getBoundingClientRect`) by an UNSCALED cell width (`CharSizeService.measure` reads `offsetWidth`,
// which ignores transforms). Those two agree only at net CSS scale 1. A morph is a world-layer child, so
// under `scale(view.scale)` every click was off by the zoom.
//
// THIS IS THE ONLY PLACE THE ANSWER IS OBSERVABLE. jsdom has no layout and no cascade, so the vitest
// suite cannot distinguish a correct mapping from a broken one — which is exactly how #3524 shipped
// green (asserting a counter-scale MECHANISM) and was reverted eight minutes after merge, its own commit
// message conceding "NOT VERIFIED IN A RUNNING APP".
//
// So this asserts the OUTCOME and nothing else: click the visual centre of a known cell, read back the
// cell xterm itself reported over its SGR mouse channel — the same channel Claude Code's TUI reads — and
// require them to be the same cell.
//
// THE FIX IT COVERS is `the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom`: the card is a
// constant SCREEN size inside a world-positioned anchor carrying `scale(1/view.scale)`, so the net scale
// on the terminal is 1. The harness composes the app's OWN `viewTransform` + `counterScaleTransform`, so
// this cannot pass against geometry the app does not actually paint.
//
// ONE LIMIT, STATED SO A GREEN RUN IS NOT OVER-READ: this is Chromium, and the app ships on WebKitGTK.
// The companion measurement is `bsc debug probe '.glance-card .xterm-screen'` against the RUNNING app,
// where the ratio of the rect to the element's CSS width is the factor xterm is off by, read out of the
// engine that actually ships. A pass here is necessary, not sufficient.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/xterm-scale-harness.html";

/** Grid size. Sized so the terminal stays inside the 1000×800 viewport at the LARGEST scale tested —
 *  a target cell scrolled off-screen would fail for a reason that has nothing to do with the defect. */
const COLS = 40, ROWS = 12;
/** The card's position inside the anchor, screen px. Non-zero on purpose: a defect in the ORIGIN and a
 *  defect in the SCALE both vanish when everything sits at (0,0), and they are different bugs. */
const CARD = { x: 40, y: 40 };
/** Every zoom the viewport permits. `useGraphViewport` clamps to [0.28, 2.6], so this is the whole
 *  reachable range rather than a sample that happens to look good. */
const ZOOMS = [0.28, 0.5, 0.85, 1, 1.5, 2, 2.6];

interface Probe {
  /** The cell the click visually pointed at. */
  expected: { col: number; row: number };
  /** The cell xterm said it was. Null means no mouse report arrived at all. */
  actual: { col: number; row: number } | null;
}

/**
 * Click the visual centre of 1-based cell (col,row) and report what xterm made of it.
 *
 * The target point is derived the way a user's EYE derives it: the screen element's on-screen rect
 * divided by the public `cols`/`rows`. Nothing is read from xterm's internals — a harness that asked
 * xterm where its own cells were would be asking the suspect to testify.
 */
async function probe(
  page: import("@playwright/test").Page,
  scale: number,
  col: number,
  row: number,
): Promise<Probe> {
  await page.evaluate((s) => window.__xtermScaleHarness!.setView({ tx: 0, ty: 0, scale: s }), scale);
  await page.evaluate(() => window.__xtermScaleHarness!.clear());
  const { rect, geom } = await page.evaluate(() => ({
    rect: window.__xtermScaleHarness!.screenRect(),
    geom: window.__xtermScaleHarness!.geometry(),
  }));
  await page.mouse.click(
    rect.left + ((col - 0.5) * rect.width) / geom.cols,
    rect.top + ((row - 0.5) * rect.height) / geom.rows,
  );
  const actual = await page.evaluate(() => window.__xtermScaleHarness!.lastReport());
  return { expected: { col, row }, actual };
}

/** A one-line verdict carrying the MEASUREMENT, so a red run says how far off it is rather than only
 *  that it is off. The ratio is the diagnostic: it lands on the scale factor when the cause is the
 *  transform, and on something else when it is not. */
const verdict = (p: Probe, scale: number): string =>
  p.actual === null
    ? `scale ${scale}: no mouse report at all — the terminal never saw the click`
    : `scale ${scale}: aimed at cell (${p.expected.col},${p.expected.row}), xterm reported `
      + `(${p.actual.col},${p.actual.row}) — off by ×`
      + `${(p.actual.col / p.expected.col).toFixed(2)},${(p.actual.row / p.expected.row).toFixed(2)}`;

const goto = async (page: import("@playwright/test").Page, counterScale: boolean) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__xtermScaleHarness);
  await page.evaluate(
    ([cols, rows, x, y, cs]) =>
      window.__xtermScaleHarness!.mount({
        cols: cols as number, rows: rows as number,
        x: x as number, y: y as number, counterScale: cs as boolean,
      }),
    [COLS, ROWS, CARD.x, CARD.y, counterScale] as const,
  );
};

test.describe("a click on an in-graph terminal lands on the cell it points at", () => {
  test("THE GUARANTEE — every zoom in the reachable range maps a click to the right cell", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await goto(page, true);

    for (const scale of ZOOMS) {
      for (const [c, r] of [[1, 1], [6, 3], [20, 6], [COLS, ROWS]] as const) {
        const p = await probe(page, scale, c, r);
        expect(p.actual, verdict(p, scale)).toEqual(p.expected);
      }
    }
    expect(errors).toEqual([]);
  });

  test("the counter-scale is LOAD-BEARING — without it the same clicks are wrong", async ({ page }) => {
    // The justification for the anchor element existing at all, kept executable rather than written
    // down. Mount the PRE-FIX shape — the terminal directly under the world layer's `scale()` — and the
    // clicks miss again, by the zoom.
    //
    // IF THIS TEST EVER FAILS, do not "fix" it: it means xterm's cell math stopped depending on the
    // ancestor transform, and the right response is to check whether the anchor can be removed
    // entirely. That is a finding, not a regression.
    await goto(page, false);

    const off = await probe(page, 2, 6, 3);
    expect(off.actual, "the pre-fix shape must still mis-map, or the anchor is dead weight").not.toEqual(off.expected);

    const under = await probe(page, 0.5, 30, 9);
    expect(under.actual, "and in the other direction too").not.toEqual(under.expected);

    // At scale 1 the two shapes are indistinguishable, which is why zoom-1-only testing saw nothing.
    const one = await probe(page, 1, 6, 3);
    expect(one.actual, verdict(one, 1)).toEqual(one.expected);
  });

  test("the mapping does not depend on whether the scale was applied before or after mount", async ({ page }) => {
    // Kills the most attractive wrong theory — "xterm just measured itself at the old scale". It did
    // not: `CharSizeService.measure()` reads `offsetWidth`, which ignores transforms entirely, so the
    // cell width is the same number no matter when it was taken. Mounting UNDER a zoom and zooming INTO
    // one must therefore agree.
    await goto(page, true);
    const after = await probe(page, 2, 6, 3);

    await page.evaluate(() => window.__xtermScaleHarness!.setView({ tx: 0, ty: 0, scale: 2 }));
    await goto(page, true);
    await page.evaluate(() => window.__xtermScaleHarness!.setView({ tx: 0, ty: 0, scale: 2 }));
    const before = await probe(page, 2, 6, 3);

    expect(before.actual, verdict(before, 2)).toEqual(after.actual);
    expect(before.actual, verdict(before, 2)).toEqual(before.expected);
  });

  test("MEASURE — the reported-vs-aimed ratio across the zoom range", async ({ page }, testInfo) => {
    // The instrument as a MEASUREMENT rather than a verdict. It prints the observed mapping across the
    // whole range on every run, so a future change to this geometry is judged by how the numbers move
    // instead of by whether one assertion flipped — which is the reason the previous attempt was merged
    // on an eyeball and reverted eight minutes later.
    await goto(page, true);
    const rows: string[] = [];
    let worst = 0;
    for (const scale of ZOOMS) {
      const p = await probe(page, scale, 6, 3);
      rows.push(verdict(p, scale));
      worst = p.actual
        ? Math.max(worst, Math.abs(p.actual.col - p.expected.col), Math.abs(p.actual.row - p.expected.row))
        : Infinity;
    }
    const table = rows.join("\n");
    await testInfo.attach("cell-mapping", { body: table, contentType: "text/plain" });
    console.log(`\n${table}\n`);
    expect(worst, `the worst cell error over the whole zoom range must be zero:\n${table}`).toBe(0);
  });
});
