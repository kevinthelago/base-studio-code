// The unified "Streams" stage (#1392 / #1914 / #2053 / #2189) — ONE cohesive pane built AROUND the
// dependency graph. The graph IS the fleet: every node is a stream, and because a stream and its
// worker are 1:1, selecting a node opens its inspector below — a stack of collapsible cards
// (Persona · Kickoff · Scope · Model & flow, #2189) rather than one dense card. Fleet-wide controls
// Coordination sits below as a secondary collapsible card; the focused stream's shared-dependency
// slice now lives inside its inspector (#2191). (Replaced the graph + always-open Fleet-roster +
// Coordination-card stack, which listed each stream twice.)
import { useState } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { type RelFocus, type Topology } from "@/features/planner/relationship/relationshipGraph";
import { StreamFocusCards } from "./StreamFocusCards";
import { PlanBody } from "./FocusedPlanBody";
import { CoordinationControls } from "./FocusedPermissionsBody";
import { CollapsibleCard } from "./collapsibleCard";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import type { FleetHandlers } from "./focusedHandlers";

export function StreamsBody({ data, fleet, ...handlers }: FleetHandlers & {
  data?: ProjectPaneData;
  fleet?: boolean;
}) {
  const [focus, setFocus] = useState<RelFocus>(null);
  const focusedStream = focus?.type === "agent" ? focus.id : undefined;
  const agents = data?.agents ?? [];
  const focusedAgent = agents.find((a) => a.id === focusedStream);
  const topology = (data?.topology ?? "hybrid") as Topology;
  return (
    <>
      {/* The dependency graph — the centerpiece, always first + visible. Selecting a node focuses its
          stream (spotlight ↔ card), which opens its inspector below. */}
      <PlanBody data={data} focus={focus} onFocus={setFocus} />

      {fleet && (agents.length === 0 ? (
        <EmptyState size="sm" icon="◎" iconVariant="dashed"
          title="No fleet yet — plan the work streams first"
          style={{ flex: "none", marginTop: 18 }} />
      ) : focusedAgent ? (
        // The focused stream (1:1 with its worker) as a collapsible-card stack — persona · kickoff ·
        // scope · shared deps · model & flow.
        <StreamFocusCards
          a={focusedAgent}
          agents={agents}
          dependencies={data?.dependencies}
          registries={data?.registries}
          onFlow={handlers.onFlow}
          onModel={handlers.onModel}
          onPersona={handlers.onPersona}
        />
      ) : (
        <Text as="div" mono size={10} tone="dim" style={{ marginTop: 14, textAlign: "center", padding: "14px 0" }}>
          Select a stream in the graph to see its persona, kickoff &amp; config.
        </Text>
      ))}

      {fleet && agents.length > 0 && (
        <Stack gap={10} style={{ marginTop: 14 }}>
          {/* Fleet-wide controls — secondary to the graph, collapsible. (Shared dependencies moved
              into the focused stream's inspector, #2191.) */}
          <CollapsibleCard title="Coordination" icon="◎" hint={topology}>
            <CoordinationControls data={data} onTopology={handlers.onTopology} onDirectorDrive={handlers.onDirectorDrive} />
          </CollapsibleCard>
        </Stack>
      )}
    </>
  );
}
