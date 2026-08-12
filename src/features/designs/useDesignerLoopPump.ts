// The designer-loop PUMP (#3292/#3304, epic #3260) — the app-side driver that keeps the live Design Studio
// session iterating on a `bsc loop`. It is to a designer loop what `useDirectorPump` is to a fleet: poll →
// decide (a pure decider) → actuate. It drives the LIVE PTY (not a headless agent) because the designer
// live-restyles the RUNNING app — the actor has to be the running session.
//
// TWO MODES over one poll:
//  · INTERACTIVE (#3292, the default) — on the DRIVER's turn post "continue" and inject a GENERIC
//    next-change prompt; the human picks what gets worked on by talking to the session.
//  · OVERNIGHT / QUEUE (#3304) — opt-in, started from the banner. The run carries a ranked directive
//    queue built ONCE from the design system's own measured gaps (`buildDesignerQueue` over
//    `bsc ui components --coverage` + `bsc ui resolve`), and each driver turn captures a fresh
//    `bsc shot`, posts the directive as the driver's turn (shot attached), injects it, and advances the
//    cursor. It stops on the directive ceiling or when the queue drains.
//
// One tick: find the open `driver ↔ designer` loop (`bsc loop list`), read its turns (`bsc loop show`), and
// decide. On a stall either mode re-injects; otherwise it waits — the turn-flip the designer causes by
// recording is the "prompt me again" signal, so the pump never floods.
//
// STOPPING (the property that matters most for an unattended run). Four independent brakes, so no single
// failure leaves a loop spending money:
//  1. `bsc loop stop` — the banner's Stop pill, out-of-band, reachable at any time.
//  2. The pump's own ceiling — `decideOvernightAction` returns `stop` at the directive cap or on a drained
//     queue, and the pump then requests the halt. Because that verdict is recomputed every tick from
//     durable state, a swallowed CLI error simply RETRIES on the next tick rather than being lost.
//  3. The loop store's `--max-turns`/`--budget`, enforced inside `say` — durable, and it outlives this
//     process, so even a killed app cannot leave the loop runnable.
//  4. The run state is never persisted, so overnight mode cannot auto-start or survive a restart.
// The local run state is cleared only once the loop is OBSERVABLY gone, so a "stopping" run never silently
// hands its still-open loop back to the interactive path (which has no ceiling of its own).

//
// INERT since #app-stops-pushing-prompts. Its body drove the designer's iteration loop by typing each directive into the design-studio session. REMOVED WITH THE LOOP: the maintainer accepted that cost explicitly rather than carve out an exception, because an exception here is the app pushing prompts on a schedule, which is the whole of what this directive forbids.
//
// The export SURVIVES deliberately: this module is registered in graphPlatform/appModules so graph
// RECORDS can import it, and removing the export breaks record compilation at runtime — the shape
// useFleetGate took for the same reason.

/** Does nothing. See the note above. */
export function useDesignerLoopPump(): void {
  // Intentionally empty: no poll, no evaluation, no injection.
}
