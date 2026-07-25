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

import { useRef } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { useAppStore } from "@/store";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { DESIGN_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";
import {
  decideLoopPumpAction, decideOvernightAction, driverSay, pickDesignerLoop,
  DEFAULT_NUDGE_MS, DRIVER, type LoopRow, type LoopTurn,
} from "./lib/designerLoopDrive";
import { buildDesignerQueue, parseCoverage, parseResolve, type DesignDirective } from "./lib/designerQueue";

const POLL_MS = 3000;

/** Frames in a MOTION directive's grounding burst — "a few frames across an animation" (#3261). */
const BURST_FRAMES = 6;

/** Capture the preview's real pixels for this turn; `null` when the app can't snapshot (never fatal —
 *  an ungrounded turn is worse than no turn, but a stalled RUN is worse than both, so we proceed). */
async function captureShot(burst: boolean): Promise<string | null> {
  const args = ["shot", "preview"];
  if (burst) args.push("--frames", String(BURST_FRAMES));
  const res = await bscJson<{ path?: string; frames?: { path?: string }[] } | null>(null, args, null);
  if (!res) return null;
  if (typeof res.path === "string") return res.path; // single frame → { path, w, h }
  const first = res.frames?.[0]?.path; //                burst      → { frames: [ … ] }
  return typeof first === "string" ? first : null;
}

/** Build the run's ranked queue from the design system's OWN measured gaps. Both reports are tolerated as
 *  absent (`parseCoverage`/`parseResolve` yield `null`), in which case the queue is just motion + polish. */
async function buildQueue(components: { id: string; name: string; role?: string }[], round: number): Promise<DesignDirective[]> {
  const [cov, res] = await Promise.all([
    bscJson<unknown>(null, ["ui", "components", "--coverage"], null),
    bscJson<unknown>(null, ["ui", "resolve"], null),
  ]);
  return buildDesignerQueue({ coverage: parseCoverage(cov), resolve: parseResolve(res), components, round });
}

/** Drive the open designer loop from the long-lived Design Studio workspace (mounted in `DesignsWorkbench`).
 *  A no-op whenever there is no open `driver ↔ designer` loop, so it costs one lightweight `bsc loop list`
 *  poll while idle. */
export function useDesignerLoopPump(): void {
  const inFlight = useRef(false); // one actuation at a time — a slow inject must not double-fire
  const lastInjectAt = useRef(0);

  usePoll(
    async (isCancelled) => {
      if (inFlight.current) return;
      const loops = await bscJson<LoopRow[]>(null, ["loop", "list", "--open", "--json"], []);
      if (isCancelled()) return;
      const loop = pickDesignerLoop(loops);
      // Read the run FRESH each tick (not off a render closure) so a Stop lands on the very next tick.
      const s = useAppStore.getState();
      const run = s.designerOvernight;
      if (!loop) {
        lastInjectAt.current = 0; // no active loop → reset the stall clock
        if (run) s.endDesignerOvernight(); // the run's loop is closed/gone → leave overnight mode
        return;
      }
      // A run whose loop is no longer THE open loop is over; fall back to the interactive path.
      const overnight = run && run.loopId === loop.id ? run : null;
      if (run && !overnight) s.endDesignerOvernight();

      // A halt was requested — dispatch NOTHING and keep re-issuing the stop until the loop is observably
      // gone (the branch above then clears the run). Idempotent, so retrying costs nothing.
      if (overnight?.stopping) {
        await bscRun(null, ["loop", "stop", String(loop.id)]);
        return;
      }

      const show = await bscJson<{ turns: LoopTurn[] } | null>(null, ["loop", "show", String(loop.id), "--json"], null);
      if (isCancelled() || !show) return;
      const turns = show.turns ?? [];

      // Build the queue ONCE per run, before the first dispatch. Building it once (rather than per turn) is
      // what makes `queue[cursor]` mean what `decideOvernightAction` says it means: a rebuilt queue shrinks
      // as findings are fixed, which would slide the cursor over unfixed work.
      if (overnight && overnight.queue.length === 0) {
        const comps = s.components.filter((c) => c.kitId === s.designsKitId);
        const queue = await buildQueue(comps, 0);
        if (isCancelled()) return;
        if (queue.length === 0) {
          await s.stopDesignerOvernight(); // nothing to work on — a good, immediate end
          return;
        }
        s.setDesignerOvernightQueue(queue);
        return; // dispatch on the next tick, against the installed queue
      }

      const action = overnight
        ? decideOvernightAction({
            loop, turns, now: Date.now(), lastInjectAt: lastInjectAt.current, nudgeAfterMs: DEFAULT_NUDGE_MS,
            queue: overnight.queue, cursor: overnight.cursor, maxTurns: overnight.maxTurns,
          })
        : decideLoopPumpAction({ loop, turns, now: Date.now(), lastInjectAt: lastInjectAt.current, nudgeAfterMs: DEFAULT_NUDGE_MS });

      if (action.kind === "wait" || action.kind === "idle") return;
      if (action.kind === "stop") {
        await s.stopDesignerOvernight(); // budget reached or queue drained
        return;
      }

      inFlight.current = true;
      try {
        if (action.kind === "direct") {
          // Ground the turn in real pixels BEFORE prompting, so the driver's turn records the state the
          // directive is being given against (the shot is the ground truth, not the description).
          const shot = await captureShot(action.burst);
          if (isCancelled()) return;
          const say = ["loop", "say", String(loop.id), "--as", DRIVER, driverSay(action.directive)];
          if (shot) say.push("--shot", shot);
          await bscRun(null, say);
          if (isCancelled()) return;
          await injectPrompt(DESIGN_STUDIO_SESSION_ID, action.prompt);
          lastInjectAt.current = Date.now();
          useAppStore.getState().advanceDesignerOvernight();
          return;
        }
        // `continue` advances the alternation (posts the driver's turn) before prompting; a `nudge` re-prompts
        // the same (still-designer) turn without posting, so it doesn't skew the transcript.
        if (action.kind === "continue") {
          await bscRun(null, ["loop", "say", String(loop.id), "--as", DRIVER, "continue"]);
          if (isCancelled()) return;
        }
        await injectPrompt(DESIGN_STUDIO_SESSION_ID, action.prompt);
        lastInjectAt.current = Date.now();
      } finally {
        inFlight.current = false;
      }
    },
    POLL_MS,
    [],
  );
}
