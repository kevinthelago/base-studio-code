// Build a fleet worker's scoped context markdown (#844) — the focused lane a worker
// loads as its `CLAUDE.local.md`, INSTEAD of the full planning spec. Workers used to
// inherit the hub's ~52KB planner `CLAUDE.md` (their worktrees sat under the hub, so
// Claude Code's cwd-and-ancestors `CLAUDE.md` walk picked it up); relocating worktrees
// out from under the hub removes that leak, and this gives each worker exactly the
// context it needs: the files and issues it owns, and the contracts it builds against. Pure +
// unit-tested; the Rust side (`write_worker_context`) writes it as the lead of the
// worktree's CLAUDE.local.md, ahead of the per-repo context, protocol, and skills.

import type { AgentStream } from "../stages/planSections";
import { buildWorkerDependencyBlock, type PlanDependency } from "../issues/dependencies";

/**
 * Render a stream's owned globs / issues / dependencies into the scope block that leads
 * a worker's `CLAUDE.local.md`. Kept deliberately small — the worker's job is to finish
 * its issues, not to hold the whole plan; cross-stream questions go to the director and
 * integration interfaces live in the contracts dir.
 *
 * `deps` is the LOCKED dependency manifest for this worker's repo (#1111): when present it's
 * appended as the planner-owned "Dependencies (locked)" block so the worker installs from a single
 * authority instead of adding its own (the source of parallel-worktree manifest collisions).
 *
 * Returns a heading + bullet list. Empty fields are rendered as an explicit "none"/"all
 * within your owned paths" so the worker isn't left guessing whether the field was
 * omitted or genuinely empty.
 */
export function buildWorkerScope(stream: AgentStream, deps: PlanDependency[] = []): string {
  const owns = stream.owns.length
    ? stream.owns.map((g) => `\`${g}\``).join(", ")
    : "(none assigned — confirm your lane with the director before writing)";
  const issues = stream.issues.length ? stream.issues.join(", ") : "(none yet — ask the director)";
  const streamDeps = stream.dependsOn.length ? stream.dependsOn.join(", ") : "none";

  const lines = [
    `# Your scope — ${stream.name}`,
    "",
    "You are one of several Claude sessions building this project in parallel, working in your",
    `own git worktree on branch \`${stream.id}\`. This file is your lane — not the full plan.`,
    "",
    `- **You own:** ${owns}. Do not modify files outside your owned paths — another stream owns`,
    "  them; coordinate through the director instead of reaching in.",
    `- **Your issues:** ${issues}.`,
    `- **You build against the contracts of:** ${streamDeps}. Implement to their planned interface IN`,
    "  PARALLEL — do NOT wait for those streams to land; integration is verified at merge.",
    "",
    "Integration interfaces between streams live in the contracts directory — treat them as the",
    "source of truth. Build to the contract now; if one is unclear or must change, ask the director",
    "(`bsc-ask`) rather than guessing or parking. For the high-level project context you don't have",
    "here, defer to the director.",
    "",
    "Issue lifecycle is the director's job, not yours. When you finish an owned issue, signal it",
    "the way your kickoff says (open your PR / `bsc-landed`) and let the director close it — do",
    "not run `gh issue close`/`reopen`/`edit` (you have GitHub read access only; the role gate",
    "blocks the write, so attempting it just wastes a turn).",
  ];

  const depBlock = buildWorkerDependencyBlock(deps);
  if (depBlock) lines.push("", depBlock);

  return lines.join("\n");
}
