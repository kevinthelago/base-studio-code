// The unified "Streams" stage (#1392 / #1914; carded #…) — ONE cohesive pane for the fleet: the
// dependency-graph OVERVIEW on top (the streams map), then the fleet configuration as a stack of
// collapsible cards — Coordination (fleet-wide topology + director drive), the Fleet roster (one
// collapsible card per stream: model / flow / role / owns), and Shared dependencies. A single shared
// `focus` links them: spotlight a stream in the graph and its roster card opens (and vice-versa).
// (Replaced the earlier graph + always-open permissions-section + shared-deps-section stack.)
import { useState } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { type RelFocus, type Topology } from "@/features/planner/relationship/relationshipGraph";
import { AgentsA } from "@/features/planner/pane/agentEditor";
import { PlanBody } from "./FocusedPlanBody";
import { CoordinationControls } from "./FocusedPermissionsBody";
import { SharedDependenciesSection } from "./SharedDependencies";
import { CollapsibleCard } from "./collapsibleCard";
import type { FleetHandlers } from "./focusedHandlers";

export function StreamsBody({ data, fleet, ...handlers }: FleetHandlers & {
  data?: ProjectPaneData;
  fleet?: boolean;
}) {
  const [focus, setFocus] = useState<RelFocus>(null);
  const focusedStream = focus?.type === "agent" ? focus.id : undefined;
  const agents = data?.agents ?? [];
  const topology = (data?.topology ?? "hybrid") as Topology;
  return (
    <>
      {/* The streams map — always visible; spotlighting a node opens its fleet card below. */}
      <PlanBody data={data} focus={focus} onFocus={setFocus} />

      {fleet && (agents.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 18 }}>
          <span className="empty-icon">◎</span>
          <span>No fleet yet — plan the work streams first</span>
        </div>
      ) : (
        <div style={{ marginTop: 18, display: "flex", flexDirection: "column", gap: 10 }}>
          {/* Coordination — fleet-wide topology + director drive. */}
          <CollapsibleCard title="Coordination" icon="◎" hint={topology}>
            <CoordinationControls data={data} onTopology={handlers.onTopology} onDirectorDrive={handlers.onDirectorDrive} />
          </CollapsibleCard>

          {/* Fleet roster — one collapsible row per stream (model / flow / role / owns), linked to the
              graph focus so selecting a node opens its stream and opening a stream spotlights its node. */}
          <CollapsibleCard title="Fleet" icon="⊞" hint={`${agents.length} stream${agents.length === 1 ? "" : "s"}`} defaultOpen>
            <AgentsA
              agents={agents}
              onFlow={handlers.onFlow}
              onModel={handlers.onModel}
              focusedStream={focusedStream}
              onSelect={(id) => setFocus(id ? { type: "agent", id } : null)}
            />
          </CollapsibleCard>

          {/* Shared dependencies (#1429) — per-repo → per-stream lock for repos 2+ streams build. */}
          <CollapsibleCard title="Shared dependencies" icon="⇄" hint="repos 2+ streams build">
            <SharedDependenciesSection agents={data?.agents} dependencies={data?.dependencies} registries={data?.registries} />
          </CollapsibleCard>
        </div>
      ))}
    </>
  );
}
