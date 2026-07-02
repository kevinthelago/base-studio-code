// projectPaneRelationships -- derives the cross-stream relationship graph for the
// ProjectPane: the streams to render (authored fleet, else feature-derived) and the
// blocking edges aggregated from the issue dependency tree. Extracted from
// projectPaneData (#2151); pure, no logic changes.

import type { AgentStream } from "../fleet/planFleet";
import type { AgentRelationship } from "../relationship/relationshipGraph";
import type { PlanIssue } from "../issues/planIssues";
import type { BuildProjectPaneInput } from "./projectPaneInput";

/**
 * The streams to render the relationship graph from: the authored fleet when it exists, otherwise
 * derived straight from the features (#plan-db). A feature IS a stream — slug = id, `dependsOn` =
 * the edges — so the stream graph shows in the Structure pane as soon as features are defined,
 * instead of staying blank until the Permissions stage authors `fleet.json`.
 */
export function effectiveStreams(input: BuildProjectPaneInput): AgentStream[] {
  if (input.fleet?.streams?.length) return input.fleet.streams;
  return (input.features ?? []).map((f) => ({
    id: f.slug,
    name: f.name || f.slug,
    repo: input.repos[0] ?? "",
    owns: [],
    issues: [],
    dependsOn: f.dependsOn ?? [],
  }));
}

/**
 * Derive cross-stream blocking edges. A dependency between two ISSUES owned by different
 * streams (issue I in stream A `dependsOn` issue J in stream B) becomes a stream edge B→A.
 * This captures the full dependency structure the seam graph shows, aggregated to streams —
 * so the swimlane layers (its "phases") match. Explicit stream-level `dependsOn` is merged in.
 */
export function deriveRelationships(streams: AgentStream[], issues: PlanIssue[]): AgentRelationship[] {
  const streamIds = new Set(streams.map((s) => s.id));
  const norm = (r: string) => String(r).replace(/^#/, "").trim();
  // issue ref → owning stream id (the stream's declared issue list, then PlanIssue.stream).
  const ownerOf = new Map<string, string>();
  for (const s of streams) for (const ref of s.issues ?? []) ownerOf.set(norm(ref), s.id);
  for (const i of issues) if (i.stream && streamIds.has(i.stream)) ownerOf.set(norm(i.ref), i.stream);

  const seen = new Set<string>();
  const out: AgentRelationship[] = [];
  const add = (from: string | undefined, to: string) => {
    if (!from || !streamIds.has(from) || !streamIds.has(to) || from === to) return;
    const key = `${from}>${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: key, from, to, kind: "blocking", hardness: "blocking", via: "direct" });
  };
  // cross-stream edges from the issue dependency tree
  for (const i of issues) {
    const to = ownerOf.get(norm(i.ref));
    if (!to) continue;
    for (const dep of i.dependsOn ?? []) add(ownerOf.get(norm(dep)), to);
  }
  // plus any explicit stream-level dependsOn
  for (const s of streams) for (const dep of s.dependsOn ?? []) add(norm(dep), s.id);
  return out;
}
