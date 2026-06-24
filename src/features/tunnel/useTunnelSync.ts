// Always-on tunnel pane-sync (#801). Pushes the relay's pane list + session metadata
// from the store, regardless of which screen is mounted — previously this lived in
// Console.tsx, so the mirror went stale (and excluded the planner) the moment you left
// the Console screen. Mounted once in App. PTY *bytes* are teed in Rust; this is the
// low-volume names/cwds/statuses + the planner pane (via tunnelExtraPanes).

import { useEffect } from "react";
import { useAppStore } from "@/store";
import { buildPanePayload } from "./lib/tunnel";
import { tunnelSetPanes, tunnelSetSessions } from "./lib/tunnelClient";
import { log } from "@/lib/core/log";

const paneId = (tabIdx: number, paneIdx: number): string => `t${tabIdx}p${paneIdx}`;

export function useTunnelSync(): void {
  const tunnelRunning = useAppStore((s) => s.tunnelRunning);
  const tabs          = useAppStore((s) => s.tabs);
  const paneNames     = useAppStore((s) => s.paneNames);
  const paneCwds      = useAppStore((s) => s.paneCwds);
  const paneStatuses  = useAppStore((s) => s.paneStatus);
  const disabledPanes = useAppStore((s) => s.disabledPanes);
  const focusQueue    = useAppStore((s) => s.focusQueue);
  const extraPanes    = useAppStore((s) => s.tunnelExtraPanes);

  useEffect(() => {
    if (!tunnelRunning) return;
    const awaiting = new Set(focusQueue.map((q) => paneId(q.tab, q.pane)));
    const { panes, sessions } = buildPanePayload({
      tabs, paneNames, paneCwds, paneStatuses, disabledPanes, awaiting,
      nowIso: new Date().toISOString(),
      extraPanes,
    });
    tunnelSetPanes(panes).catch((e) => log.error(`tunnel: set_panes failed: ${e}`));
    tunnelSetSessions(sessions).catch((e) => log.error(`tunnel: set_sessions failed: ${e}`));
  }, [tunnelRunning, tabs, paneNames, paneCwds, paneStatuses, disabledPanes, focusQueue, extraPanes]);
}
