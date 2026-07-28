// dockBack — return a torn-off window's page to the main window (#3919, follows #3917).
//
// Tear-off was one-directional: `openDetachedSection` opens the window, and the only way home was CLOSING
// it, which reads as discarding the page rather than returning it.
//
// The obvious fix — drag the tab back onto the main window's strip — cannot work through the DOM. The tab
// drag is HTML5 drag-and-drop, which is scoped to ONE webview, so a drag begun in the detached window can
// never deliver a `drop` to the main window's `TabBar`. The signal therefore travels out-of-band, over the
// Tauri app-global event bus (the same mechanism `useDebugChannel` / `useNavigateBridge` already use).
//
// The GESTURE is an inversion of tear-off rather than something new: `TabBar` fires `onTearOff` when a tab
// is dropped outside its strip, and in a detached window that means the tab is leaving THIS window — i.e.
// going home. Same affordance, opposite direction.
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The app-global event a detached window emits to hand its page back. */
export const DOCK_BACK_EVENT = "bsc://dock-back";

/** Which page/section is coming home. Mirrors `detachedSection`'s shape. */
export interface DockBackPayload {
  page: string;
  section: string;
}

/** Ask the main window to take this page back. Best-effort: a failure must never strand the gesture, so
 *  the caller still closes its window and the `tauri://destroyed` re-dock path remains the backstop. */
export async function emitDockBack(payload: DockBackPayload): Promise<void> {
  try {
    await emit(DOCK_BACK_EVENT, payload);
  } catch (e) {
    console.error("emitDockBack failed:", e);
  }
}

/** Listen for a page coming home. Returns an unlisten fn, or a no-op when the bus is unavailable (tests,
 *  a browser dev server) — the caller's cleanup must not have to care. */
export async function onDockBack(handler: (p: DockBackPayload) => void): Promise<UnlistenFn> {
  try {
    return await listen<DockBackPayload>(DOCK_BACK_EVENT, (e) => {
      const p = e.payload;
      // The bus is untyped at the wire; ignore anything that isn't the shape we sent.
      if (p && typeof p.page === "string" && typeof p.section === "string") handler(p);
    });
  } catch {
    return () => {};
  }
}
