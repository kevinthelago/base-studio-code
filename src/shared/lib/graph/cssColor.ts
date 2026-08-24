/**
 * Resolve a CSS colour — including `var(--token)` — to RGBA bytes, without parsing it.
 *
 * The cascade answers "what colour is `var(--info)` here?" and a 1×1 canvas answers "what pixels is
 * that?". Nothing in this module reads a colour string, which is the whole point: the previous
 * resolver matched `/rgba?\(([^)]+)\)/` against `getComputedStyle(el).color`, and every token in
 * `tokens.css` is `oklch()`. WebKitGTK serialises a computed oklch colour AS oklch
 * (`oklch(0.72 0.1 230)`, measured in the running app), so the match failed on EVERY colour and the
 * graph fell back to its placeholder grey — card, label and role dot alike.
 *
 * Extending the regex to `oklch` would have been the same bug with a longer fuse: `lab()`, `lch()`,
 * `color(display-p3 …)` and `color-mix()` all serialise in their own space too, and `tokens.css`
 * already uses `color-mix`. A readback cannot miss a syntax the engine itself accepts, and it
 * cannot disagree with what the DOM layer paints — both go through the same parser.
 *
 * Cost is O(1) per colour and it is NOT in the frame loop: callers resolve when the palette or the
 * node set changes, then hand the renderer plain numbers.
 */

/** What a caller gets when the colour cannot be resolved at all. RGBA, 0–255. */
export type Rgba255 = readonly [number, number, number, number];

/**
 * Two sentinels, because an invalid `fillStyle` assignment is IGNORED rather than throwing — the
 * context silently keeps its previous value. One sentinel cannot tell "the assignment took and the
 * colour happens to equal the sentinel" from "the assignment was refused"; two can. They differ in
 * every channel so no single-channel quantisation can collapse them.
 */
const SENTINEL_A = "#010203";
const SENTINEL_B = "#fcfdfe";

/** One shared 1×1 context. `undefined` = not yet probed, `null` = this environment has none. */
let swatch: CanvasRenderingContext2D | null | undefined;

function swatchCtx(): CanvasRenderingContext2D | null {
  if (swatch !== undefined) return swatch;
  try {
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    // `willReadFrequently` keeps the backing store on the CPU; without it a readback can force a
    // GPU→CPU sync, which is a strange price for four colours.
    swatch = c.getContext("2d", { willReadFrequently: true });
  } catch {
    swatch = null;
  }
  return swatch;
}

/** Test seam: drop the cached context so a test can install its own (or none). */
export function resetSwatchForTests(): void {
  swatch = undefined;
}

/**
 * The rgb-only path, kept for environments with no 2D context (jsdom without `canvas`).
 *
 * This is deliberately NOT a fast path in the browser. A second code path that handles the common
 * case is how the two got to disagree in the first place — the tests took this branch and the app
 * took the other one.
 */
function parseRgbTuple(computed: string): Rgba255 | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(computed.trim());
  if (!m) return null;
  const parts = m[1].split(/[,/]/).map((s) => parseFloat(s));
  const [r, g, b, a] = parts;
  if (![r, g, b].every((n) => Number.isFinite(n))) return null;
  return [r, g, b, Number.isFinite(a) ? Math.round(a * 255) : 255];
}

/**
 * Resolve `css` against `probe`'s position in the cascade. Returns `null` when the colour cannot be
 * resolved, so the caller picks its own fallback rather than inheriting one from here.
 *
 * KNOWN LIMIT: `var(--typo)` is valid syntax that becomes invalid at computed-value time, and for an
 * inherited property that means "inherit". So an undefined token resolves to the inherited colour
 * rather than `null` — which is exactly what the element would paint, so it is a defensible answer,
 * but it is not an error report. A missing token surfaces as a wrong colour, not as a fallback.
 */
export function resolveCssColor(css: string, probe: HTMLElement): Rgba255 | null {
  let computed: string;
  try {
    probe.style.color = "";
    probe.style.color = css;
    computed = getComputedStyle(probe).color;
  } catch {
    return null;
  }
  if (!computed) return null;

  const ctx = swatchCtx();
  if (!ctx) return parseRgbTuple(computed);

  ctx.fillStyle = SENTINEL_A;
  ctx.fillStyle = computed;
  const a = ctx.fillStyle;
  ctx.fillStyle = SENTINEL_B;
  ctx.fillStyle = computed;
  if (a !== ctx.fillStyle) return null; // each kept its own sentinel ⇒ the assignment was refused

  try {
    // Composited onto a fully transparent pixel, so the result IS the source colour. `getImageData`
    // un-premultiplies, which can cost ±1 per channel at low alpha; every colour here is opaque.
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = computed;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3]];
  } catch {
    return parseRgbTuple(computed);
  }
}

/** As 0–1 RGBA — what the renderer's palette uniforms take. */
export function cssColorToRgba(css: string, probe: HTMLElement, fallback: number[]): number[] {
  const c = resolveCssColor(css, probe);
  if (!c) return fallback;
  return [c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255];
}

/** As packed `0xAABBGGRR` — what the instance colour attribute takes. */
export function cssColorToPacked(css: string, probe: HTMLElement, fallback: number): number {
  const c = resolveCssColor(css, probe);
  if (!c) return fallback;
  return ((c[3] << 24) | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
}
