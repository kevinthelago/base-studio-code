// Refactor fleet wiring (#626 slice d2) — turn refactor units into a FleetPlan the
// existing fleetStartProject launches (one worker per unit, in its own worktree on a
// branch named after the unit, with a removal kickoff + a tier-based flow). Reuses the
// whole execution engine; the only new bits are this mapping + the kickoff text.
//
// Pure mapping (refactorUnitsToFleet / buildRemovalKickoff) is testable; startCleanupFleet
// writes the kickoffs and hands the plan to the store's fleet launch.

import { useAppStore } from "../../store";
import { writeProjectFile } from "../../lib/projectFiles";
import { type AgentFlow } from "./agentFlow";
import { type FleetPlan, type AgentStream } from "./planSections";
import { type RefactorUnit, type RefactorTier, generateRefactorUnits } from "../../lib/refactorUnits";
import { type VerifiedFinding } from "../../lib/deadcodeVerify";

/** Flow per risk tier: safe removals open their own PR continuously; risky ones pause at
 *  each PR for human review (the push command isn't auto-approved — a hard gate). */
export function flowForTier(tier: RefactorTier): AgentFlow {
  return tier === "safe"
    ? { autonomy: "continuous", push: "auto-pr", trigger: "per-issue", gate: "hard" }
    : { autonomy: "checkpoint", push: "push-confirm", trigger: "per-issue", gate: "hard" };
}

/** Sanitize a unit id into a branch/stream-safe id. */
const streamId = (unitId: string): string => "cleanup-" + unitId.replace(/[^A-Za-z0-9-]/g, "_");

/** The kickoff a cleanup worker runs — remove exactly the confirmed items, re-verify, keep green. */
export function buildRemovalKickoff(unit: RefactorUnit, repo: string): string {
  const items = unit.findings
    .map((f) => `- [${f.kind}] ${f.symbol ? `\`${f.symbol}\` in ` : ""}${f.path}${f.reason ? ` — ${f.reason}` : ""}`)
    .join("\n");
  return `# Cleanup: ${unit.title}

Repo: ${repo} · risk: **${unit.tier}** · owns: ${unit.owns.join(", ")}

Remove exactly these confirmed-dead items from the files you own — nothing else:

${items}

## Rules
- These are static-analysis findings. If you discover one is actually referenced
  (dynamic import, reflection, re-export, public API, used only in tests/config),
  **do not remove it** — note it and skip it.
- Keep the test suite green. If removing something breaks a test, fix or skip it.
- After removing, run the dead-code scan again; the items above must no longer appear.
- The project must still build / typecheck.

## Done when
${unit.acceptance}

Then commit on this branch${unit.tier === "safe" ? " and open a PR." : " and pause for review before pushing."}`;
}

/** Map refactor units → a FleetPlan (one stream per unit, disjoint owns → parallel-safe).
 *  Each stream's `prompt` points at the kickoff file startCleanupFleet writes. */
export function refactorUnitsToFleet(units: RefactorUnit[], repo: string): FleetPlan {
  const streams: AgentStream[] = units.map((u) => {
    const id = streamId(u.id);
    return {
      id,
      name: u.title,
      repo,
      owns: u.owns,
      issues: [],
      dependsOn: [],
      prompt: `prompts/${id}-kickoff.md`,
      flow: flowForTier(u.tier),
    };
  });
  return {
    recommended: streams.length,
    reasoning: `One worker per refactor unit (${streams.length}); each owns disjoint files so removals run in parallel without conflict.`,
    streams,
    director: { enabled: streams.length > 1, drive: "event" },
  };
}

export interface StartCleanupFleetArgs {
  projectName: string;
  projectKey: string;
  repo: string;
  /** Verified findings (only `confirmed` become units), or pre-built units. */
  verified?: VerifiedFinding[];
  units?: RefactorUnit[];
}

/** Build the cleanup fleet from confirmed findings, write each worker's kickoff, and
 *  launch it via the store's fleet runner. Returns the units (empty ⇒ nothing to do). */
export async function startCleanupFleet(args: StartCleanupFleetArgs): Promise<RefactorUnit[]> {
  const units = args.units ?? generateRefactorUnits(args.verified ?? []);
  if (units.length === 0) return [];
  const fleet = refactorUnitsToFleet(units, args.repo);
  await Promise.all(
    units.map((u, i) => writeProjectFile(args.projectKey, fleet.streams[i].prompt!, buildRemovalKickoff(u, args.repo))),
  );
  useAppStore.getState().fleetStartProject(args.projectName, fleet, args.projectKey);
  return units;
}
