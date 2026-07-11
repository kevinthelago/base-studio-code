// The Algorithms knowledge-graph page (#2761, epic #2760) — Graph 1, the curated concept ontology,
// rendered on the shared GraphCanvas + useGraphViewport (the Glance/Teams/Designs stack). A READ-ONLY
// viewer (#2785): the header is just the title + node/relationship count + zoom/fit — no user controls —
// so the user watches the graph rather than configuring it. Folded in as the "algorithms" Planner tab
// (its own rail Workspace was removed, #2785). Nodes column by kind (structures → algorithms → concepts →
// outputs); select one to light its neighbors. The seed is authored in @data/knowledge; the per-tech
// implementation tier (#2770) shows the default (TypeScript) implementation in the inspector.
import { useEffect, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { AlgorithmsCanvas } from "./AlgorithmsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { LibrarianTerminal } from "./LibrarianTerminal";
import {
  KIND_ORDER, TECHS, NODE_W, NODE_H, layoutKnowledge, neighborsOf, nodeIndex,
} from "./lib/knowledge";
import { useKnowledgeGraph } from "./useKnowledgeGraph";
import "./algorithms.css";

// The graph is READ-ONLY (#2785): every kind is always shown (the kind-filter control is gone), and the
// inspector shows the default tech's implementation (the language switcher is gone). Both were user
// controls, removed so the page is a viewer the user watches rather than configures.
const ALL_KINDS = new Set(KIND_ORDER);
const DEFAULT_TECH = TECHS[0]; // TypeScript — the implementation shown in the inspector.

export function AlgorithmsWorkspace() {
  // Live graph (#2856): the seed for an instant first paint, hydrated + kept fresh from the librarian's
  // writable store (`bsc graph dump`) so their curation shows.
  const graph = useKnowledgeGraph();
  const layout = useMemo(() => layoutKnowledge(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => nodeIndex(graph.nodes), [graph.nodes]);

  const [selected, setSelected] = useState<string | null>(null);

  const lit = useMemo(() => (selected ? neighborsOf(graph, selected) : null), [graph, selected]);
  // The concept ids that carry an implementation in the default tech — drives the node "</>" badge.
  const implConcepts = useMemo(
    () => new Set(
      graph.implementations
        .filter((im) => im.tech === DEFAULT_TECH)
        .flatMap((im) => (im.concept ? [im.concept] : [])), // free-standing primitives (#2863) have no concept
    ),
    [graph.implementations],
  );

  const vp = useGraphViewport(layout.world, { contentBounds: () => layout.bounds });
  // Frame the content on first mount (the ref callback has set the viewport element by commit time).
  useEffect(() => { vp.fit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Rail selection also pans the node to center (the rail is navigation, not just selection).
  const selectFromRail = (id: string) => {
    setSelected(id);
    const p = layout.pos.get(id);
    if (p) vp.centerOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };

  // The always-on librarian session's dock height (#2787) — a row-resize handle above it; `invert`
  // because the terminal sits AFTER the handle, so dragging up grows it. Mirrors the Teams dock (#2759).
  const term = useDragResize({ initial: 240, min: 140, max: 560, axis: "y", invert: true });

  // Read-only header (#2785): the title + node/relationship count, then the standard graph nav
  // (zoom/fit). The former kind-filter, language, and scan controls were removed — the page is a viewer.
  const toolbar = (
    <>
      <Eyebrow size={10}>Algorithms</Eyebrow>
      <Text mono size="xxs" tone="dim">{graph.nodes.length} nodes · {graph.edges.length} relationships</Text>
      <Box style={{ flex: 1 }} />
      <ZoomControls vp={vp} />
      <Button size="sm" variant="ghost" onClick={vp.fit}>Fit</Button>
    </>
  );

  return (
    <GraphCanvas
      vp={vp}
      world={layout.world}
      grid
      toolbar={toolbar}
      rail={<AlgorithmsRail graph={graph} selected={selected} onSelect={selectFromRail} />}
      railResizable
      railWidth={230}
      inspector={<AlgorithmsInspector graph={graph} selected={selected ? byId.get(selected) ?? null : null} activeTech={DEFAULT_TECH} onSelectNode={setSelected} />}
      inspectorResizable
      inspectorWidth={340}
      onBackgroundClick={() => setSelected(null)}
      // The always-on knowledge-librarian session (#2787), docked below the graph; the caller owns its
      // height + a `.resize-y` handle (GraphCanvas gives it a flex:none slot), mirroring Teams (#2759).
      dock={
        <Box style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box className="resize-y" {...term.handleProps} title="Drag to resize" />
          <LibrarianTerminal height={term.size} />
        </Box>
      }
    >
      <AlgorithmsCanvas graph={graph} layout={layout} selected={selected} lit={lit} activeKinds={ALL_KINDS} implConcepts={implConcepts} onSelect={setSelected} />
    </GraphCanvas>
  );
}
