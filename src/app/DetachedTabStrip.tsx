// The detached window's browser-style strip (#3919) — its tab plus the window controls.
//
// A torn-off window used to render a bare `Titlebar` over the page: nothing to grab, and the only way home
// was closing the window, which reads as DISCARDING the page rather than returning it (#3917). A browser
// window carries its tab, and dragging that tab is how you move it between windows — so this does the same.
//
// The gesture is an INVERSION of tear-off, not new machinery: `TabBar` fires `onTearOff` when a tab is
// dropped outside its strip, and here that means the tab is leaving THIS window — i.e. going home. Users
// already learned the gesture; only its direction and its preview wording change.
import { WindowControls } from "@/app/chrome/Titlebar";
import { TabBar } from "@/shared/ui/layouts/TabBar";
import { emitDockBack } from "@/shared/lib/core/dockBack";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Hand this page back to the main window, then close this one.
 *
 *  Emitted BEFORE closing so the main window has the message even if the close races it — and the close is
 *  still the backstop: `openDetachedSection`'s `tauri://destroyed` handler re-docks too, so a dropped event
 *  degrades to the old behaviour rather than stranding the tab. */
async function dockBack(page: string, section: string): Promise<void> {
  await emitDockBack({ page, section });
  try {
    await getCurrentWindow().close();
  } catch (e) {
    console.error("dockBack close failed:", e);
  }
}

/**
 * The strip for a detached page-section window: one tab (this section) over the window's own titlebar.
 * `label` is the section's human name; `page`/`section` identify it to the main window.
 */
export function DetachedTabStrip({ page, section, label }: { page: string; section: string; label: string }) {
  // ONE bar (#3925): the tab and the window controls share the strip, browser-style. The separate
  // titlebar is gone, and with it the `page · section` breadcrumb — this window shows a single expected
  // page, so naming it twice was noise. The strip's empty area stays an OS drag region (`.chrome-bar`),
  // so the window is still movable by its bar.
  return (
    <TabBar
      className="chrome-bar"
      tabs={[{ id: section, label }]}
      activeId={section}
      onSelect={() => {}}
      onTearOff={() => void dockBack(page, section)}
      tearOffHint="↙ release to dock back into the main window"
      trailing={<WindowControls />}
    />
  );
}
