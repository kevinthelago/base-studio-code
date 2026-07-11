// The Algorithms knowledge-graph page (#2761, epic #2760 · #2863 · #2899) — rendered on the shared
// GraphCanvas + useGraphViewport (the Glance/Teams/Designs stack). Works basically like the Components
// (Designs) page: the LEFT PANE is a language-FOLDER tree (each language a folder, its impls the rows —
// #2899), and the CENTER is that language's OWN graph. A concept IS its implementation: the graph's nodes
// are the active kit's impls (primitives + algorithms), wired by composes + pairs + the ontology's
// relationships lifted onto the concrete impls. The active language is driven by rail selection. The
// inspector shows the selected impl's code + what it builds on / is used by / pairs with. The seed is
// authored in @data/knowledge and hydrated live from the librarian's writable store (#2856).
import { useEffect, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { useDockEntrance } from "@/shared/hooks/useDockEntrance";
import { AlgorithmsKitGraph } from "./AlgorithmsKitGraph";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { LibrarianTerminal } from "./LibrarianTerminal";
import {
  TECHS, TECH_META, NODE_W, NODE_H, layoutKitGraph, kitGraph, kitTechs, implById,
  type Tech,
} from "./lib/knowledge";
import { useKnowledgeGraph } from "./useKnowledgeGraph";
import "./algorithms.css";

export function AlgorithmsWorkspace() {
  // Live graph (#2856): the seed for an instant first paint, hydrated + kept fresh from the librarian's
  // writable store (`bsc graph dump`) so their curation shows.
  const graph = useKnowledgeGraph();

  // The active language kit (#2899) — driven by the rail's folder selection. Defaults to the first kit.
  const [activeTech, setActiveTech] = useState<Tech>(() => kitTechs(graph)[0] ?? TECHS[0]);
  // The selected implementation (a node in the active kit's graph), shown in the inspector.
  const [selectedImpl, setSelectedImpl] = useState<string | null>(null);
  const focusedImpl = selectedImpl ? implById(graph, selectedImpl) ?? null : null;

  // The active language's OWN graph (impls + composes/pairs/lifted edges) + its layout.
  const kit = useMemo(() => kitGraph(graph, activeTech), [graph, activeTech]);
  const kitLayout = useMemo(() => layoutKitGraph(kit), [kit]);

  const vp = useGraphViewport(kitLayout.world, { contentBounds: () => kitLayout.bounds });
  // Frame the content on mount AND whenever the active language switches (each kit has its own world).
  useEffect(() => { vp.fit(); }, [activeTech]); // eslint-disable-line react-hooks/exhaustive-deps

  // Focus a language from the rail folder head — switch the graph to it; the selection belonged to the
  // old kit, so clear it (mirrors picking a different kit in the Designs rail).
  const selectLang = (t: Tech) => { setActiveTech(t); setSelectedImpl(null); };
  // Select an impl from the rail: switch to ITS language if needed (a cross-folder click), select it,
  // and — when it's already the active kit — pan its node to center.
  const selectImplFromRail = (id: string) => {
    const im = implById(graph, id);
    if (!im) return;
    setSelectedImpl(id);
    if (im.tech !== activeTech) {
      setActiveTech(im.tech); // the [activeTech] fit effect frames the new kit
      return;
    }
    const p = kitLayout.pos.get(id);
    if (p) vp.centerOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };

  // The always-on librarian session's dock height (#2787) — a row-resize handle above it; `invert`
  // because the terminal sits AFTER the handle, so dragging up grows it. Mirrors the Teams dock (#2759).
  const term = useDragResize({ initial: 340, min: 140, max: 560, axis: "y", invert: true });
  useDockEntrance(term.setSize, 340); // grow the dock up into place on mount (#2905)

  // Header: the active language + its graph counts (the rail folders are the language switcher now), then
  // the graph nav (zoom/fit).
  const toolbar = (
    <>
      <Eyebrow size={10}>Algorithms</Eyebrow>
      <Text mono size="xxs" tone="dim">
        {TECH_META[activeTech]?.label ?? activeTech} · {kit.nodes.length} impls · {kit.edges.length} links
      </Text>
      <Box style={{ flex: 1 }} />
      <ZoomControls vp={vp} />
      <Button size="sm" variant="ghost" onClick={vp.fit}>Fit</Button>
    </>
  );

  return (
    <GraphCanvas
      vp={vp}
      world={kitLayout.world}
      grid
      toolbar={toolbar}
      rail={<AlgorithmsRail graph={graph} activeTech={activeTech} selectedImpl={selectedImpl} onSelectImpl={selectImplFromRail} onSelectLang={selectLang} />}
      railResizable
      railWidth={230}
      inspector={<AlgorithmsInspector graph={graph} selected={null} focusedImpl={focusedImpl} activeTech={activeTech} onSelectNode={() => {}} onSelectImpl={setSelectedImpl} />}
      inspectorResizable
      inspectorWidth={340}
      onBackgroundClick={() => setSelectedImpl(null)}
      // The always-on knowledge-librarian session (#2787), docked below the graph; the caller owns its
      // height + a `.resize-y` handle (GraphCanvas gives it a flex:none slot), mirroring Teams (#2759).
      dock={
        <Box style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box className="resize-y" {...term.handleProps} title="Drag to resize" />
          <LibrarianTerminal height={term.size} />
        </Box>
      }
    >
      <AlgorithmsKitGraph kit={kit} layout={kitLayout} selected={selectedImpl} onSelect={setSelectedImpl} />
    </GraphCanvas>
  );
}
