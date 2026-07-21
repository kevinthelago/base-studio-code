// Always-on tunnel pane-sync (#801). Pushes the relay's pane list + session metadata
// from the store, regardless of which screen is mounted — previously this lived in
// Console.tsx, so the mirror went stale (and excluded the planner) the moment you left
// the Console screen. Mounted once in App. PTY *bytes* are teed in Rust; this is the
// low-volume names/cwds/statuses + every registered extra session (planner/designer,
// via the keyed `tunnelExtraPanes` registry, #2497).
//
// Roster identity (#2497): panes ride under their IDENTITY id (`paneIdFor`, #1176) — the
// same id their PTY/status/cwd are keyed by — with a `kind` derived from the id grammar,
// so fleet workers (`<key>:<stream>`), the director, triage panes, and manual consoles
// are all addressable from mobile.

import { useEffect } from "react";
import { useAppStore } from "@/store";
import { paneIdFor } from "@/app/console/lib/paneIdentity";
import { buildPanePayload } from "./lib/tunnel";
import { tunnelSetPanes, tunnelSetSessions } from "./lib/tunnelClient";
import { log } from "@/shared/lib/core/log";

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
    // The focus queue is positional (tab/pane indices) — resolve each entry to the same
    // identity id the payload keys panes by.
    const awaiting = new Set(focusQueue.map((q) => paneIdFor(tabs[q.tab], q.tab, q.pane)));
    // Flatten the keyed extra-pane registry in stable (sorted-source) order so re-registration
    // by one source never reorders another's panes.
    const extras = Object.keys(extraPanes).sort().flatMap((source) => extraPanes[source]);
    const { panes, sessions } = buildPanePayload({
      tabs, paneNames, paneCwds, paneStatuses, disabledPanes, awaiting,
      nowIso: new Date().toISOString(),
      extraPanes: extras,
    });
    tunnelSetPanes(panes).catch((e) => log.error(`tunnel: set_panes failed: ${e}`));
    tunnelSetSessions(sessions).catch((e) => log.error(`tunnel: set_sessions failed: ${e}`));
  }, [tunnelRunning, tabs, paneNames, paneCwds, paneStatuses, disabledPanes, focusQueue, extraPanes]);
}
