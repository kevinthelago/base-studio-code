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
import type { DesignDirective } from "./designerQueue";

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
/** The one OPEN loop between `a` and `b`, or `null`. Defaults to the `driver ↔ designer` pair — the UI
 *  loop this feature drives — but takes the pairing explicitly (#3850) so a DIFFERENT loop shape can
 *  coexist: #3263's tooling loop is `designer ↔ external`, and a hard-coded pair would have made the two
 *  mutually exclusive rather than concurrent. */
export function pickDesignerLoop(
  loops: readonly LoopRow[],
  a: string = DRIVER,
  b: string = DESIGNER,
): LoopRow | null {
  return loops.find((l) => l.status === "open" && l.a === a && l.b === b) ?? null;
}

/** Whose turn it is next — `a` first, strict alternation (mirrors the store's `next_speaker`). */
export function whoseTurn(a: string, b: string, turns: readonly LoopTurn[]): string {
  const last = turns.length ? turns[turns.length - 1].participant : null;
  return last === a ? b : a;
}

/** The stall nudge — the designer hasn't recorded; prod it to record or make the next change. Single line. */
export function nudgePrompt(id: number): string {
  return (
    `Design loop #${id}: record your last change now — ` +
    `\`bsc loop say --as designer ${id} --shot <path> "<summary>"\` — or make the next change.`
  );
}

// ── The loop decider (#3311/#3850). A designer session is either running a LOOP or in normal chat —
// there is no third "interactive loop" mode (the `decideLoopPumpAction` that used to sit above was a
// vestige, and it contradicted the launch contract, which already said the pump drives "ONLY while an
// open loop exists — so an interactive studio session stops and hands back"). So this is THE decider: each
// driver turn dispatches a specific DIRECTIVE from the auto-queue (buildDesignerQueue), grounds it with a
// shot, and is BUDGET-bounded — stopping on a turn ceiling OR when the queue drains (a GOOD end: nothing
// left to improve). ─────────────────────────────────────────────────────────────────────────────────────

/** Default overnight budget — "a while", not forever. The reachable Stop pill (#3294) can end it sooner. */
export const DEFAULT_MAX_TURNS = 40;

/** What the overnight pump should do this tick. */
export type OvernightAction =
  | { kind: "direct"; directive: DesignDirective; prompt: string; burst: boolean } // driver's turn: dispatch
  | { kind: "nudge"; prompt: string } //   the designer stalled — re-inject
  | { kind: "wait" } //                    the designer is working — hold
  | { kind: "stop"; reason: string } //    budget reached OR the queue drained (a good end)
  | { kind: "idle" }; //                   no open designer loop

/** The inputs an overnight tick decides over. */
export interface OvernightInput {
  loop: LoopRow | null;
  turns: readonly LoopTurn[];
  now: number;
  lastInjectAt: number;
  nudgeAfterMs: number;
  /** The ranked directive queue (from `buildDesignerQueue`). */
  queue: readonly DesignDirective[];
  /** Directives dispatched so far this run — the queue cursor AND the turn count. */
  cursor: number;
  /** The turn ceiling — stop once `cursor` reaches it. */
  maxTurns: number;
}

/** Decide the loop pump's action for this tick. Pure. The driver's turn dispatches the next queued
 *  directive — or stops (budget reached / queue drained). */
export function decideOvernightAction(inp: OvernightInput): OvernightAction {
  const { loop, turns, now, lastInjectAt, nudgeAfterMs, queue, cursor, maxTurns } = inp;
  if (!loop || loop.status !== "open") return { kind: "idle" };
  if (whoseTurn(loop.a, loop.b, turns) === DRIVER) {
    if (cursor >= maxTurns) return { kind: "stop", reason: `budget reached — ${maxTurns} changes made` };
    if (cursor >= queue.length) {
      return { kind: "stop", reason: `queue drained — ${queue.length} directive(s) done, nothing left to improve` };
    }
    const directive = queue[cursor];
    return { kind: "direct", directive, prompt: directivePrompt(loop.id, directive), burst: directive.kind === "motion" };
  }
  // The designer's turn — working. Re-prompt only on a clear stall past the last inject.
  if (now - lastInjectAt > nudgeAfterMs) return { kind: "nudge", prompt: nudgePrompt(loop.id) };
  return { kind: "wait" };
}

/** The directive prompt injected into the designer PTY. SINGLE LINE (injectPrompt submits on CR). A motion
 *  directive grounds with a --frames burst; everything else with a single component-preview shot (#3308). */
export function directivePrompt(id: number, d: DesignDirective): string {
  const shot = d.kind === "motion" ? "`bsc shot preview --frames 6`" : "`bsc shot preview`";
  return (
    `Design loop #${id} — ${d.title}: ${d.detail} Make the change via \`bsc ui\`, capture it with ${shot}, ` +
    `then record it — \`bsc loop say --as designer ${id} --shot <path> "<what you changed>"\` — and stop; ` +
    `you'll get the next directive. The shot is the ground truth, not your description.`
  );
}

/** The driver's own turn summary — what the pump posts (`bsc loop say --as driver … --shot <current>`)
 *  alongside the current-state shot, so the loop log reads as a grounded change history. */
export function driverSay(d: DesignDirective): string {
  return `[${d.kind}] ${d.title}`;
}
