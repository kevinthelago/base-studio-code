// The director pump (#366, #369, #371): drives the fleet's async-integrator "director"
// session so it does not just idle after its kickoff. Two delivery paths, injected via
// pty_write into the director pane:
//
//  1. PENDING WORKER QUESTIONS (state-based) -- unanswered `bsc-ask` questions are
//     re-derived from the FULL coord log every tick (ingestCoordLog -> state.asking), so a
//     question is delivered even if it was logged before the pump first saw the director or
//     across an app restart. Each (pane, ask) is surfaced once; the key is pruned when the
//     ask is answered/woken so a re-ask re-surfaces. Delivered when the director is idle, or
//     after ASK_FALLBACK_MS even if it is not (the TUI may never trip the 1.5s idle gate;
//     Claude Code queues input typed mid-turn). This is the must-not-drop case.
//  2. NOTIFICATIONS + HEARTBEAT (cursor-based) -- landed/blocked/failed activity and the
//     periodic sweep, via decideDirectorAction (idle-gated).
//
// Mounted once in ConsoleWorkspace (which stays mounted across screens). Pure logic lives in
// directorDrive.ts + coordination.ts; this is the thin Tauri/React actuator.
//
// INERT since #app-stops-pushing-prompts. Its body polled coord.log and typed pending asks, briefs, requests and routed actions into the director's pane. The events are still WRITTEN to coord.log by the bsc-* emitters; the director reads them on its own cadence instead of being poked.
//
// The export SURVIVES deliberately: this module is registered in graphPlatform/appModules so graph
// RECORDS can import it, and removing the export breaks record compilation at runtime — the shape
// useFleetGate took for the same reason.

import type { RefObject } from "react";

/** Does nothing. See the note above. */
export function useDirectorPump(_paneStatusesRef: RefObject<Record<string, "run" | "on" | "idle">>): void {
  // Intentionally empty: no poll, no evaluation, no injection.
}
