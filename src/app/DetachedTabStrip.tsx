// The detached window's browser-style strip (#3919) — its tab plus the window controls, in ONE bar
// (#3925) — and the pointer drag that docks the page back (#3927).
//
// WHY NOT HTML5 DRAG-AND-DROP. That was the first two attempts and it cannot work here. An HTML5 drag is
// owned by its SOURCE webview: over any other window there is no drop target calling `preventDefault()`,
// so the OS paints the **no-drop cursor** and no `drop` ever reaches the other window's DOM. The `dragend`
// fallback (#3925) does fire wherever the release happens, but deciding "was this outside the strip" from
// the last in-window `dragover` broke on the one-bar chrome: the strip spans the window's TOP EDGE, so a
// tab dragged outward is still over the strip when the pointer leaves, and the gesture read as cancelled.
//
// Real browsers tear tabs with a POINTER drag, and so does this. `setPointerCapture` keeps the events
// coming to this window even while the cursor is over another one, and `pointerup` carries SCREEN
// coordinates — so the release position is known exactly, whichever window it lands over. No OS drag is
// started, so there is no error cursor to explain away.
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { WindowControls } from "@/app/chrome/Titlebar";
import { TabBar } from "@/shared/ui/layouts/TabBar";
import { Box } from "@/shared/ui/layout/Box";
import { emitDockBack } from "@/shared/lib/core/dockBack";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Past this many pixels a press becomes a drag — below it, a press on the tab stays a click. */
const DRAG_THRESHOLD = 6;

/** Hand this page back to the main window, then close this one.
 *
 *  Emitted BEFORE closing so the main window has the message even if the close races it — and the close
 *  is still the backstop: `openDetachedSection`'s `tauri://destroyed` handler re-docks too, so a dropped
 *  event degrades to the old behaviour rather than stranding the tab. */
async function dockBack(page: string, section: string): Promise<void> {
  await emitDockBack({ page, section });
  try {
    await getCurrentWindow().close();
  } catch (e) {
    console.error("dockBack close failed:", e);
  }
}

/** This window's screen rect, or `null` when the Tauri API is unavailable (a browser dev server). */
async function windowRect(): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    const w = getCurrentWindow();
    const [pos, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
    return { x: pos.x, y: pos.y, w: size.width, h: size.height };
  } catch {
    return null;
  }
}

/** Was the release inside `r`? A null rect (no Tauri API) counts as OUTSIDE, so a real drag still docks
 *  back rather than being silently swallowed. Pure — exported for its test. */
export function releasedOutside(
  e: { screenX: number; screenY: number },
  r: { x: number; y: number; w: number; h: number } | null,
): boolean {
  if (!r) return true;
  return e.screenX < r.x || e.screenX > r.x + r.w || e.screenY < r.y || e.screenY > r.y + r.h;
}

/**
 * The strip for a detached page-section window: one tab (this section) beside the window controls.
 * `label` is the section's human name; `page`/`section` identify it to the main window.
 */
export function DetachedTabStrip({ page, section, label }: { page: string; section: string; label: string }) {
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  // The window's screen rect, captured at PRESS time: `pointerup` gives screen coords, and comparing them
  // against this is what decides "released over another window" — with no reliance on drag events, which
  // stop arriving the moment the cursor leaves.
  const rectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);

  // Fetch the rect ON MOUNT as well as at press time. The API is async, so a fast flick could otherwise
  // release before the press-time fetch resolved — and an unknown rect is treated as "outside", which
  // would dock back on a gesture that never left the window.
  useEffect(() => { void windowRect().then((r) => { rectRef.current = r; }); }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    // Only a press that STARTS on the tab begins a drag — not one on the window controls, and not one on
    // the bar's empty area, which is the OS drag region that moves the window.
    if (!(e.target as HTMLElement).closest("[data-tab]")) return;
    startRef.current = { x: e.screenX, y: e.screenY };
    void windowRect().then((r) => { rectRef.current = r; });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* jsdom / no capture support */ }
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = startRef.current;
    if (!s) return;
    if (Math.abs(e.screenX - s.x) + Math.abs(e.screenY - s.y) >= DRAG_THRESHOLD) {
      setDrag({ x: e.clientX, y: e.clientY });
    }
  }, []);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const s = startRef.current;
    startRef.current = null;
    setDrag(null);
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!s) return;
    if (Math.abs(e.screenX - s.x) + Math.abs(e.screenY - s.y) < DRAG_THRESHOLD) return; // a click
    // Released INSIDE this window ⇒ a cancelled gesture. Outside ⇒ the tab was carried elsewhere, which
    // for a single-tab window means home.
    if (releasedOutside(e, rectRef.current)) void dockBack(page, section);
  }, [page, section]);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- pointer-drag surface; the tab
    // inside is separately interactive, and dock-back is also reachable by closing the window.
    <Box
      className="detached-bar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/* No `onTearOff`: passing it makes TabBar mark the tab draggable and start an HTML5 drag — the
          mechanism that cannot cross windows and paints the no-drop cursor. The gesture lives here. */}
      <TabBar
        className="chrome-bar"
        tabs={[{ id: section, label }]}
        activeId={section}
        onSelect={() => {}}
        trailing={<WindowControls />}
      />
      {drag && createPortal(
        <Box className="tab-tearoff-preview" style={{ position: "fixed", left: drag.x + 14, top: drag.y + 14, zIndex: 3000, pointerEvents: "none" }}>
          <Box className="ttp-bar">
            <Box as="span" className="ttp-light" /><Box as="span" className="ttp-light" /><Box as="span" className="ttp-light" />
            <Box as="span" className="ttp-title">{label}</Box>
          </Box>
          <Box className="ttp-body"><Box as="span" className="ttp-hint">↙ release over the main window to dock back</Box></Box>
        </Box>,
        document.body,
      )}
    </Box>
  );
}
