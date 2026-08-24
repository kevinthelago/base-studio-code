// Harness for `@/shared/lib/graph/cssColor` against a REAL cascade (`graph-colours-fall-back-…-oklch`).
//
// The bug this covers is invisible to a unit test by construction: it is the interaction between the
// app's tokens (all `oklch()`) and the browser's serialisation of a computed colour. jsdom has neither.
import { resolveCssColor, cssColorToPacked, cssColorToRgba } from "@/shared/lib/graph/cssColor";

declare global {
  interface Window {
    __cssColorHarness: {
      /** The engine's computed serialisation — what the old regex was handed. */
      computed(css: string): string;
      resolve(css: string): readonly number[] | null;
      packed(css: string): number;
      rgba(css: string): number[];
    };
  }
}

const probe = document.getElementById("probe") as HTMLCanvasElement;

window.__cssColorHarness = {
  computed(css) {
    probe.style.color = "";
    probe.style.color = css;
    return getComputedStyle(probe).color;
  },
  resolve: (css) => resolveCssColor(css, probe),
  packed: (css) => cssColorToPacked(css, probe, 0xffcccccc),
  rgba: (css) => cssColorToRgba(css, probe, [0.5, 0.5, 0.5, 1]),
};
