// The merged "Streams" stage (#1392, split from FocusedBodies.tsx #1757) — the plan/relationship
// graph + (when the blueprint folded the fleet in) the coordination + per-stream permissions,
// sharing ONE focus: spotlight a stream in the graph and its permissions editor expands below (and
// clicking a permissions row spotlights it in the graph). Owns the shared `focus` so the two halves
// stay in sync.
import { useState } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import type { RelFocus } from "@/features/planner/relationship/relationshipGraph";
import { FocusedPlanBody } from "./FocusedPlanBody";
import { FocusedPermissionsBody } from "./FocusedPermissionsBody";
import { SharedDependenciesSection } from "./SharedDependencies";
import type { FleetHandlers } from "./focusedHandlers";

export function StreamsBody({ data, fleet, ...handlers }: FleetHandlers & {
  data?: ProjectPaneData;
  fleet?: boolean;
}) {
  const [focus, setFocus] = useState<RelFocus>(null);
  const focusedStream = focus?.type === "agent" ? focus.id : undefined;
  return (
    <>
      <FocusedPlanBody data={data} focus={focus} onFocus={setFocus} />
      {fleet && (
        <div style={{ marginTop: 18 }}>
          <FocusedPermissionsBody
            data={data} {...handlers}
            focusedStream={focusedStream}
            onSelectStream={(id) => setFocus(id ? { type: "agent", id } : null)}
          />
        </div>
      )}
      {/* Shared dependencies (#1429): per-repo → per-stream lock for repos 2+ streams build. */}
      {fleet && (
        <div style={{ marginTop: 18 }}>
          <SharedDependenciesSection agents={data?.agents} dependencies={data?.dependencies} registries={data?.registries} />
        </div>
      )}
    </>
  );
}
