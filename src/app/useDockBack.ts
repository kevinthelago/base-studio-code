// useDockBack (#3919) — the main window's half of "drag a torn-off tab home".
//
// A detached window cannot deliver its drop to this window's DOM: the tab drag is HTML5 drag-and-drop,
// scoped to one webview (#3917). So it emits over the Tauri app-global bus instead, and this clears the
// detached flag — which is what makes the tab reappear in its persisted place (`usePageTabs` filters the
// strip by `detachedSections`).
//
// Idempotent by construction: `setSectionDetached(..., false)` filters an id out of a list, so the event
// arriving alongside the window's own `tauri://destroyed` re-dock (the pre-existing backstop) is harmless.
import { useEffect } from "react";
import { useAppStore } from "@/store";
import { onDockBack } from "@/shared/lib/core/dockBack";

/** Install the dock-back listener. Main window only — a detached window must not re-dock its own page. */
export function useDockBack(enabled: boolean): void {
  const setSectionDetached = useAppStore((s) => s.setSectionDetached);
  useEffect(() => {
    if (!enabled) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onDockBack(({ page, section }) => setSectionDetached(page, section, false)).then((fn) => {
      // The listener resolves asynchronously; if the effect already tore down, drop it immediately rather
      // than leaking a subscription onto an unmounted shell.
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, [enabled, setSectionDetached]);
}
