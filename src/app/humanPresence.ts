// Human presence (#4248) — is somebody at the keyboard right now?
//
// ## Why this exists
// #3599 stopped a designer follow-along from stealing the user's page, and drew the line at EXPLICIT vs
// BACKGROUND: an explicit `--workspace`/`--page` was treated as a deliberate steer and honoured. That
// line does not separate the two cases, because an agent's background loop IS MADE OF EXPLICIT COMMANDS.
// Measured in `audit.log`, the designer issued `bsc navigate component …` (correctly declined off-Studio)
// followed immediately by `bsc navigate page designs` — every ~7 seconds, for the whole run.
//
// The distinction that actually matters is **who is driving**. Steering the view is right when the app is
// running unattended (the overnight loop, #3260/#3263 — the case the steering was built for) and wrong
// when a person is using it. Nothing in the bridge knew which it was.
//
// ## Why a module ref, not store state
// Every real input event would write the store, and anything subscribed would re-render on it — a
// per-keystroke commit for a value no UI displays. #4170 was exactly that shape (a store write in a
// publish path, feeding back into a render loop), so this stays a module-local timestamp: no subscribers,
// no commits, and reading it cannot participate in a render cycle.
//
// It is deliberately NOT "is the window focused". A session can be capturing while the user reads a
// terminal in the same window, and a focused-but-idle window overnight would block the loop forever.
// Recent INPUT is the honest signal for "someone is working right now".

/** How long after an input event a human still counts as present.
 *
 *  Long enough to cover reading and thinking between actions — a person scanning a page is still using
 *  it — and short enough that a machine left alone becomes unattended within one loop iteration. The
 *  designer loop fires roughly every 7s, so anything under ~10s would let it steal the view between two
 *  keystrokes, which is the complaint. */
export const PRESENT_WINDOW_MS = 45_000;

/** Wall-clock ms of the last real user input. `0` = none seen since load, i.e. unattended. */
let lastInputAt = 0;

/** The events that count as a person acting. Pointer/key/wheel only — NOT `mousemove`, which fires from
 *  incidental cursor drift and from some automation, and would report presence for a room nobody is in. */
const INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** Record that a human just did something. Exported for tests and for any surface that knows about an
 *  interaction the DOM listeners cannot see. */
export function noteHumanActivity(at: number = Date.now()): void {
  if (at > lastInputAt) lastInputAt = at;
}

/** Is a human present right now? */
export function humanPresent(now: number = Date.now(), windowMs: number = PRESENT_WINDOW_MS): boolean {
  return lastInputAt > 0 && now - lastInputAt < windowMs;
}

/** Ms since the last input, or `null` when none has been seen. For the decline message — "nobody has
 *  touched this in 4 minutes" is checkable, "declined" alone is not. */
export function msSinceHumanActivity(now: number = Date.now()): number | null {
  return lastInputAt > 0 ? now - lastInputAt : null;
}

/** Test-only reset. */
export function __resetHumanPresence(): void {
  lastInputAt = 0;
}

/** Install the listeners. Called once by the shell. Returns a disposer.
 *
 *  `capture: true` + `passive: true`: capture so an event consumed by a component (a key handled by the
 *  terminal, say) is still SEEN — those are the most certain evidence of a person — and passive so this
 *  can never delay input handling. */
export function installHumanPresence(target: EventTarget = window): () => void {
  const on = () => noteHumanActivity();
  for (const e of INPUT_EVENTS) target.addEventListener(e, on, { capture: true, passive: true });
  return () => {
    for (const e of INPUT_EVENTS) target.removeEventListener(e, on, { capture: true });
  };
}
