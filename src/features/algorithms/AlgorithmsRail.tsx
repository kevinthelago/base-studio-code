// The Algorithms page left rail (#2773) — the shared GraphRail scaffold (matching the graph-page-shell
// convention #2765/#2767, the sibling of the GraphCanvas shell) filled with the concepts grouped by
// kind, rendered through the shared RailRow / RailGroupHeader nav primitives (#2789). Clicking a row
// selects + centers the node, so the rail reads like Glance/Designs/Teams. Pure presentational —
// selection state lives in the Workspace and is threaded through props.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { RailRow } from "@/shared/ui/layouts/RailRow";
import { RailGroupHeader } from "@/shared/ui/layouts/RailGroupHeader";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { KIND_ORDER, KIND_META, type KnowledgeGraph } from "./lib/knowledge";

export function AlgorithmsRail({ graph, selected, onSelect }: {
  graph: KnowledgeGraph;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <GraphRail label="Nodes" count={graph.nodes.length}>
      <Stack gap={10}>
        {KIND_ORDER.map((kind) => {
          const rows = graph.nodes.filter((n) => n.kind === kind);
          if (!rows.length) return null;
          return (
            <Stack key={kind} gap={2}>
              <RailGroupHeader>{KIND_META[kind].label}</RailGroupHeader>
              {rows.map((n) => (
                <RailRow
                  key={n.id}
                  active={n.id === selected}
                  onClick={() => onSelect(n.id)}
                  leading={<Box style={{ width: 8, height: 8, borderRadius: 2, background: KIND_META[kind].color }} />}
                >
                  {n.name}
                </RailRow>
              ))}
            </Stack>
          );
        })}
      </Stack>
    </GraphRail>
  );
}
