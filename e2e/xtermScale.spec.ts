// xtermScale.spec.ts (`a-real-xterm-under-a-css-scale-is-only-observable-in-a-browser`)
//
// THE QUESTION: when the Glance graph is zoomed, does a click on an in-graph agent terminal land on the
// cell it visually points at? A morph is a world-layer child, so xterm renders under the graph's
// `transform: scale(view.scale)` (#2534, option A) — and xterm resolves a click by dividing a
// TRANSFORM-ADJUSTED offset (`getBoundingClientRect`) by an UNSCALED cell width (`offsetWidth`). The two
// only agree at scale 1.
//
// THIS IS THE ONLY PLACE THE ANSWER IS OBSERVABLE. jsdom has no layout and no cascade, so the vitest
// suite cannot distinguish a correct mapping from a broken one — which is exactly how #3524 shipped
// green (asserting the counter-scale MECHANISM) and was reverted eight minutes after merge, its own
// commit message conceding "NOT VERIFIED IN A RUNNING APP".
//
// So this spec asserts the OUTCOME and nothing else: click the visual centre of a known cell, read back
// the cell xterm itself reported over its SGR mouse channel — the same channel Claude Code's TUI reads —
// and require them to be the same cell.
//
// ONE LIMIT, STATED SO A GREEN RUN IS NOT OVER-READ: this is Chromium, and the app ships on WebKitGTK.
// A remedy that leans on layout-affecting CSS (`zoom`, say) can cancel correctly in one engine and not
// the other. The companion measurement is `bsc debug probe '.glance-card .xterm-screen'` against the
// RUNNING app, where `rect.width ÷ the element's CSS width` IS the factor xterm is off by, read out of
// the engine that actually ships. A pass here is necessary, not sufficient.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/xterm-scale-harness.html";

/** Grid size. Sized so the terminal stays inside the 1000×800 viewport at the LARGEST scale tested —
 *  a target cell scrolled off-screen would fail for a reason that has nothing to do with the defect. */
const COLS = 40, ROWS = 12;
/** The card's world position. Non-zero on purpose: a defect in the ORIGIN and a defect in the SCALE both
 *  vanish when the world sits at (0,0), and they are different bugs. */
const CARD = { x: 40, y: 40 };

/**
 * IS THE DEFECT STILL LIVE?
 *
 * Every test below asserts the CORRECT behaviour — the cell a click points at is the cell xterm
 * reports. Today they all fail except the scale-1 control, and this flag pins that: with it true they
 * are declared expected-failures, so the opt-in suite stays green while carrying an executable, exact
 * statement of a bug that is otherwise only describable in prose.
 *
 * THE POINT IS THAT IT CANNOT BE FORGOTTEN. Playwright fails a run when an expected-failure PASSES, so
 * the moment a remedy works the suite goes red and says so. Flipping this to `false` is therefore step
 * one of `the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom`, not a tidy-up afterwards —
 * and a remedy that only half-works cannot quietly land, because the flip is all-or-nothing.
 *
 * Do NOT reach for `test.skip` instead. A skipped test observes nothing; this one still runs, still
 * prints its measurement, and still notices the day the behaviour changes.
 */
const DEFECT_IS_LIVE = true;

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

test.describe("a click on an in-graph terminal lands on the cell it points at", () => {
  test.beforeEach(async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(HARNESS);
    await page.waitForFunction(() => !!window.__xtermScaleHarness);
    await page.evaluate(
      ([cols, rows, x, y]) => window.__xtermScaleHarness!.mount({ cols, rows, x, y }),
      [COLS, ROWS, CARD.x, CARD.y] as const,
    );
    expect(errors, "the harness must mount cleanly, or every assertion below is about the wrong thing").toEqual([]);
  });

  // The CONTROL. It passes today, and it has to: a failure here means the harness itself is wrong —
  // the wrong element measured, a stray page margin, a mouse report that never arrives — and would make
  // every red below unreadable. Never delete it to "save a case".
  test("scale 1 — the control, which must already pass", async ({ page }) => {
    for (const [c, r] of [[1, 1], [6, 3], [20, 6], [COLS, ROWS]] as const) {
      const p = await probe(page, 1, c, r);
      expect(p.actual, verdict(p, 1)).toEqual(p.expected);
    }
  });

  // ZOOMED IN. Reports come out too HIGH — and past roughly half the width they stop varying at all,
  // because `getMouseReportCoords` clamps the offset to `dimensions.css.canvas.width - 1`, which is the
  // UNSCALED width. So the right-hand half of a zoomed terminal collapses onto its last column: not an
  // off-by-a-bit, an entire region of the terminal that cannot be clicked at all.
  test("scale 2 — every click reports a cell further right and further down than the one aimed at", async ({ page }) => {
    test.fail(DEFECT_IS_LIVE, "clicks are off by the graph zoom until the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom lands");
    for (const [c, r] of [[6, 3], [10, 5], [20, 6]] as const) {
      const p = await probe(page, 2, c, r);
      expect(p.actual, verdict(p, 2)).toEqual(p.expected);
    }
  });

  // ZOOMED OUT. The error runs the other way, which is why both directions are tested: a remedy that
  // corrects one sign and not the other would pass a single-direction spec.
  test("scale 0.5 — every click reports a cell further left and further up than the one aimed at", async ({ page }) => {
    test.fail(DEFECT_IS_LIVE, "clicks are off by the graph zoom until the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom lands");
    for (const [c, r] of [[10, 4], [30, 9], [COLS, ROWS]] as const) {
      const p = await probe(page, 0.5, c, r);
      expect(p.actual, verdict(p, 0.5)).toEqual(p.expected);
    }
  });

  // Kills the most attractive wrong theory — "xterm just measured itself at the old scale; re-measure
  // and it will be fine". It will not: `CharSizeService.measure()` reads `offsetWidth`, which ignores
  // transforms entirely, so the cell width is the same number no matter when it was taken. Mounting
  // UNDER the scale and zooming INTO it must therefore be equally wrong — and equally right after a fix.
  test("the error does not depend on whether the scale was applied before or after the terminal mounted", async ({ page }) => {
    test.fail(DEFECT_IS_LIVE, "clicks are off by the graph zoom until the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom lands");
    const after = await probe(page, 2, 6, 3);

    await page.evaluate(() => window.__xtermScaleHarness!.setView({ tx: 0, ty: 0, scale: 2 }));
    await page.evaluate(
      ([cols, rows, x, y]) => window.__xtermScaleHarness!.mount({ cols, rows, x, y }),
      [COLS, ROWS, CARD.x, CARD.y] as const,
    );
    const before = await probe(page, 2, 6, 3);

    expect(before.actual, verdict(before, 2)).toEqual(after.actual);
    expect(before.actual, verdict(before, 2)).toEqual(before.expected);
  });

  // The instrument as a MEASUREMENT rather than a verdict. It prints the observed mapping across the
  // zoom range, so a candidate remedy can be judged by how the numbers move instead of by whether one
  // assertion flipped — which is the whole reason the previous attempt was merged on an eyeball.
  test("MEASURE — the reported-vs-aimed ratio across the zoom range", async ({ page }, testInfo) => {
    test.fail(DEFECT_IS_LIVE, "clicks are off by the graph zoom until the-in-graph-terminal-cannot-be-clicked-accurately-under-zoom lands");
    const rows: string[] = [];
    let worst = 0;
    for (const scale of [0.28, 0.5, 0.85, 1, 1.5, 2, 2.6]) {
      const p = await probe(page, scale, 6, 3);
      rows.push(verdict(p, scale));
      if (p.actual) {
        worst = Math.max(worst, Math.abs(p.actual.col - p.expected.col), Math.abs(p.actual.row - p.expected.row));
      } else {
        worst = Infinity;
      }
    }
    const table = rows.join("\n");
    await testInfo.attach("cell-mapping", { body: table, contentType: "text/plain" });
    console.log(`\n${table}\n`);
    // The zoom range is `useGraphViewport`'s own clamp [0.28, 2.6], so this covers everything a user can
    // actually reach — not a sample that happens to look good.
    expect(worst, `the worst cell error over the whole zoom range must be zero:\n${table}`).toBe(0);
  });
});
