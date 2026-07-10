// The Algorithms page left rail (#2773) — the shared GraphRail scaffold (matching the graph-page-shell
// convention #2765/#2767, the sibling of the GraphCanvas shell) filled with the concepts grouped by
// kind. Clicking a row selects + centers the node, so the rail reads like Glance/Designs/Teams. Pure
// presentational — selection state lives in the Workspace and is threaded through props.
import { GraphRail } from "@/shared/ui/layouts/GraphRail";
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";
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
              <Text mono size="xxs" tone="dim" style={{ padding: "0 6px", letterSpacing: ".06em", textTransform: "uppercase" }}>{KIND_META[kind].label}</Text>
              {rows.map((n) => (
                <Box as="button" key={n.id} className={`algo-railrow${n.id === selected ? " on" : ""}`} onClick={() => onSelect(n.id)}>
                  <Box style={{ width: 8, height: 8, borderRadius: 2, background: KIND_META[kind].color, flex: "none" }} />
                  <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" }}>{n.name}</Text>
                </Box>
              ))}
            </Stack>
          );
        })}
      </Stack>
    </GraphRail>
  );
}
