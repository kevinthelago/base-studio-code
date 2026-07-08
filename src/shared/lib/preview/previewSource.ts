// PreviewSource (#2623) — the TARGET-AGNOSTIC contract between the verify-build (which builds + serves a
// finished application) and the preview node in the graph (which RENDERS it in place). The build picks
// the `kind` from the project's stack; the node switches on `kind`. Decoupling "how it's built/served"
// from "how it renders" means a new render target (native window streaming, …) slots in behind the seam
// WITHOUT touching the node. A wgpu/`wasm32` Rust 3D app compiles to a canvas → the SAME iframe as a web
// app (the `bundle`/`web` kinds), so only a pure native-window binary needs the `native` frame-stream.
// Pure (no React/Tauri) so it's unit-testable and shared by both features (planner build · glance render).

/** What the verify-build produced for a completed project to preview. */
export type PreviewSource =
  | { kind: "web"; url: string }          // a served local dev/preview URL — a Node web app
  | { kind: "bundle"; srcDoc: string }    // a static HTML/JS/WASM bundle — rendered as an iframe srcdoc
  | { kind: "native"; streamId: string }; // a running native binary — its window frames captured + streamed in

/** How a {@link PreviewSource} renders — the descriptor the preview node's frame reads. `iframe` covers
 *  a web URL, a static bundle, AND a wgpu/wasm app compiled to the web; `stream` is the native frame feed. */
export type PreviewRender =
  | { mode: "iframe"; src?: string; srcDoc?: string }
  | { mode: "stream"; streamId: string };

/** Map a {@link PreviewSource} to its render descriptor — the one place `kind` is switched on. Pure. */
export function previewRender(source: PreviewSource): PreviewRender {
  switch (source.kind) {
    case "web":    return { mode: "iframe", src: source.url };
    case "bundle": return { mode: "iframe", srcDoc: source.srcDoc };
    case "native": return { mode: "stream", streamId: source.streamId };
  }
}

/** Whether a source renders in the sandboxed iframe (web / bundle / wasm) vs the native frame-stream —
 *  the split the preview node uses to pick its render surface. */
export function isIframeSource(source: PreviewSource): boolean {
  return source.kind !== "native";
}
