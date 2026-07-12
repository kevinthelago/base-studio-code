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
  implsForConcept, implFor, implById, usedByImpl, pairsOf,
  type KnowledgeGraph, type KnowledgeNode, type KnowledgeRel, type Tech, type AlgoImpl,
} from "./lib/knowledge";

const REL_ORDER: KnowledgeRel[] = ["operates-on", "composes", "variant-of", "generates", "related-to"];

const PANEL = { width: "100%", height: "100%", borderLeft: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" } as const;

export function AlgorithmsInspector({ graph, selected, focusedImpl, activeTech, onSelectNode, onSelectImpl }: {
  graph: KnowledgeGraph;
  selected: KnowledgeNode | null;
  /** The focused implementation (#2863) — a node in the per-kit graph, or a free-standing primitive from
   *  the rail. Shown directly (code + builds-on/used-by/pairs). Takes precedence over `selected`. */
  focusedImpl?: AlgoImpl | null;
  /** The implementation tech (#2770) whose code + composition the impl section shows. */
  activeTech: Tech;
  onSelectNode: (id: string) => void;
  /** Jump to another implementation (#2863) — the per-kit graph navigates impl→impl (builds-on / used-by
   *  / pairs), not through concept nodes. */
  onSelectImpl?: (id: string) => void;
}) {
  // A focused implementation (#2863) — a per-kit graph node (or a rail primitive): its code + the impls it
  // builds on, is used by, and pairs with. A concept IS its implementation, so this is the primary view.
  if (focusedImpl) {
    const isPrim = focusedImpl.role === "primitive";
    const buildsOn = focusedImpl.composes.map((id) => implById(graph, id)).filter((im): im is AlgoImpl => !!im);
    const usedBy = usedByImpl(graph, focusedImpl.id);
    const paired = pairsOf(graph, focusedImpl);
    const ell = { minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
    const jump = (im: AlgoImpl) => onSelectImpl?.(im.id);
    return (
      <Box style={PANEL}>
        <Stack gap={12} style={{ padding: 16 }}>
          <Row gap={8} align="center" style={{ minWidth: 0 }}>
            <Box style={{ width: 10, height: 10, borderRadius: 3, background: isPrim ? "var(--violet)" : "var(--accent)", flex: "none" }} />
            <Text weight={600} size={15} style={ell}>{focusedImpl.name}</Text>
            <Chip>{focusedImpl.role}</Chip>
          </Row>
          <Eyebrow size={10}>{isPrim ? "Building block" : "Implementation"} · {TECH_META[focusedImpl.tech]?.label ?? focusedImpl.tech}</Eyebrow>
          {focusedImpl.summary && <Text size={12} tone="muted">{focusedImpl.summary}</Text>}
          <Box as="pre" className="algo-code mono">{focusedImpl.code}</Box>
          <ImplLinks label="Builds on" glyph="↳" impls={buildsOn} onJump={jump} />
          <ImplLinks label="Used by" glyph="↰" impls={usedBy} onJump={jump} />
          <ImplLinks label="Pairs with" glyph="⇄" impls={paired} onJump={jump} />
        </Stack>
      </Box>
    );
  }
  if (!selected) {
    return (
      <Box style={PANEL}>
        <Stack gap={12} style={{ padding: 16 }}>
          <Eyebrow size={10}>Implementation</Eyebrow>
          <Text size={12} tone="muted">
            Select an implementation — from the rail or the graph — to see its code and what it builds on, is
            used by, and pairs with. The edge types are keyed in the graph legend.
          </Text>
        </Stack>
      </Box>
    );
  }

  const relations = relationsOf(graph, selected.id);
  const allImpls = implsForConcept(graph, selected.id);
  const impl = implFor(graph, selected.id, activeTech);
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

/** A labeled list of implementation links (Builds on / Used by / Pairs with) in the per-kit graph (#2863)
 *  — each row jumps to that impl. Renders nothing when the list is empty. */
function ImplLinks({ label, glyph, impls, onJump }: {
  label: string;
  glyph: string;
  impls: AlgoImpl[];
  onJump: (im: AlgoImpl) => void;
}) {
  if (!impls.length) return null;
  const ell = { flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
  return (
    <Stack gap={4}>
      <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase" }}>{label}</Text>
      {impls.map((im) => (
        <Box as="button" key={im.id} className="algo-relrow" onClick={() => onJump(im)}>
          <Text as="span" tone="dim" size={11}>{glyph}</Text>
          <Text as="span" size={12} style={ell}>{im.name}</Text>
          <Text as="span" mono size="xxs" tone="dim">{im.id}</Text>
        </Box>
      ))}
    </Stack>
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
