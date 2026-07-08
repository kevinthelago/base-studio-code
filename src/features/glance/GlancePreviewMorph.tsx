// GlancePreviewMorph (#2623) — the PREVIEW node growing in place into the running application, IN the
// graph. Mirrors GlanceStreamMorph (#2534): a world-layer child at the node's world coords that pans /
// zooms / scales WITH the graph, no portal, no scrim. Where the stream morph hosts the agent terminal,
// this hosts the finished app — a sandboxed iframe for a web/bundle (incl. a wgpu/wasm build) PreviewSource,
// a "running in its own window" state for a native app (launched on the desktop via WSLg/host, slice 4),
// or a placeholder until the verify-build (slice 3) produces one. Esc / outside-click / ✕ shrinks it back.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { previewRender, type PreviewSource } from "@/shared/lib/preview/previewSource";
import { NW, NH } from "./lib/glanceGraph";

const EXIT_MS = 420;
/** ~4× a node — the app wants room. World units (renders at world-size × zoom). */
const CARD_W = 720, CARD_H = 460;

export function GlancePreviewMorph({ node, source, name, building, onBuild, onClose }: {
  /** The preview node's world box (origin + return). */
  node: { x: number; y: number };
  /** What the verify-build produced, or null while the app hasn't been built yet. */
  source: PreviewSource | null;
  name: string;
  /** A verify-build is in flight. */
  building?: boolean;
  /** Kick the verify-build (#2623) — resolve the stack, build + serve, produce a PreviewSource. */
  onBuild?: () => void;
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const closingRef = useRef(false);

  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const close = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setOpen(false);
    window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Outside-click closes (a press-release that stayed put; a drag pans the graph). Mirrors the stream morph.
  useEffect(() => {
    let start: { x: number; y: number } | null = null;
    const onDown = (e: MouseEvent) => {
      start = (e.target as HTMLElement)?.closest(".glance-card") ? null : { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: MouseEvent) => {
      if (!start) return;
      const moved = Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y);
      start = null;
      if (moved <= 4) close();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("mouseup", onUp, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("mouseup", onUp, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cx = node.x + NW / 2, cy = node.y + NH / 2;
  const box = open
    ? { left: cx - CARD_W / 2, top: cy - CARD_H / 2, width: CARD_W, height: CARD_H }
    : { left: node.x, top: node.y, width: NW, height: NH };

  const render = source ? previewRender(source) : null;

  return (
    <Box
      className={`glance-card${open ? " open" : ""}`}
      role="dialog" aria-label={`${name} preview`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={{ position: "absolute", left: box.left, top: box.top, width: box.width, height: box.height, zIndex: 20 }}
    >
      <Box className="glance-card-body" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Box style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderBottom: "1px solid var(--border)", flex: "none" }}>
          <Text as="span" style={{ color: "var(--accent)" }}>▷</Text>
          <Text as="span" mono size={12} weight={600} style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name} · preview</Text>
          <Box as="button" onClick={close} title="Close (Esc)" style={{ background: "none", border: "none", color: "var(--fg-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}>✕</Box>
        </Box>
        <Box style={{ flex: 1, minHeight: 0, position: "relative", background: "var(--bg)" }}>
          {render?.mode === "iframe" ? (
            <iframe
              title={`${name} preview`}
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
              src={render.src}
              srcDoc={render.srcDoc}
              style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            />
          ) : render?.mode === "external" ? (
            <Box style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 24 }}>
              <Text as="div" size={22} aria-hidden>▶</Text>
              <Text as="div" size={13} weight={600} style={{ textAlign: "center" }}>{render.label} is running</Text>
              <Text as="div" size={12.5} tone="muted" style={{ textAlign: "center", maxWidth: 320, lineHeight: 1.6 }}>
                It's a native app, so it opened in its own window on your desktop. Interact with it there; close its window when you're done.
              </Text>
              {onBuild ? <Button variant="ghost" onClick={onBuild}>↻ Rebuild &amp; relaunch</Button> : null}
            </Box>
          ) : (
            <Box style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, padding: 24 }}>
              <Text as="div" size={12.5} tone="muted" style={{ textAlign: "center", maxWidth: 340, lineHeight: 1.6 }}>
                {building ? "Building your app — this runs its real build, then serves it here." : "Your finished application renders here."}
              </Text>
              {building ? (
                <Box aria-hidden bg="color-mix(in oklch, var(--accent), transparent 75%)" radius={2} style={{ height: 3, width: 160, overflow: "hidden" }}>
                  <Box bg="var(--accent)" style={{ height: "100%", width: "30%", animation: "scan 1.1s linear infinite" }} />
                </Box>
              ) : onBuild ? (
                <Button variant="primary" onClick={onBuild}>▷ Build to preview</Button>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
