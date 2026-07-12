// The right inspector of the Algorithms knowledge graph (#2761/#2958) — the focused implementation's
// identity, role, code, and what it builds on / is used by. A concept IS its implementation, so the
// inspector is impl-only (the abstract concept-node view was removed with #2961). Empty state prompts a
// selection; each builds-on / used-by row jumps to that impl.
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Chip } from "@/shared/ui/data/Chip";
import { TECH_META, implById, usedByImpl, type KnowledgeGraph, type AlgoImpl } from "./lib/knowledge";

const PANEL = { width: "100%", height: "100%", borderLeft: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" } as const;

export function AlgorithmsInspector({ graph, focusedImpl, onSelectImpl }: {
  graph: KnowledgeGraph;
  /** The focused implementation (#2863) — a node in the per-kit graph, or a free-standing primitive from
   *  the rail. Its code + builds-on / used-by. */
  focusedImpl?: AlgoImpl | null;
  /** Jump to another implementation (#2863) — the per-kit graph navigates impl→impl (builds-on / used-by). */
  onSelectImpl?: (id: string) => void;
}) {
  if (!focusedImpl) {
    return (
      <Box style={PANEL}>
        <Stack gap={12} style={{ padding: 16 }}>
          <Eyebrow size={10}>Implementation</Eyebrow>
          <Text size={12} tone="muted">
            Select an implementation — from the rail or the graph — to see its code and what it builds on
            and is used by. The edge types are keyed in the graph legend.
          </Text>
        </Stack>
      </Box>
    );
  }

  // A concept IS its implementation (#2958), so this is the whole inspector: the impl's code + the impls
  // it builds on (composes, down to the primitive base) and the ones that build on it (the reverse).
  const isPrim = focusedImpl.role === "primitive";
  const buildsOn = focusedImpl.composes.map((id) => implById(graph, id)).filter((im): im is AlgoImpl => !!im);
  const usedBy = usedByImpl(graph, focusedImpl.id);
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
      </Stack>
    </Box>
  );
}

/** A labeled list of implementation links (Builds on / Used by) in the per-kit graph (#2863) — each row
 *  jumps to that impl. Renders nothing when the list is empty. */
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
