// The `matrix` viz kit's MOTION (#3221, epic #3220/#2942) — the read / write / region animations authored
// as KitAnimation DATA and compiled by the kit-motion engine (`compileAnimationsCss`), the 2-D twin of
// arrayViewMotion. State-triggered (#3058): each animation's `selector` IS the data-state MatrixView stamps
// (`[data-op="write"]`, …), so a rule fires exactly when a cell reaches that state. The renderer's root
// carries the applying classes ({@link MATRIX_VIZ_ANIM_CLASSES}); cells only stamp `data-op`/`data-mark`.
import { animClassName, compileAnimationsCss, kitAnimations, type KitAnimation } from "@/shared/ui/kit";

/** The matrix-visualization motion kit id — `.matrix-viz-anim-<name>` + `@keyframes bsc-matrix-viz-<name>`. */
export const MATRIX_VIZ_KIT_ID = "matrix-viz";

/** The matrix kit's animations as DATA — read (a highlight pulse on an examined cell), write (a pop as a
 *  value lands — the workhorse of transpose/rotate/reflect), region (a block tint fading out). Token-based
 *  colours; the engine wraps each in `prefers-reduced-motion: no-preference`. */
export const MATRIX_VIZ_ANIMATIONS: KitAnimation[] = [
  // read — a quick ring on the cell being examined.
  {
    name: "read",
    selector: '[data-op="read"]',
    duration: "450ms",
    easing: "var(--ease-standard)",
    set: { "z-index": "1" },
    keyframes: {
      "0%": { "box-shadow": "0 0 0 0 transparent", "border-color": "var(--border)" },
      "45%": {
        "box-shadow": "0 0 0 2px color-mix(in oklch, var(--state-wait), transparent 45%)",
        "border-color": "var(--state-wait)",
      },
      "100%": { "box-shadow": "0 0 0 0 transparent", "border-color": "var(--border)" },
    },
  },
  // write — a cell pops + tints to the accent as its new value lands (a swapped / rotated cell).
  {
    name: "write",
    selector: '[data-op="write"]',
    duration: "440ms",
    easing: "cubic-bezier(0.34, 1.4, 0.5, 1)",
    set: { "z-index": "2" },
    keyframes: {
      "0%": {
        transform: "scale(1.16)",
        background: "color-mix(in oklch, var(--accent), var(--bg-elev) 45%)",
        "border-color": "var(--accent)",
      },
      "100%": { transform: "scale(1)" },
    },
  },
  // region — a rectangular block tints and fades (a submatrix / layer highlight).
  {
    name: "region",
    selector: '[data-op="region"]',
    duration: "600ms",
    easing: "var(--ease-standard)",
    keyframes: {
      "0%": { background: "color-mix(in oklch, var(--info), transparent 78%)" },
      "100%": { background: "var(--bg-elev)" },
    },
  },
];

/** The applying classes the renderer's root carries so the state-scoped rules match its cells. */
export const MATRIX_VIZ_ANIM_CLASSES: string = MATRIX_VIZ_ANIMATIONS.map((a) =>
  animClassName({ kit: MATRIX_VIZ_KIT_ID, name: a.name }),
).join(" ");

/** The compiled motion CSS — produced ONCE by the engine from {@link MATRIX_VIZ_ANIMATIONS}. Pure. */
export const MATRIX_VIZ_MOTION_CSS: string = compileAnimationsCss(
  kitAnimations([{ id: MATRIX_VIZ_KIT_ID, animations: MATRIX_VIZ_ANIMATIONS }]),
);

const STYLE_ID = "bsc-matrix-viz-animations";

/** Inject the compiled matrix motion CSS into a dedicated managed `<style>` (idempotent). `doc` is param'd
 *  for tests. Mirrors `ensureArrayViewMotion` on its own style id. */
export function ensureMatrixViewMotion(doc: Document = document): void {
  if (!MATRIX_VIZ_MOTION_CSS) return;
  let el = doc.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = doc.createElement("style");
    el.id = STYLE_ID;
    doc.head.appendChild(el);
  }
  if (el.textContent !== MATRIX_VIZ_MOTION_CSS) el.textContent = MATRIX_VIZ_MOTION_CSS;
}
