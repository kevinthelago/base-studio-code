// The idle-reaper actuator (#849): on a slow tick, kill the PTY of each pane the pure
// `panesToReap` decision selects (idle, non-focused, role-eligible, past threshold) and mark
// it dormant. Mounted once in ConsoleWorkspace (which stays mounted across screens). The pure
// decision + thresholds live in idleReaper.ts; this is the thin Tauri/React side.

import { fireInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";
import { panesToReap, type ReaperPane } from "./idleReaper";
import type { SessionRole } from "@/shared/lib/session/sessionRoles";

const TICK_MS = 60_000;

export function useIdleReaper(): void {
  // Not immediate: panes must clear the grace window before the first reap pass.
  usePoll(() => {
    const s = useAppStore.getState();
    if (!s.idleReaper.enabled) return;
    const now = Date.now();
    // The pane the user is watching — never reaped.
    const focusedKey = s.focusedPaneIdx >= 0 ? `t${s.activeTabIdx}p${s.focusedPaneIdx}` : "";
    // Live panes are the ones carrying a status. An unknown role (a console with no fleet
    // role, e.g. a hand-opened one) defaults to "worker" — i.e. conservatively NOT reaped —
    // so we never surprise-kill something we can't classify.
    const panes: ReaperPane[] = Object.keys(s.paneStatus).map((paneId) => ({
      paneId,
      status: s.paneStatus[paneId],
      role: (s.paneRoles[paneId] ?? "worker") as SessionRole,
      lastActivityMs: s.paneLastActivity[paneId] ?? now,
      focused: paneId === focusedKey,
      dormant: !!s.dormantPanes[paneId],
      maintaining: !!s.paneMaintaining[paneId],
    }));
    for (const paneId of panesToReap(panes, s.idleReaper, now)) {
      fireInvoke("pty_kill", { paneId });
      useAppStore.getState().reapPane(paneId);
    }
  }, TICK_MS, [], { immediate: false });
}
