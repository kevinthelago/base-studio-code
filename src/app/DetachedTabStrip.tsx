// The detached window's browser-style strip (#3919) — its tab plus the window controls.
//
// A torn-off window used to render a bare `Titlebar` over the page: nothing to grab, and the only way home
// was closing the window, which reads as DISCARDING the page rather than returning it (#3917). A browser
// window carries its tab, and dragging that tab is how you move it between windows — so this does the same.
//
// The gesture is an INVERSION of tear-off, not new machinery: `TabBar` fires `onTearOff` when a tab is
// dropped outside its strip, and here that means the tab is leaving THIS window — i.e. going home. Users
// already learned the gesture; only its direction and its preview wording change.
import { Titlebar } from "@/app/chrome/Titlebar";
import { TabBar } from "@/shared/ui/layouts/TabBar";
import { Box } from "@/shared/ui/layout/Box";
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
  return (
    <Box className="detached-chrome">
      <Titlebar workspace={`${page} · ${label}`} />
      <TabBar
        tabs={[{ id: section, label }]}
        activeId={section}
        onSelect={() => {}}
        onTearOff={() => void dockBack(page, section)}
        tearOffHint="↙ release to dock back into the main window"
      />
    </Box>
  );
}
