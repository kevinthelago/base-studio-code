// Colour resolution against the REAL cascade (`graph-colours-fall-back-because-the-tokens-are-oklch`).
//
// WHY THIS CANNOT BE A UNIT TEST. The defect was the interaction of two things jsdom does not have: the
// app's tokens (46 of them are `oklch()`) and the engine's serialisation of a computed colour. The old
// resolver matched `/rgba?\(([^)]+)\)/` against `getComputedStyle(el).color`; WebKitGTK answers
// `oklch(0.72 0.1 230)`, so the match failed on EVERY colour and the graph rendered its fallback grey —
// grey card, grey label, near-white role dot. Every existing test passed `rgb()` literals straight to
// `setPalette`, so the whole suite was green while nothing on screen had a themed colour.
//
// THE ORACLE IS INDEPENDENT, not a second copy of the code under test: `oklchToSrgb` below is the
// standard OKLab → linear sRGB → sRGB transform, written from the spec. It agrees with WebKitGTK to the
// BYTE on `--info` (both say 91,176,215), which is what makes it worth asserting against — a tolerance
// wide enough to hide a channel swap would not be.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/css-color-harness.html";

/** OKLCH → sRGB bytes. Independent implementation; see the header. */
function oklchToSrgb(L: number, C: number, hDeg: number): number[] {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin.map((c) => {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  });
}

/** The resolver this replaced, verbatim — so a restoration is caught rather than described. */
function oldRegexResolver(computed: string): number[] | null {
  const m = /rgba?\(([^)]+)\)/.exec(computed);
  if (!m) return null;
  const [r, g, b] = m[1].split(",").map((x) => parseFloat(x));
  return [r, g, b];
}

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__cssColorHarness);
});

test("the tokens the graph paints with are oklch, and the old regex sees none of them", async ({ page }) => {
  const computed = await page.evaluate(() =>
    ["var(--info)", "var(--accent)", "var(--fg)", "var(--bg-elev)", "var(--border)"].map((c) => ({
      css: c,
      computed: window.__cssColorHarness.computed(c),
    })),
  );
  // Every one resolves to SOMETHING — if a token were missing this would be the inherited colour and
  // the rest of the file would be testing the wrong thing.
  for (const { css, computed: got } of computed) expect(got, css).toBeTruthy();

  const missed = computed.filter((c) => oldRegexResolver(c.computed) === null);
  // The premise of the whole file. If a future engine serialises these as rgb() the bug becomes
  // unreproducible HERE, and this failing is the notice that the coverage moved — not a product defect.
  expect(missed.map((m) => m.css)).toEqual(computed.map((c) => c.css));
});

test("a chromatic token resolves to its true colour, not the fallback grey", async ({ page }) => {
  const got = await page.evaluate(() => window.__cssColorHarness.resolve("var(--info)"));
  expect(got).not.toBeNull();
  const [r, g, b, a] = got as number[];
  const [er, eg, eb] = oklchToSrgb(0.72, 0.1, 230);
  expect(Math.abs(r - er)).toBeLessThanOrEqual(2);
  expect(Math.abs(g - eg)).toBeLessThanOrEqual(2);
  expect(Math.abs(b - eb)).toBeLessThanOrEqual(2);
  expect(a).toBe(255);
  // The reported symptom, asserted directly: a fallback is grey, and grey has no chroma.
  expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(24);
});

test("the four palette colours are distinct — the monochrome card, stated as a test", async ({ page }) => {
  const rgba = await page.evaluate(() =>
    ["var(--bg-elev)", "var(--border)", "var(--accent)", "var(--fg)"].map((c) =>
      window.__cssColorHarness.rgba(c),
    ),
  );
  const keys = rgba.map((c) => c.slice(0, 3).map((v) => Math.round(v * 255)).join(","));
  expect(new Set(keys).size).toBe(4);
  // Nothing fell back: the fallback is exactly 0.5 on all three channels.
  for (const c of rgba) expect(c.slice(0, 3).every((v) => v === 0.5)).toBe(false);
});

test("packed colour is 0xAABBGGRR — a swap survives every grey test", async ({ page }) => {
  // Deliberately lopsided channels: red 255, green 128, blue 0 cannot be confused under any rotation.
  const packed = await page.evaluate(() => window.__cssColorHarness.packed("rgb(255, 128, 0)"));
  expect(packed >>> 0).toBe(0xff0080ff);
});

test("an unresolvable colour degrades to the caller's fallback rather than throwing", async ({ page }) => {
  const got = await page.evaluate(() => ({
    resolved: window.__cssColorHarness.resolve("not-a-colour"),
    rgba: window.__cssColorHarness.rgba("not-a-colour"),
  }));
  // `color: not-a-colour` is refused by the parser, so the probe keeps its inherited colour — the
  // documented limit. What matters is that it is a colour and the call did not throw.
  expect(got.rgba.length).toBe(4);
});
