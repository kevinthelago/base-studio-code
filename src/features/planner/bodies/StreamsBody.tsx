// The unified "Streams" stage (#1392 / #1914 / #2053) — ONE cohesive pane built AROUND the
// dependency graph. The graph IS the fleet: every node is a stream, and because a stream and its
// worker are 1:1, selecting a node opens exactly ONE inspector card below it (identity · scope ·
// kickoff · config) — no separate roster stacked under the graph duplicating the same streams.
// Fleet-wide controls (Coordination, Shared dependencies) sit below as secondary collapsible cards.
// (Replaced the graph + always-open Fleet-roster + Coordination-card stack, which listed each stream
// twice.)
import { useState } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { type RelFocus, type Topology } from "@/features/planner/relationship/relationshipGraph";
import { StreamCard } from "@/features/planner/pane/agentEditor";
import { PlanBody } from "./FocusedPlanBody";
import { CoordinationControls } from "./FocusedPermissionsBody";
import { SharedDependenciesSection } from "./SharedDependencies";
import { CollapsibleCard } from "./collapsibleCard";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
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
        <Box className="empty-state" style={{ marginTop: 18 }}>
          <Box as="span" className="empty-icon">◎</Box>
          <Box as="span">No fleet yet — plan the work streams first</Box>
        </Box>
      ) : focusedAgent ? (
        // One card for the focused stream (1:1 with its worker) — identity · scope · kickoff · config.
        <StreamCard a={focusedAgent} agents={agents} onFlow={handlers.onFlow} onModel={handlers.onModel} onPersona={handlers.onPersona} />
      ) : (
        <Text as="div" mono size={10} tone="dim" style={{ marginTop: 14, textAlign: "center", padding: "14px 0" }}>
          Select a stream in the graph to see its scope, kickoff &amp; config.
        </Text>
      ))}

      {fleet && agents.length > 0 && (
        <Stack gap={10} style={{ marginTop: 14 }}>
          {/* Fleet-wide controls — secondary to the graph, collapsible. */}
          <CollapsibleCard title="Coordination" icon="◎" hint={topology}>
            <CoordinationControls data={data} onTopology={handlers.onTopology} onDirectorDrive={handlers.onDirectorDrive} />
          </CollapsibleCard>
          <CollapsibleCard title="Shared dependencies" icon="⇄" hint="repos 2+ streams build">
            <SharedDependenciesSection agents={data?.agents} dependencies={data?.dependencies} registries={data?.registries} />
          </CollapsibleCard>
        </Stack>
      )}
    </>
  );
}
