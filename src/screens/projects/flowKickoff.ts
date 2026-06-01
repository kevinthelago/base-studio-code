// Generate the autonomy + push paragraph of a fleet stream's kickoff from its
// flow (#297). The kickoff is the first message a worker session receives; these
// two sentences tell it how to handle decisions (pause vs continue) and what /
// when to push — so the prose matches the permissions the flow also enforces
// (flowPermissions.ts). Pure; unit-tested.

import type { AgentFlow, FlowTrigger } from "./agentFlow";
import { resolveFlow } from "./agentFlow";

export interface FlowKickoffText {
  /** How to handle underspecified / risky decisions. */
  autonomy: string;
  /** What and when to push to GitHub. */
  push: string;
}

/** When a push fires, phrased for the kickoff sentence. */
const TRIGGER_PHRASE: Record<FlowTrigger, string> = {
  "per-issue": "each time you finish an owned issue",
  "per-stage": "at each pipeline stage boundary",
  "on-green": "as soon as the checks pass",
};

/**
 * Build the autonomy + push sentences for a stream's kickoff. `branch` is the
 * worktree branch (the stream id) the push sentence references. Falls back to
 * DEFAULT_FLOW when `flow` is unset, so pre-flow plans read exactly as before
 * (continuous + auto-pr).
 */
export function flowKickoffText(flow: AgentFlow | undefined, branch: string): FlowKickoffText {
  const f = resolveFlow(flow);
  const when = TRIGGER_PHRASE[f.trigger];

  let autonomy: string;
  switch (f.autonomy) {
    case "checkpoint":
      autonomy =
        "Work autonomously between checkpoints, but pause at each stage or PR boundary: pipe a short status of what you did and the next step into bsc-checkpoint on stdin, then pipe a one-line status into bsc-wait on stdin so you appear in the coordination inbox, and wait to be resumed before continuing. For underspecified details make the smallest reversible choice and record it via bsc-note; if genuinely blocked, pipe a one-line reason into bsc-blocked.";
      break;
    case "confirm":
      autonomy =
        "Before any non-trivial or irreversible decision, pause and ask the user to confirm rather than proceeding on your own — pipe your one-line question into bsc-wait on stdin so it surfaces in the coordination inbox and the user can resume you. For trivial, easily reversible choices, proceed and record them by piping a one-line note into bsc-note on stdin. If you are blocked, pipe a one-line reason into bsc-blocked.";
      break;
    default: // continuous
      autonomy =
        "Work autonomously and do not stop to ask: when something is underspecified, make the smallest reversible choice consistent with the plan goal and architecture, then record it by piping a one-line note into bsc-note on stdin. If you are genuinely blocked, pipe a one-line reason into bsc-blocked on stdin.";
  }

  let push: string;
  switch (f.push) {
    case "push-confirm":
      push = f.gate === "hard"
        ? `When your work is ready (${when}), commit to your branch ${branch} and run the checks locally, then STOP and ask the user before pushing — the push and PR commands prompt for approval, so wait for it.`
        : `When your work is ready (${when}), commit to your branch ${branch} and run the checks locally, then pause and ask the user before you push or open a PR.`;
      break;
    case "commit-only":
      push = `Commit your work to your branch ${branch} as you go, but do not push — the user or director will push your branch and open any PR.`;
      break;
    case "none":
      push = "This is a read-only role: do not commit, push, or open PRs. Report what you find by piping notes into bsc-note on stdin.";
      break;
    default: // auto-pr
      push = `When your work is ready and the checks pass (${when}), commit to your branch ${branch}, push it, and open a PR to develop for the director to merge.`;
  }

  return { autonomy, push };
}
