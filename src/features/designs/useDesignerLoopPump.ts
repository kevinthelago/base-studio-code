// The designer-loop PUMP (#3292, epic #3260) — the app-side driver that keeps the live Design Studio
// session iterating on a `bsc loop`. It is to a designer loop what `useDirectorPump` is to a fleet: poll →
// decide (pure `decideLoopPumpAction`) → actuate. It drives the LIVE PTY (not a headless agent) because the
// designer live-restyles the RUNNING app — the actor has to be the running session.
//
// One tick: find the open `driver ↔ designer` loop (`bsc loop list`), read its turns (`bsc loop show`), and
// decide. On the DRIVER's turn it posts the driver's "continue" turn (advancing the alternation) and injects
// the next-change prompt into the designer PTY; on a stall it re-injects; otherwise it waits. The loop is
// `--until false` (infinite) — only the user's `bsc loop stop` (the reachable kill switch, see
// DesignerLoopBanner) or a budget/max-turns ceiling halts it, at which point this pump goes dormant.

import { useRef } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson, bscRun } from "@/shared/lib/core/bsc";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import { DESIGN_STUDIO_SESSION_ID } from "@/shared/lib/session/systemSessions";
import { decideLoopPumpAction, pickDesignerLoop, DEFAULT_NUDGE_MS, DRIVER, type LoopRow, type LoopTurn } from "./lib/designerLoopDrive";

const POLL_MS = 3000;

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
      if (!loop) {
        lastInjectAt.current = 0; // no active loop → reset the stall clock
        return;
      }
      const show = await bscJson<{ turns: LoopTurn[] } | null>(null, ["loop", "show", String(loop.id), "--json"], null);
      if (isCancelled() || !show) return;

      const action = decideLoopPumpAction({
        loop,
        turns: show.turns ?? [],
        now: Date.now(),
        lastInjectAt: lastInjectAt.current,
        nudgeAfterMs: DEFAULT_NUDGE_MS,
      });
      if (action.kind === "wait" || action.kind === "idle") return;

      inFlight.current = true;
      try {
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
