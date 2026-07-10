// The right inspector of the Algorithms knowledge graph (#2761) — the selected concept's identity,
// complexity, summary, tags, and its relationships grouped by kind (each a clickable jump to the
// neighbor). Empty state shows the relationship legend so the graph reads without a selection.
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Chip } from "@/shared/ui/data/Chip";
import {
  KIND_META, REL_META, relationsOf,
  type KnowledgeGraph, type KnowledgeNode, type KnowledgeRel,
} from "./lib/knowledge";

const REL_ORDER: KnowledgeRel[] = ["operates-on", "composes", "variant-of", "generates", "related-to"];

const PANEL = { width: "100%", height: "100%", borderLeft: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" } as const;

export function AlgorithmsInspector({ graph, selected, onSelectNode }: {
  graph: KnowledgeGraph;
  selected: KnowledgeNode | null;
  onSelectNode: (id: string) => void;
}) {
  if (!selected) {
    return (
      <Box style={PANEL}>
        <Stack gap={12} style={{ padding: 16 }}>
          <Eyebrow size={10}>Legend</Eyebrow>
          <Text size={12} tone="muted">Select a concept to see what it operates on, composes, and generates. Relationships:</Text>
          <Stack gap={6}>
            {REL_ORDER.map((rel) => (
              <Row key={rel} gap={8} align="center">
                <Box style={{ width: 22, height: 0, borderTop: `2px ${REL_META[rel].dashed ? "dashed" : "solid"} var(--fg-dim)` }} />
                <Text size={11.5}>{REL_META[rel].label}</Text>
              </Row>
            ))}
          </Stack>
          <Eyebrow size={10}>Kinds</Eyebrow>
          <Stack gap={6}>
            {(Object.keys(KIND_META) as (keyof typeof KIND_META)[]).map((k) => (
              <Row key={k} gap={8} align="center">
                <Box style={{ width: 10, height: 10, borderRadius: 3, background: KIND_META[k].color }} />
                <Text size={11.5}>{KIND_META[k].label}</Text>
              </Row>
            ))}
          </Stack>
        </Stack>
      </Box>
    );
  }

  const relations = relationsOf(graph, selected.id);
  return (
    <Box style={PANEL}>
      <Stack gap={12} style={{ padding: 16 }}>
        <Row gap={8} align="center" style={{ minWidth: 0 }}>
          <Box style={{ width: 11, height: 11, borderRadius: 3, background: KIND_META[selected.kind].color, flex: "none" }} />
          <Text weight={600} size={15} style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selected.name}</Text>
        </Row>
        <Row gap={6} align="center" style={{ flexWrap: "wrap" }}>
          <Chip>{KIND_META[selected.kind].label}</Chip>
          {selected.complexity && <Chip color="var(--accent)">{selected.complexity}</Chip>}
        </Row>
        <Text size={12.5} tone="muted">{selected.summary}</Text>
        {selected.tags?.length ? (
          <Row gap={6} align="center" style={{ flexWrap: "wrap" }}>
            {selected.tags.map((t) => <Chip key={t}>{t}</Chip>)}
          </Row>
        ) : null}

        {relations.length > 0 && (
          <Stack gap={10}>
            <Eyebrow size={10}>Relationships · {relations.length}</Eyebrow>
            {REL_ORDER.map((rel) => {
              const rows = relations.filter((r) => r.edge.rel === rel);
              if (!rows.length) return null;
              return (
                <Stack key={rel} gap={4}>
                  <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>{REL_META[rel].label}</Text>
                  {rows.map((r) => (
                    <Box as="button" key={`${r.dir}-${r.other.id}`} className="algo-relrow" onClick={() => onSelectNode(r.other.id)}>
                      <Text as="span" tone="dim" size={11}>{r.dir === "out" ? "→" : "←"}</Text>
                      <Box style={{ width: 8, height: 8, borderRadius: 2, background: KIND_META[r.other.kind].color, flex: "none" }} />
                      <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.other.name}</Text>
                    </Box>
                  ))}
                </Stack>
              );
            })}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
