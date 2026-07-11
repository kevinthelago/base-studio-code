// The right inspector of the Algorithms knowledge graph (#2761) — the selected concept's identity,
// complexity, summary, tags, and its relationships grouped by kind (each a clickable jump to the
// neighbor). Empty state shows the relationship legend so the graph reads without a selection.
// When the concept carries a per-tech implementation (#2770), the active tech's code + its
// "builds on" (composes) and "used by" (reverse) impls render below the relationships.
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Chip } from "@/shared/ui/data/Chip";
import {
  KIND_META, REL_META, TECH_META, relationsOf, nodeIndex,
  implsForConcept, implFor, implById, usedByImpl,
  type KnowledgeGraph, type KnowledgeNode, type KnowledgeRel, type Tech, type AlgoImpl,
} from "./lib/knowledge";
import type { ExtractSite, CallEdge } from "./lib/extraction";
import type { ConceptDiff } from "./lib/compositionDiff";

const REL_ORDER: KnowledgeRel[] = ["operates-on", "composes", "variant-of", "generates", "related-to"];

const PANEL = { width: "100%", height: "100%", borderLeft: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" } as const;

export function AlgorithmsInspector({ graph, selected, activeTech, sites, calls, diff, onSelectNode }: {
  graph: KnowledgeGraph;
  selected: KnowledgeNode | null;
  /** The implementation tech (#2770) whose code + composition the impl section shows. */
  activeTech: Tech;
  /** The REAL implementation sites `bsc graph extract` found for the selected concept (#2777) — listed
   *  below the relationships when non-empty; nothing when absent (no scan run, or none found). */
  sites?: ExtractSite[];
  /** The extracted OUTBOUND call edges of the selected concept (#2779) — the concepts its real-code
   *  implementation invokes; listed as a "Calls (from code)" section when non-empty. */
  calls?: CallEdge[];
  /** The selected concept's intent-vs-reality composition diff (#2781) — present only when a scan has
   *  run AND the concept carries an implementation; drives the "Composition check" section. */
  diff?: ConceptDiff;
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
  const allImpls = implsForConcept(graph, selected.id);
  const impl = implFor(graph, selected.id, activeTech);
  const byId = nodeIndex(graph.nodes);
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

        {calls && calls.length > 0 && (
          <Stack gap={6}>
            <Eyebrow size={10}>Calls (from code) · {calls.length}</Eyebrow>
            <Stack gap={4}>
              {calls.map((c, i) => {
                const target = byId.get(c.to);
                return (
                  <Box as="button" key={`${c.to}:${c.tech}:${i}`} className="algo-relrow" onClick={() => onSelectNode(c.to)}>
                    <Text as="span" tone="accent" size={11}>{"→"}</Text>
                    <Box style={{ width: 8, height: 8, borderRadius: 2, background: target ? KIND_META[target.kind].color : "var(--accent)", flex: "none" }} />
                    <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{target?.name ?? c.to}</Text>
                    <Text as="span" mono size="xxs" tone="accent">{c.tech}</Text>
                  </Box>
                );
              })}
            </Stack>
          </Stack>
        )}

        {diff && (
          <Stack gap={6}>
            <Eyebrow size={10}>Composition check</Eyebrow>
            {diff.matched.length === 0 && diff.missing.length === 0 && diff.extra.length === 0 ? (
              <Text size={12} tone="dim">Matches its declared composition.</Text>
            ) : (
              <Stack gap={4}>
                {diff.matched.map((id) => (
                  <Box as="button" key={`ck-match-${id}`} className="algo-relrow" onClick={() => onSelectNode(id)} title="Declared + found in code">
                    <Text as="span" tone="success" size={11}>{"✓"}</Text>
                    <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{byId.get(id)?.name ?? id}</Text>
                  </Box>
                ))}
                {diff.missing.map((id) => (
                  <Box as="button" key={`ck-miss-${id}`} className="algo-relrow" onClick={() => onSelectNode(id)} title="Declared, not observed in code — abstract concepts aren't literally called">
                    <Text as="span" tone="muted" size={11}>{"⚠"}</Text>
                    <Text as="span" tone="muted" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{byId.get(id)?.name ?? id}</Text>
                  </Box>
                ))}
                {diff.extra.map((id) => (
                  <Box as="button" key={`ck-extra-${id}`} className="algo-relrow" onClick={() => onSelectNode(id)} title="Found in code, not declared">
                    <Text as="span" tone="accent" size={11}>{"+"}</Text>
                    <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{byId.get(id)?.name ?? id}</Text>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        )}

        {sites && sites.length > 0 && (
          <Stack gap={6}>
            <Eyebrow size={10}>Implementations found · {sites.length}</Eyebrow>
            <Stack gap={4}>
              {sites.map((s, i) => (
                <Row key={`${s.file}:${s.line}:${i}`} gap={6} align="center" style={{ minWidth: 0 }}>
                  <Text as="span" mono size="xxs" tone="accent" style={{ flex: "none" }}>{s.tech}</Text>
                  <Text as="span" mono size="xxs" tone="dim" title={`${s.file}:${s.line}`}
                    style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {s.file}:{s.line}
                  </Text>
                </Row>
              ))}
            </Stack>
          </Stack>
        )}

        {allImpls.length > 0 && (
          <Stack gap={10}>
            <Eyebrow size={10}>Implementation · {TECH_META[activeTech].label}</Eyebrow>
            {impl
              ? <ImplSection graph={graph} impl={impl} onSelectNode={onSelectNode} />
              : <Text size={12} tone="dim">No {TECH_META[activeTech].label} implementation yet.</Text>}
          </Stack>
        )}
      </Stack>
    </Box>
  );
}

/** The active-tech implementation: name, code, "Builds on" (composes), and "Used by" (reverse). */
function ImplSection({ graph, impl, onSelectNode }: {
  graph: KnowledgeGraph;
  impl: AlgoImpl;
  onSelectNode: (id: string) => void;
}) {
  const byId = nodeIndex(graph.nodes);
  const buildsOn = impl.composes
    .map((id) => implById(graph, id))
    .filter((im): im is AlgoImpl => !!im);
  const usedBy = usedByImpl(graph, impl.id);
  // A free-standing primitive (#2863) has no concept — fall back to its own name.
  const conceptName = (im: AlgoImpl) => (im.concept ? byId.get(im.concept)?.name : undefined) ?? im.name;
  return (
    <Stack gap={8}>
      <Row gap={6} align="center" style={{ minWidth: 0 }}>
        <Text mono size="xxs" tone="accent">{"</>"}</Text>
        <Text weight={600} size={12.5} style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{impl.name}</Text>
      </Row>
      {impl.summary && <Text size={12} tone="muted">{impl.summary}</Text>}
      <Box as="pre" className="algo-code mono">{impl.code}</Box>

      {buildsOn.length > 0 && (
        <Stack gap={4}>
          <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Builds on</Text>
          {buildsOn.map((sub) => (
            <Box as="button" key={sub.id} className="algo-relrow" onClick={() => { if (sub.concept) onSelectNode(sub.concept); }}>
              <Text as="span" tone="dim" size={11}>{"↳"}</Text>
              <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conceptName(sub)}</Text>
              <Text as="span" mono size="xxs" tone="dim">{sub.id}</Text>
            </Box>
          ))}
        </Stack>
      )}

      {usedBy.length > 0 && (
        <Stack gap={4}>
          <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>Used by</Text>
          {usedBy.map((up) => (
            <Box as="button" key={up.id} className="algo-relrow" onClick={() => { if (up.concept) onSelectNode(up.concept); }}>
              <Text as="span" tone="dim" size={11}>{"↰"}</Text>
              <Text as="span" size={12} style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{conceptName(up)}</Text>
              <Text as="span" mono size="xxs" tone="dim">{up.id}</Text>
            </Box>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
