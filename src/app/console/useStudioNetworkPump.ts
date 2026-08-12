// The studio-network pump (#2940): drives the app-owned studio-session network so a `bsc-commission`
// emitted by one session (the planner, or the designer) is fulfilled by another (designer/librarian)
// and the authored artifact id is delivered back — all while the user stays in the planning surface.
//
// Two actuations, both re-derived from the FULL coord log every tick (restart-safe), guarded so each
// message injects exactly once:
//   1. AUTHOR TASK  — an open commission's spec → the TARGET studio pane, once the target has been
//      reachable for the settle window (the lazy-mount host has had time to launch the session; Claude
//      queues input typed mid-boot). Pure decision: studioNetworkDrive.authorInjections.
//   2. DELIVER-BACK — a `deliver`-stamped commission's artifact id → the REQUESTER's pane (a live
//      session). Pure decision: studioNetworkDrive.deliverBackInjections.
//
// REACHABILITY is on-demand: the pump publishes `activeStudioTargets` (targets with open commissions)
// to the store; ConsoleWorkspace's <StudioNetworkHosts> lazy-mounts each target's terminal (launching
// the session) and unmounts it when the list empties (ending the session). No idle studio sessions.
//
// Mounted once in ConsoleWorkspace (stays mounted across screens). Pure logic lives in
// studioNetworkDrive.ts; this is the thin Tauri/React actuator, like useDirectorPump.
//
// INERT since #app-stops-pushing-prompts. Its entire body was a poll that injected studio commissions and deliver-backs — and it also LAZY-MOUNTED a commission target, which is the app launching a session, forbidden twice over.
//
// The export SURVIVES deliberately: this module is registered in graphPlatform/appModules so graph
// RECORDS can import it, and removing the export breaks record compilation at runtime. Inert-but-
// exported is the shape useFleetGate took for the same reason when its launch pump was killed —
// deleting the hook is not the fix, doing nothing is.

/** Does nothing. See the note above. */
export function useStudioNetworkPump(): void {
  // Intentionally empty: no poll, no evaluation, no injection.
}
