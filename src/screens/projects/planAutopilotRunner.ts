// Planning autopilot runner (#682, Phase 1b) — the live loop that drives a real planning
// session with the simulated user, built on the pure core (planAutopilot.ts).
//
// `autopilotTick` runs ONE step (read state → decide → execute) and is pure of timers/React,
// so it's unit-testable with injected deps. `usePlanAutopilot` runs it on a guarded interval
// and is the thin, manual-test wiring. Publish is MOCKED via deps — the harness never mutates
// real GitHub.

import { useEffect, useRef, useState } from "react";
import {
  decideAutopilotAction, buildUserSimPrompt, staticReply, type AutopilotResult, type AutopilotStrategy,
} from "./planAutopilot";

/** The live planning state the runner reads each tick (computed by the host component). */
export interface AutopilotSnapshot {
  planReady: boolean;
  /** Active stage's confirmable section keys — non-empty only when the stage is ready. */
  confirmKeys: string[];
  /** Planner finished its turn and is awaiting input (idle-detected by the host). */
  plannerAwaiting: boolean;
  /** The planner produced new output since the last tick — forward progress, resets idle. */
  working: boolean;
  /** (Mock-)publish on completion vs stop at a publishable plan for review (#682). */
  autoPublish: boolean;
  progress: { done: number; total: number; fraction: number };
}

/** Injected effects — the host wires these to the real session/store (or fakes, in tests). */
export interface AutopilotDeps {
  pitch: string;
  /** How the simulated user answers: `llm` (Claude), or `scripted`/`random`/`none` (Phase 2). */
  strategy: AutopilotStrategy;
  snapshot: () => AutopilotSnapshot;
  /** The planner's output since the last reply (for the user-sim). */
  pendingOutput: () => string;
  /** Generate a simulated-user reply (the llm strategy → a Claude completion). */
  userSim: (system: string, user: string) => Promise<string>;
  /** Send a line of input to the planner session. */
  sendReply: (text: string) => void;
  /** Confirm the given sections + advance the stage. */
  confirm: (keys: string[]) => void;
  /** MOCKED publish — record only; never touch real GitHub. */
  mockPublish: () => void;
  log: (e: AutopilotLogEntry) => void;
}

export interface AutopilotLogEntry { tick: number; action: string; detail?: string }

export interface AutopilotRunState {
  iteration: number;
  idleStreak: number;
  published: boolean;
  finished: boolean;
  result?: AutopilotResult;
}

export const initRunState = (): AutopilotRunState =>
  ({ iteration: 0, idleStreak: 0, published: false, finished: false });

/** Runaway + stall guards. */
export const MAX_ITERATIONS = 60;
export const MAX_IDLE = 6;

const finish = (state: AutopilotRunState, snap: AutopilotSnapshot, completed: boolean, stalledReason?: string): AutopilotResult =>
  ({ completed, published: state.published, iterations: state.iteration, progress: snap.progress, stalledReason });

/**
 * Run one autopilot tick: snapshot the plan → decide → execute the action. Returns the next
 * run state. Timer-/React-free so it's directly unit-testable with injected {@link AutopilotDeps}.
 */
export async function autopilotTick(state: AutopilotRunState, deps: AutopilotDeps): Promise<AutopilotRunState> {
  if (state.finished) return state;
  const snap = deps.snapshot();
  // Active planner output is forward progress — never count it as idle.
  const idle = snap.working ? 0 : state.idleStreak;
  const action = decideAutopilotAction({
    planReady: snap.planReady,
    published: state.published,
    confirmKeys: snap.confirmKeys,
    plannerAwaiting: snap.plannerAwaiting,
    iteration: state.iteration,
    maxIterations: MAX_ITERATIONS,
    idleStreak: idle,
    maxIdle: MAX_IDLE,
    autoPublish: snap.autoPublish,
  });
  const next: AutopilotRunState = { ...state, iteration: state.iteration + 1, idleStreak: idle };

  switch (action.kind) {
    case "reply": {
      // `llm` asks Claude; the other strategies use a canned reply (`none` sends nothing,
      // which lets idle climb to a stall — the "no response" test). (#682, Phase 2)
      let reply: string | null;
      if (deps.strategy === "llm") {
        const { system, user } = buildUserSimPrompt(deps.pitch, deps.pendingOutput());
        reply = await deps.userSim(system, user);
      } else {
        reply = staticReply(deps.strategy, state.iteration);
      }
      if (reply !== null) {
        deps.sendReply(reply);
        deps.log({ tick: state.iteration, action: "reply", detail: reply.slice(0, 80) });
        next.idleStreak = 0;
      } else {
        deps.log({ tick: state.iteration, action: "reply", detail: "(none — sent nothing)" });
        next.idleStreak = idle + 1;
      }
      break;
    }
    case "confirm":
      deps.confirm(action.keys);
      deps.log({ tick: state.iteration, action: "confirm", detail: action.keys.join(", ") });
      next.idleStreak = 0;
      break;
    case "publish":
      deps.mockPublish();
      deps.log({ tick: state.iteration, action: "publish (mocked)" });
      next.published = true;
      break;
    case "done":
      next.finished = true;
      next.result = finish(state, snap, true);
      deps.log({ tick: state.iteration, action: "done" });
      break;
    case "stall":
      next.finished = true;
      next.result = finish(state, snap, false, action.reason);
      deps.log({ tick: state.iteration, action: "stall", detail: action.reason });
      break;
    case "wait":
      next.idleStreak = idle + 1;
      break;
  }
  return next;
}

/**
 * The thin React wiring: runs {@link autopilotTick} on a guarded interval (no overlapping
 * ticks) while `running`, stopping when the run finishes. Manual-test-only — the testable
 * logic lives in `autopilotTick`.
 */
export function usePlanAutopilot(deps: AutopilotDeps, tickMs = 3500) {
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<AutopilotRunState>(initRunState());
  const stateRef = useRef(state);
  const depsRef = useRef(deps);
  const ticking = useRef(false);
  stateRef.current = state;
  depsRef.current = deps;

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      if (ticking.current || stateRef.current.finished) return;
      ticking.current = true;
      void autopilotTick(stateRef.current, depsRef.current)
        .then((nextState) => {
          setState(nextState);
          if (nextState.finished) setRunning(false);
        })
        .catch((e) => {
          depsRef.current.log({ tick: stateRef.current.iteration, action: "error", detail: String(e) });
          setRunning(false);
        })
        .finally(() => { ticking.current = false; });
    }, tickMs);
    return () => clearInterval(id);
  }, [running, tickMs]);

  const start = () => { setState(initRunState()); setRunning(true); };
  const stop = () => setRunning(false);
  return { running, state, start, stop };
}
