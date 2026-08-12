// The runtime fault-fix loop actuator (#2265, part of #2258). Polls each live project's runtime-fault
// store (`bsc errors list --unresolved --json`, the errordb #2260) on a slow cadence and, when the
// per-project auto-triage toggle is ON, routes a bounded, deduped set of fixes into that project's
// DIRECTOR pane — which captures + assigns each via the existing coordination emitters (bsc-issue →
// bsc-assign) and resolves it on land. The gate/dedup/rate-limit decisions are the pure
// `planFaultDispatch` (shared/lib/fleet/faultTriage.ts); this is the thin Tauri/React poll+inject layer,
// mounted once in ConsoleWorkspace (stays mounted across screens) beside useDirectorPump / useCoordinator.
// It lives in app/console (not shared/) because it reads the app's pane-identity + director-drive state.
//
// Projects with the toggle OFF (the default) are SURFACE-ONLY here — nothing is dispatched; the fault
// count still shows on the Glance node (useGlanceFaults). A project with no live director pane is also
// effectively surface-only (there's nowhere to route), which is the correct degrade.
//
// INERT since #app-stops-pushing-prompts. Its entire body was a poll that dispatched threshold-crossing runtime faults into the owning lane's pane. The fault store (errordb) is unchanged and the director protocol already tells the director to read it on its own cadence with `bsc errors list --unresolved`.
//
// The export SURVIVES deliberately: this module is registered in graphPlatform/appModules so graph
// RECORDS can import it, and removing the export breaks record compilation at runtime. Inert-but-
// exported is the shape useFleetGate took for the same reason when its launch pump was killed —
// deleting the hook is not the fix, doing nothing is.

/** Does nothing. See the note above. */
export function useFaultTriage(): void {
  // Intentionally empty: no poll, no evaluation, no injection.
}
