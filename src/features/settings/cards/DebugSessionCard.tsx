import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { openDebugWindow, closeDebugWindow } from "@/features/debug";
import { ToggleRow } from "../pages/SettingsControls";

/**
 * Toggle: open the DEBUG session in its own window (#3298, epic #3260). A full-capability Claude session
 * in the base-studio-code SOURCE tree that works the `bsc request` improvement queue — the queue the
 * Design Studio's designer files its `bsc ui` painpoints into. On → opens the window; off → closes it.
 * The window's own X flips this back off (via the open-time onClose). Session-only: a restart re-opens
 * it via the toggle, never automatically.
 */
export function DebugSessionCard() {
  const { debugSession, setDebugSession } = useAppStore();

  const toggle = () => {
    const next = !debugSession;
    setDebugSession(next);
    // getState in the onClose so the "native X flips the toggle off" callback never captures a stale value.
    if (next) openDebugWindow(() => useAppStore.getState().setDebugSession(false));
    else void closeDebugWindow();
  };

  return (
    <Card title="Debug session">
      <ToggleRow on={debugSession} onToggle={toggle} title="Open the debug session in its own window">
        Opens a <b>full-capability Claude session in this app's source tree</b> in a separate window. It
        works the <code>bsc request</code> queue — the improvement requests the Design Studio's designer
        files when it hits a missing <code>bsc ui</code> capability — reproducing each, fixing it in{" "}
        <code>crates/bsc-ui</code> on a branch, and resolving the request. Runs in <b>bypass</b> (auto-runs
        everything, confined to the repo). Available only on a machine with the source tree (a dev build).
      </ToggleRow>
    </Card>
  );
}
