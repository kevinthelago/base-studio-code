// Translate a per-agent flow (#297) into the launch-time permission rules that
// govern its GitHub writes. The session already allows the Bash tool broadly
// (start-and-go) and guarantees gh/git; this layer narrows ONLY the propagation
// writes — `git push` and `gh pr create` — per the flow's push policy and gate.
//
// Precedence in Claude Code settings is deny > ask > allow, so a specific `ask`
// rule prompts even under the broad Bash allow, and a specific `deny` hard-blocks.
// That maps the flow's push axis cleanly:
//   auto-pr       → no rules (broad allow permits push+PR; --force stays denied)
//   push-confirm  → hard: ask before push/PR (prompt); soft: no rule (kickoff asks)
//   commit-only   → deny push/PR (commits stay local)
//   none          → deny push/PR (no GitHub propagation)
//
// The autonomy axis is behavioral (enforced via the kickoff, S4), and a stream's
// no-commit / no-code posture is the role/profile's job (#219/#289) — so this
// module reads only `push` + `gate`. Pure; unit-tested.

import type { AgentFlow } from "./agentFlow";
import { resolveFlow } from "./agentFlow";

export interface FlowPermissionRules {
  /** Tool rules forcing a prompt before the command (Claude Code `ask` tier). */
  askToolRules: string[];
  /** Tool rules hard-blocking the command (Claude Code `deny` tier). */
  denyToolRules: string[];
}

/**
 * The GitHub-propagation writes the flow gates. `git push` covers branch pushes;
 * `gh pr create` covers opening PRs. Merging (`gh pr merge`) is the director's job
 * and is never granted to a worker flow here. The space boundary matches the
 * codebase's `Bash(<bin> *)` rule style.
 */
export const PUSH_WRITE_RULES = ["Bash(git push *)", "Bash(gh pr create *)"] as const;

/** Compute the ask/deny rules a stream's flow contributes at launch. */
export function flowPermissionRules(flow: AgentFlow | undefined): FlowPermissionRules {
  const f = resolveFlow(flow);
  const push = [...PUSH_WRITE_RULES];
  switch (f.push) {
    case "auto-pr":
      return { askToolRules: [], denyToolRules: [] };
    case "push-confirm":
      return f.gate === "hard"
        ? { askToolRules: push, denyToolRules: [] }
        : { askToolRules: [], denyToolRules: [] };
    case "commit-only":
    case "none":
      return { askToolRules: [], denyToolRules: push };
    default:
      return { askToolRules: [], denyToolRules: [] };
  }
}
