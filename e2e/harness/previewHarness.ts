// previewHarness (#3264) — the browser half of the headless interaction harness.
//
// WHY THIS RUNS IN A VITE-SERVED PAGE, not in Node. The point of #3264 is to verify the srcdoc the app
// ACTUALLY SHIPS, so the composition here must be the shipped one. Two hard couplings force a real
// browser + a real Vite graph:
//
//   1. `bundleComponent` runs esbuild-WASM, booted from a `?url` asset import — a Vite-resolved URL and a
//      Web Worker. There is no Node path for it; the module's own header says so ("it can't run under
//      jsdom"). Rebuilding the bundle any other way would be a FORKED render path, which proves nothing.
//   2. `collectAppCss()` reads `document.styleSheets` — the "known coupling to solve" in the issue. It is
//      resolved here by CONSTRUCTION rather than by a Node-side reimplementation: this page imports
//      `@/styles/tokens.css` exactly as `src/app/main.tsx` does, so by the time the harness runs, the live
//      document holds the app's real sheets and `collectAppCss()` is exercised UNMODIFIED, returning the
//      same cascade the app injects. No stub, no source-file scraper, no divergence.
//
// So the only thing this module adds over `ComponentPreviewFrame` is the call SEQUENCE (bundle → collect
// CSS → build srcdoc → assign to a sandboxed iframe) with the same options that frame passes. Every
// function in the chain is the shipped one.
//
// Deliberately NOT rendered here: the `ComponentPreviewFrame` React component itself. It is bound to the
// Zustand store, the Tauri `invoke` bridge, the packaged kit artifact and the `usePreviewData` studio
// -network hook — none of which exist headlessly. Driving it would test the app's wiring, not the srcdoc's
// interaction behaviour, at a large cost in fragility.
import { bundleComponent, buildComponentSrcDoc } from "@/shared/lib/preview/componentBundle";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import "@/styles/tokens.css";

/**
 * The fixture component's source, bundled through the REAL `bundleComponent`.
 *
 * It is intentionally EXTERNAL-FREE (no React, no bare imports). The preview importmap points the
 * externals at esm.sh, so a React fixture would make every run depend on a CDN fetch inside an
 * opaque-origin iframe — flaky, slow, and irrelevant: the gesture engine under test is vanilla script
 * bound to `document` and `#root`, entirely blind to what framework painted the DOM. What the harness
 * genuinely needs from the fixture is what jsdom cannot give — real laid-out boxes, real selectable text,
 * a real form field with a caret, a real `<img>` with native drag behaviour — and plain DOM supplies all
 * of it deterministically and offline.
 *
 * The single-element wrapper mirrors the shipped bootstrap's mount wrapper, so `#root`'s child shape
 * matches what the fit-shim and the engine expect.
 */
const FIXTURE_SOURCE = `
const wrap = document.createElement("div");
wrap.style.cssText = "padding:24px;display:flex;flex-direction:column;gap:16px;align-items:flex-start;font:16px/1.5 sans-serif";

const text = document.createElement("p");
text.id = "txt";
text.style.cssText = "margin:0;width:700px";
text.textContent = "The quick brown fox jumps over the lazy dog. ".repeat(6);

const btn = document.createElement("button");
btn.id = "btn";
btn.type = "button";
btn.style.cssText = "padding:12px 24px;font:inherit";
btn.textContent = "Activate";
window.__clicks = 0;
btn.addEventListener("click", () => { window.__clicks += 1; });

const field = document.createElement("input");
field.id = "field";
field.type = "text";
field.value = "selectable field text content";
field.style.cssText = "width:420px;padding:8px;font:inherit";

// A 2x2 transparent GIF stretched to a real box — a genuine replaced element, so a press on it is a real
// native image-drag candidate (the #3251 failure mode that kills the mousemove stream outright).
const pic = document.createElement("img");
pic.id = "pic";
pic.alt = "fixture";
pic.src = "data:image/gif;base64,R0lGODlhAgACAIAAAP///wAAACH5BAEAAAAALAAAAAACAAIAAAIChF8AOw==";
pic.style.cssText = "width:240px;height:120px;background:#456";

wrap.append(text, btn, field, pic);
document.getElementById("root").appendChild(wrap);
export {};
`;

/** Options the harness forwards straight into `buildComponentSrcDoc` — the same knobs the live frame sets. */
export interface MountOptions {
  /** Mount with the in-iframe pan/zoom ENGINE (#3190), as the expanded try-on does. */
  zoomEngine?: boolean;
}

declare global {
  interface Window {
    /** The Playwright-facing entry point, installed below. */
    __previewHarness?: { mount: (opts?: MountOptions) => Promise<void> };
  }
}

/**
 * Build the fixture through the shipped chain and mount it, resolving once the iframe reports `ready`.
 *
 * Rejects on an iframe `error` message or after a timeout, so a broken mount fails the test loudly
 * instead of leaving every interaction assertion to time out with an unhelpful message.
 */
async function mount(opts: MountOptions = {}): Promise<void> {
  const iframe = document.getElementById("preview") as HTMLIFrameElement;
  const js = await bundleComponent({ "fixture.ts": FIXTURE_SOURCE }, "fixture.ts");
  const srcDoc = buildComponentSrcDoc(js, {
    injectedCss: collectAppCss(),
    theme: "dark",
    // The engine has no options that vary per-mount (it opens FIT and reads its own defaults); an empty
    // object enables it, exactly as the live frame passes `zoomEngine={{}}`.
    zoomEngine: opts.zoomEngine ? {} : undefined,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(new Error("preview harness: iframe never reported ready"));
    }, 15000);
    const onMsg = (e: MessageEvent): void => {
      // Correlate by source window, as the shipped frame + probe both do (#2908).
      if (e.source !== iframe.contentWindow) return;
      const d = e.data as { __preview?: string; message?: unknown } | null;
      if (!d || typeof d.__preview !== "string") return;
      if (d.__preview === "error") {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        reject(new Error(`preview harness: iframe error — ${String(d.message)}`));
      } else if (d.__preview === "ready") {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve();
      }
    };
    window.addEventListener("message", onMsg);
    iframe.srcdoc = srcDoc;
  });
}

window.__previewHarness = { mount };
