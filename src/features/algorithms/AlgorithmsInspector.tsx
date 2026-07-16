// The right inspector of the Algorithms knowledge graph (#2761/#2958) — the focused implementation's
// identity, role, code, and what it builds on / is used by. A concept IS its implementation, so the
// inspector is impl-only (the abstract concept-node view was removed with #2961). Empty state prompts a
// selection; each builds-on / used-by row jumps to that impl.
//
// Visualization pane (#3177/#3199/#3205, epic #3171): when the focused impl has a registered
// visualization (`vizForImpl`), the animation is ALWAYS rendered inline as an auto-playing preview (no
// Code | Visualization toggle) above the code. Clicking it lifts to the workbench (`onExpandViz`), which
// promotes the animation to the full graph canvas (`VizStage`) — mirroring the Components-page try-on.
import { Box } from "@/shared/ui/layout/Box";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Chip } from "@/shared/ui/data/Chip";
import { TECH_META, implById, usedByImpl, type KnowledgeGraph, type AlgoImpl } from "./lib/knowledge";
import { VizPreview } from "./viz/VizPanel";
import { vizForImpl } from "./viz/examples/registry";

const PANEL = { width: "100%", height: "100%", borderLeft: "1px solid var(--border)", overflowY: "auto", background: "var(--bg-panel)" } as const;

export function AlgorithmsInspector({ graph, focusedImpl, onSelectImpl, onExpandViz }: {
  graph: KnowledgeGraph;
  /** The focused implementation (#2863) — a node in the per-kit graph, or a free-standing primitive from
   *  the rail. Its code + builds-on / used-by. */
  focusedImpl?: AlgoImpl | null;
  /** Jump to another implementation (#2863) — the per-kit graph navigates impl→impl (builds-on / used-by). */
  onSelectImpl?: (id: string) => void;
  /** Expand the inline visualization to the full graph canvas (#3205) — lifted to the workbench, which
   *  renders `VizStage` in the GraphCanvas overlays slot. Omit ⇒ the inline preview is non-clickable. */
  onExpandViz?: () => void;
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

  // Key the body on the impl id so the inline preview resets on a fresh mount when the selection changes
  // — the previous impl's pane never leaks into the next one.
  return <ImplInspector key={focusedImpl.id} graph={graph} impl={focusedImpl} onSelectImpl={onSelectImpl} onExpandViz={onExpandViz} />;
}

/** The focused implementation's inspector body — its identity + inline visualization preview + code +
 *  builds-on/used-by. Split out so the preview resets per impl (via the `key`). */
function ImplInspector({ graph, impl, onSelectImpl, onExpandViz }: {
  graph: KnowledgeGraph;
  impl: AlgoImpl;
  onSelectImpl?: (id: string) => void;
  onExpandViz?: () => void;
}) {
  // A concept IS its implementation (#2958), so this is the whole inspector: the impl's code + the impls
  // it builds on (composes, down to the primitive base) and the ones that build on it (the reverse).
  const isPrim = impl.role === "primitive";
  const buildsOn = impl.composes.map((id) => implById(graph, id)).filter((im): im is AlgoImpl => !!im);
  const usedBy = usedByImpl(graph, impl.id);
  const ell = { minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } as const;
  const jump = (im: AlgoImpl) => onSelectImpl?.(im.id);

  // The impl's live visualization (#3177), if any. When present it's ALWAYS rendered inline above the
  // code (#3199); impls without one keep exactly today's code-only pane.
  const viz = vizForImpl(impl);

  return (
    <Box style={PANEL}>
      <Stack gap={12} style={{ padding: 16 }}>
        <Row gap={8} align="center" style={{ minWidth: 0 }}>
          <Box style={{ width: 10, height: 10, borderRadius: 3, background: isPrim ? "var(--violet)" : "var(--accent)", flex: "none" }} />
          <Text weight={600} size={15} style={ell}>{impl.name}</Text>
          <Chip>{impl.role}</Chip>
        </Row>
        <Eyebrow size={10}>{isPrim ? "Language built-in" : "Implementation"} · {TECH_META[impl.tech]?.label ?? impl.tech}</Eyebrow>
        {impl.summary && <Text size={12} tone="muted">{impl.summary}</Text>}
        {/* A primitive is a DESCRIPTOR of a language built-in (#2972) — its std `ref`, not a reimplementation. */}
        {impl.ref && (
          <Row gap={8} align="center" style={{ minWidth: 0 }}>
            <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".06em", textTransform: "uppercase", flex: "none" }}>Built-in</Text>
            <Text as="code" mono size={12} style={ell}>{impl.ref}</Text>
          </Row>
        )}

        {/* The visualization is always rendered inline (#3199) — an auto-playing preview; clicking it
            promotes the animation to the full graph canvas (#3205, via the workbench). Code stays below. */}
        {viz && onExpandViz && <VizPreview viz={viz} onExpand={onExpandViz} />}

        {impl.code && <Box as="pre" className="algo-code mono">{impl.code}</Box>}

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
