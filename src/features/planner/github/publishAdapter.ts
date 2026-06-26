// Publish adapter (#226) — turn a confirmed plan into the ordered list of GitHub
// operations that realize it, choosing each operation's PHYSICAL representation via
// the capability mapping (#203) and the execution strategy (#204). This is the pure
// core: it computes WHAT to create (a `PublishOp[]`); a separate side-effecting
// executor runs the `gh` calls (follow-on).
//
// The ops are ordered so each is creatable when its turn comes (project → phases →
// labels → epics → dependencies). Free of React / xterm / Tauri imports.

import { mapConcept, type CapabilityProfile } from "./capabilityMapping";
import type { ExecutionStrategy } from "../fleet/executionTopology";

export interface PublishInput {
  projectTitle: string;
  /** Phase/milestone names, in order. */
  phases: string[];
  /** Fleet stream ids → `stream:<id>` labels. */
  streams: string[];
  /** Epics and the titles of the issues beneath them. */
  epics: { title: string; childTitles: string[] }[];
  /** Dependency edges between issue refs/titles. */
  dependencies: { from: string; to: string }[];
  profile: CapabilityProfile;
  strategy: ExecutionStrategy;
}

export type PublishOp =
  | { op: "project"; title: string }
  | { op: "milestone"; title: string }
  | { op: "iteration"; title: string }
  | { op: "label"; name: string }
  | { op: "epic"; title: string; childTitles: string[]; representation: string }
  | { op: "dependency"; from: string; to: string; representation: string };

/**
 * Compute the ordered publish operations for a plan. Representations degrade per the
 * connected account's capabilities:
 *
 * - **phases** → `iteration` only when the strategy's milestone axis is `iteration`
 *   AND Projects exist; otherwise `milestone`.
 * - **epics** → the highest supported epic rung (`mapConcept("epic", profile)`); the
 *   `parent+sub-issues+label` rung additionally needs an `epic` label, which is
 *   emitted before the epic ops.
 * - **dependencies** → the highest supported dependency rung.
 */
export function buildPublishPlan(input: PublishInput): PublishOp[] {
  const ops: PublishOp[] = [];
  const epicRep = mapConcept("epic", input.profile).id;
  const depRep = mapConcept("dependency", input.profile).id;

  ops.push({ op: "project", title: input.projectTitle });

  const usesIterations = input.strategy.milestoneAxis === "iteration" && input.profile.projects;
  for (const phase of input.phases) {
    ops.push(usesIterations ? { op: "iteration", title: phase } : { op: "milestone", title: phase });
  }

  // Labels: one per stream, plus an `epic` label when the epic rung needs it.
  const labels = input.streams.map((s) => `stream:${s}`);
  if (epicRep === "parent+sub-issues+label") labels.push("epic");
  for (const name of labels) ops.push({ op: "label", name });

  for (const epic of input.epics) {
    ops.push({ op: "epic", title: epic.title, childTitles: epic.childTitles, representation: epicRep });
  }

  for (const dep of input.dependencies) {
    ops.push({ op: "dependency", from: dep.from, to: dep.to, representation: depRep });
  }

  return ops;
}

/** Count the ops by kind — a compact preview of what a publish would do. */
export function summarizePlan(ops: PublishOp[]): Record<PublishOp["op"], number> {
  const out: Record<PublishOp["op"], number> = {
    project: 0,
    milestone: 0,
    iteration: 0,
    label: 0,
    epic: 0,
    dependency: 0,
  };
  for (const op of ops) out[op.op] += 1;
  return out;
}
