// The CI watcher (#373): closes the open-PR loop. A worker opens a PR and stops; CI runs
// unattended on GitHub. This hook polls each worker PR's check-run status and, when it
// reaches a terminal state, tells the worker to CONTINUE (passed -> next issue/stop;
// failed -> fix + push) and nudges the director to merge on green. App-side because CI is an
// external event no one can push -- something has to watch it; doing it here means the worker
// stops (no idle tokens) and is resumed only when there is something to do. Mounted once in
// ConsoleWorkspace. Pure rollup/prompts live in ciStatus.ts; this is the Tauri/React actuator.
//
// INERT since #app-stops-pushing-prompts. Its body polled check runs and typed CI outcomes into the director / owning worker. Under local-first there are no PRs to watch, and the director holds no GitHub write, so the signal it pushed had no action behind it.
//
// The export SURVIVES deliberately: this module is registered in graphPlatform/appModules so graph
// RECORDS can import it, and removing the export breaks record compilation at runtime — the shape
// useFleetGate took for the same reason.

// silently mis-resolved an identity id (the `p` in e.g. "my**p**roject") to a garbage pane, so the director
// never received the green-PR MERGE nudge and merged nothing (#2604). Both helpers handle either shape.

/** A fleet pane's project GROUP — its stable-identity project key, or a positional pane's tab prefix. */
export function ciGroupKey(paneId: string): string {
  return paneId.includes(":") ? paneId.split(":")[0] : paneId.slice(0, paneId.indexOf("p") + 1);
}
/** The DIRECTOR pane id for a worker pane — `<projectKey>:director`, or p0 of a legacy positional tab. */
export function ciDirectorPaneFor(paneId: string): string {
  return paneId.includes(":") ? `${paneId.split(":")[0]}:director` : `${paneId.slice(0, paneId.indexOf("p"))}p0`;
}

/** Does nothing. See the note above. */
export function useCiWatcher(): void {
  // Intentionally empty: no poll, no evaluation, no injection.
}
