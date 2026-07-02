// Generate the autonomy + push paragraph of a fleet stream's kickoff from its
// flow (#297). The kickoff is the first message a worker session receives; these
// two sentences tell it how to handle decisions (pause vs continue) and what /
// when to push — so the prose matches the permissions the flow also enforces
// (flowPermissions.ts). Pure; unit-tested.

import type { AgentFlow, FlowTrigger } from "./agentFlow";
import { resolveFlow } from "./agentFlow";
import flowKickoffEmbedded from "@data/fleet/flow-kickoff.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

export interface FlowKickoffText {
  /** How to handle underspecified / risky decisions. */
  autonomy: string;
  /** What and when to push to GitHub. */
  push: string;
}

// The trigger-phrase MAP + the per-autonomy PROSE are externalized to `@data/fleet/flow-kickoff.json`
// (#2145, epic #2027 tail) — editable without touching code + part of the exportable config bundle; the
// config-dir copy (#2047) overlays the embedded default via `overlayFile`. Only these fully-static strings
// moved; the push sentences below stay inline because they interpolate `${when}`/`${branch}` mid-string.
const KICKOFF_PROSE = overlayFile("fleet/flow-kickoff.json", flowKickoffEmbedded);

/** When a push fires, phrased for the kickoff sentence. */
const TRIGGER_PHRASE = KICKOFF_PROSE.triggerPhrase as Record<FlowTrigger, string>;

/**
 * Build the autonomy + push sentences for a stream's kickoff. `branch` is the
 * worktree branch (the stream id) the push sentence references. Falls back to
 * DEFAULT_FLOW when `flow` is unset, so pre-flow plans read exactly as before
 * (continuous + auto-pr).
 */
export function flowKickoffText(flow: AgentFlow | undefined, branch: string): FlowKickoffText {
  const f = resolveFlow(flow);
  const when = TRIGGER_PHRASE[f.trigger];

  // The autonomy prose is fully static (no interpolation) → sourced from data, keyed by autonomy mode.
  const autonomy = KICKOFF_PROSE.autonomy[f.autonomy];

  let push: string;
  switch (f.push) {
    case "push-confirm":
      push = f.gate === "hard"
        ? `When your work is ready (${when}), commit to your branch ${branch} and run the checks locally, then STOP and ask the user before pushing — the push and PR commands prompt for approval, so wait for it.`
        : `When your work is ready (${when}), commit to your branch ${branch} and run the checks locally, then pause and ask the user before you push or open a PR.`;
      break;
    case "self-merge":
      push = `When your work is ready, integrate it yourself (${when}) — do NOT open a PR and do NOT wait for CI. Steps: (1) run the FULL local gate (typecheck + tests + any native build) and make it green; (2) git fetch origin develop and rebase your branch ${branch} onto origin/develop; (3) re-run the FULL gate on the rebased, integrated tree — this is the integration check; (4) if green, merge ${branch} into develop and push develop. If the push is rejected because another stream merged first, re-fetch, rebase, re-gate, and push again. After develop has your commit, pipe your landed issue ref into bsc-landed on stdin (e.g. echo "#42" | bsc-landed) so the director and board track it, then continue to your next issue. develop's CI is the director's backstop, not your gate. Do not stop while you still have owned issues to integrate — only end your turn once every owned issue is on develop with the gate green.`;
      break;
    case "commit-only":
      push = `Commit your work to your branch ${branch} as you go, but do not push — the user or director will push your branch and open any PR.`;
      break;
    case "none":
      push = "This is a read-only role: do not commit, push, or open PRs. Report what you find by piping notes into bsc-note on stdin.";
      break;
    default: // auto-pr
      push = `When your work is ready and the checks pass (${when}), commit to your branch ${branch}, push it, and open a PR to develop. After opening the PR, STOP -- CI runs automatically and is watched for you: when it finishes you will be told to continue (if it passed) or to fix the build and push (if it failed). Do not poll CI, close, merge, reopen, or duplicate the PR -- GitHub is the DIRECTOR's job: the director reviews, merges, and closes your PR once it is green. Never run gh pr merge or gh pr close on your own PR.`;
  }

  // Issue lifecycle is the director's job (#906): a worker signals completion (above) but
  // never closes the GitHub issue itself — workers have GitHub read access only, so the role
  // gate blocks `gh issue close` and attempting it just wastes a turn. The director closes the
  // issue once the work lands (it sees the PR merge / your `bsc-landed`). A read-only (`none`)
  // role owns no issue to close, so it gets no such clause.
  if (f.push !== "none") {
    push += " Do not close, reopen, or edit the GitHub issue yourself — the director manages issue state and closes it once your work lands; just signal completion as above.";
  }

  return { autonomy, push };
}
