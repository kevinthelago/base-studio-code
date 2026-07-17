// The designer-loop pump's PURE decision core (#3292, epic #3260) — the "driver brain" that keeps the live
// Design Studio session iterating on a `bsc loop`. React-free + side-effect-free so it's unit-testable in
// isolation; the hook (`useDesignerLoopPump`) gathers the live loop state, calls this, and actuates.
//
// THE PROGRESS SIGNAL IS THE LOOP'S OWN TURN ORDER. The loop is `driver` (a, speaks first) ↔ `designer` (b).
// When it is the DRIVER's turn, the designer just finished (it recorded its last change), so the pump posts
// the driver's "continue" turn and injects the next-change prompt into the designer PTY. When it is the
// DESIGNER's turn, the designer is still working — the pump WAITS (it never floods). So the turn-flip the
// designer causes by recording `bsc loop say --as designer …` is exactly the "prompt me again" signal — no
// PTY idle-status parsing needed. A stall (the designer never records) is caught by a nudge timeout.

/** The `driver`/`designer` participant names — the pump owns the driver side, the live session is designer. */
export const DRIVER = "driver";
export const DESIGNER = "designer";

/** Re-prompt the designer if it has neither recorded nor acted this long after the last inject (a stall). */
export const DEFAULT_NUDGE_MS = 90_000;

/** The subset of a `bsc loop` row the pump reads (from `bsc loop list --json`). */
export interface LoopRow {
  id: number;
  a: string;
  b: string;
  status: string; // "open" | "closed"
}

/** The subset of a turn the pump reads (from `bsc loop show --json`). */
export interface LoopTurn {
  participant: string;
}

/** What the pump should do this tick. */
export type LoopPumpAction =
  | { kind: "continue"; prompt: string } // the driver's turn: post the driver turn, then inject the prompt
  | { kind: "nudge"; prompt: string } //    the designer stalled: re-inject (do NOT post a driver turn)
  | { kind: "wait" } //                     the designer is working — hold
  | { kind: "idle" }; //                    no open designer loop — the pump is dormant

/** The inputs a tick decides over. */
export interface LoopPumpInput {
  loop: LoopRow | null;
  turns: readonly LoopTurn[];
  now: number;
  /** When the pump last injected for this loop (0 when it hasn't). */
  lastInjectAt: number;
  nudgeAfterMs: number;
}

/** The one OPEN designer loop (a `driver ↔ designer` pair), or `null`. The pump drives exactly one. */
export function pickDesignerLoop(loops: readonly LoopRow[]): LoopRow | null {
  return loops.find((l) => l.status === "open" && l.a === DRIVER && l.b === DESIGNER) ?? null;
}

/** Whose turn it is next — `a` first, strict alternation (mirrors the store's `next_speaker`). */
export function whoseTurn(a: string, b: string, turns: readonly LoopTurn[]): string {
  const last = turns.length ? turns[turns.length - 1].participant : null;
  return last === a ? b : a;
}

/** Decide the pump's action for this tick. Pure. */
export function decideLoopPumpAction(inp: LoopPumpInput): LoopPumpAction {
  const { loop, turns, now, lastInjectAt, nudgeAfterMs } = inp;
  if (!loop || loop.status !== "open") return { kind: "idle" };
  if (whoseTurn(loop.a, loop.b, turns) === DRIVER) {
    return { kind: "continue", prompt: nextChangePrompt(loop.id) };
  }
  // The designer's turn — it's working. Only re-prompt if it has clearly stalled past the last inject.
  if (now - lastInjectAt > nudgeAfterMs) return { kind: "nudge", prompt: nudgePrompt(loop.id) };
  return { kind: "wait" };
}

/** The next-change prompt injected into the designer PTY. SINGLE LINE (injectPrompt submits with a CR — an
 *  embedded newline would submit early). Backticks are markdown in Claude's input, not shell. */
export function nextChangePrompt(id: number): string {
  return (
    `Design loop #${id}: make ONE meaningful change to the running app (via \`bsc ui\`), capture it with ` +
    `\`bsc shot\`, then record it — \`bsc loop say --as designer ${id} --shot <path> "<what you changed>"\` — ` +
    `and stop; you'll be prompted for the next change. The shot is the ground truth, not your description.`
  );
}

/** The stall nudge — the designer hasn't recorded; prod it to record or make the next change. Single line. */
export function nudgePrompt(id: number): string {
  return (
    `Design loop #${id}: record your last change now — ` +
    `\`bsc loop say --as designer ${id} --shot <path> "<summary>"\` — or make the next change.`
  );
}
