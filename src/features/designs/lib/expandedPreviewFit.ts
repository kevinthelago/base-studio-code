// expandedPreviewFit (#3551) — size + place the expanded theme try-on's design frame inside the measured
// canvas. Pure so the width-first / fluid-fill contract is unit-testable (the DesignsWorkbench layout it
// feeds cannot be seen by jsdom).

export type PreviewViewport = "sm" | "md" | "auto";

export interface ExpandedFit {
  /** The design frame's CSS width — the breakpoint the component renders at. */
  previewW: number;
  /** The design frame's CSS height. */
  previewH: number;
  /** Host framing scale of the frame into the canvas. Always ≤ 1 (never upscales → the iframe texture
   *  stays crisp; the user zooms IN via the in-iframe engine, not by host-scaling). */
  scale: number;
  /** Centering offset of the scaled frame within the canvas. */
  tx: number;
  ty: number;
}

/**
 * WIDTH-first framing, and `auto` is truly FLUID (#3551).
 *
 * `auto` fills the whole canvas — `previewW` = canvas width, `previewH` = canvas height — at **scale 1**.
 * So the preview uses the full width, GROWS when the panel is resized, and (critically) is NOT
 * host-CSS-scaled: a host downscale (the old fixed `1200×440` frame `Math.min(1, …)`-fit into the canvas)
 * both shrank the preview AND desynced the in-iframe pan engine, whose pointer math reads iframe-internal
 * `clientX` — hence "no click and drag". At scale 1 the drag tracks the cursor 1:1 again.
 *
 * `sm`/`md` render at their fixed CSS breakpoint width but use the canvas HEIGHT (not a short fixed 440)
 * and downscale-only-fit — never upscaling a small breakpoint (it would blur), so it stays crisp and the
 * user zooms in with the engine.
 *
 * @param vp the selected viewport (`sm` 380px · `md` 640px · `auto` fluid)
 * @param cw measured canvas width in px (0 before layout)
 * @param ch measured canvas height in px (0 before layout)
 */
export function expandedPreviewFit(vp: PreviewViewport, cw: number, ch: number): ExpandedFit {
  const fluid = vp === "auto";
  const previewW = vp === "sm" ? 380 : vp === "md" ? 640 : cw || 1200;
  const previewH = ch || 440;
  if (!cw || !ch) return { previewW, previewH, scale: 1, tx: 0, ty: 0 };
  // Fluid has NO padding — it fills edge to edge (frame === canvas → scale resolves to 1). A fixed
  // breakpoint keeps a small inset so its frame border reads and it doesn't touch the canvas edges.
  const pad = fluid ? 0 : 24;
  const scale = Math.min(1, (cw - pad * 2) / previewW, (ch - pad * 2) / previewH);
  return { previewW, previewH, scale, tx: (cw - previewW * scale) / 2, ty: (ch - previewH * scale) / 2 };
}
