// The Algorithms knowledge-graph page (#2761, epic #2760 · #2863) — rendered on the shared GraphCanvas +
// useGraphViewport (the Glance/Teams/Designs stack). TWO graph layers the user navigates between:
//   • the "kits" index — a card per language kit (TypeScript · Rust · …); drill into one.
//   • a "kit" graph — that language kit's OWN graph, where a concept IS its implementation: the kit's
//     impls as nodes (primitives + algorithms), wired by composes + pairs + the ontology's relationships
//     lifted onto the concrete impls (#2863). Per-language, not deduped.
// The rail navigates the active kit's impls by role; the inspector shows the selected impl's code + the
// impls it builds on / is used by / pairs with. The seed is authored in @data/knowledge and hydrated live
// from the librarian's writable store (#2856).
import { useEffect, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { useDragResize } from "@/shared/hooks/useDragResize";
import { AlgorithmsKitGraph } from "./AlgorithmsKitGraph";
import { AlgorithmsKitsCanvas } from "./AlgorithmsKitsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { AlgorithmsRail } from "./AlgorithmsRail";
import { LibrarianTerminal } from "./LibrarianTerminal";
import {
  TECHS, TECH_META, NODE_W, NODE_H, layoutKits, layoutKitGraph, kitGraph, kitTechs, implById, implFor,
  type Tech,
} from "./lib/knowledge";
import { useKnowledgeGraph } from "./useKnowledgeGraph";
import "./algorithms.css";

export function AlgorithmsWorkspace() {
  // Live graph (#2856): the seed for an instant first paint, hydrated + kept fresh from the librarian's
  // writable store (`bsc graph dump`) so their curation shows.
  const graph = useKnowledgeGraph();

  // The active language kit (#2863). Defaults to the first seeded kit.
  const techs = useMemo(() => kitTechs(graph), [graph]);
  const [activeTech, setActiveTech] = useState<Tech>(() => kitTechs(graph)[0] ?? TECHS[0]);
  // The selected implementation (a node in the per-kit graph), shown in the inspector.
  const [selectedImpl, setSelectedImpl] = useState<string | null>(null);
  const focusedImpl = selectedImpl ? implById(graph, selectedImpl) ?? null : null;

  // The two graph layers (#2863): the "kits" index sits ABOVE the "kit" graph. Default lands in the kit
  // graph (the working view); the index is the coarse between-kits navigator, reached via the header.
  const [view, setView] = useState<"kits" | "kit">("kit");
  // The active kit's own graph (impls + composes/pairs/lifted edges) and its layout.
  const kit = useMemo(() => kitGraph(graph, activeTech), [graph, activeTech]);
  const kitLayout = useMemo(() => layoutKitGraph(kit), [kit]);
  const kitsLayout = useMemo(() => layoutKits(techs), [techs]);
  // Both layouts share the {world, bounds} shape, so ONE viewport frames whichever layer is active.
  const frame = view === "kits" ? kitsLayout : kitLayout;

  const selectImpl = (id: string | null) => setSelectedImpl(id);
  // Open (drill into) a kit: make it active and show its graph. Re-anchors the selection to the SAME
  // concept's impl in the new kit (impl ids are per-language: merge-sort.ts → merge-sort.rs), else clears
  // it — so switching kits from within the graph re-languages the inspector without a stale selection.
  const openKit = (t: Tech) => {
    if (t !== activeTech && selectedImpl) {
      const cur = implById(graph, selectedImpl);
      const next = cur?.concept ? implFor(graph, cur.concept, t) : undefined;
      setSelectedImpl(next?.id ?? null);
    }
    setActiveTech(t);
    setView("kit");
  };
  // Pop up to the kits index — clear the selection (it belongs to a kit's graph).
  const goToKits = () => { setView("kits"); setSelectedImpl(null); };

  const vp = useGraphViewport(frame.world, { contentBounds: () => frame.bounds });
  // Frame the content on mount AND whenever the layer or active kit switches (each has a different world).
  useEffect(() => { vp.fit(); }, [view, activeTech]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rail selection drops into the kit graph, selects the impl, and pans its node to center.
  const selectFromRail = (id: string) => {
    setView("kit");
    setSelectedImpl(id);
    const p = kitLayout.pos.get(id);
    if (p) vp.centerOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };

  // The always-on librarian session's dock height (#2787) — a row-resize handle above it; `invert`
  // because the terminal sits AFTER the handle, so dragging up grows it. Mirrors the Teams dock (#2759).
  const term = useDragResize({ initial: 240, min: 140, max: 560, axis: "y", invert: true });

  // Header: a KITS breadcrumb (#2863) — the between-kits navigation. In the kit graph it reads
  // `Kits ▸ <language>` where "Kits" pops up to the kits-index layer; on the index it names the level and
  // the kit count. Then the graph nav (zoom/fit).
  const toolbar = (
    <>
      <Eyebrow size={10}>Algorithms</Eyebrow>
      {view === "kit" ? (
        <>
          <Button size="sm" variant="ghost" onClick={goToKits}>Kits</Button>
          <Text mono size="xxs" tone="dim">▸ {TECH_META[activeTech]?.label ?? activeTech}</Text>
          <Text mono size="xxs" tone="dim">· {kit.nodes.length} impls · {kit.edges.length} links</Text>
        </>
      ) : (
        <Text mono size="xxs" tone="dim">Kits · {techs.length} language {techs.length === 1 ? "kit" : "kits"}</Text>
      )}
      <Box style={{ flex: 1 }} />
      <ZoomControls vp={vp} />
      <Button size="sm" variant="ghost" onClick={vp.fit}>Fit</Button>
    </>
  );

  return (
    <GraphCanvas
      vp={vp}
      world={frame.world}
      grid
      toolbar={toolbar}
      rail={<AlgorithmsRail graph={graph} activeTech={activeTech} selectedImpl={selectedImpl} onSelectImpl={selectFromRail} onSelectKit={openKit} />}
      railResizable
      railWidth={230}
      inspector={<AlgorithmsInspector graph={graph} selected={null} focusedImpl={focusedImpl} activeTech={activeTech} onSelectNode={() => {}} onSelectImpl={selectImpl} />}
      inspectorResizable
      inspectorWidth={340}
      onBackgroundClick={view === "kits" ? undefined : () => selectImpl(null)}
      // The always-on knowledge-librarian session (#2787), docked below the graph; the caller owns its
      // height + a `.resize-y` handle (GraphCanvas gives it a flex:none slot), mirroring Teams (#2759).
      dock={
        <Box style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Box className="resize-y" {...term.handleProps} title="Drag to resize" />
          <LibrarianTerminal height={term.size} />
        </Box>
      }
    >
      {view === "kits"
        ? <AlgorithmsKitsCanvas graph={graph} layout={kitsLayout} activeTech={activeTech} onOpen={openKit} />
        : <AlgorithmsKitGraph kit={kit} layout={kitLayout} selected={selectedImpl} onSelect={selectImpl} />}
    </GraphCanvas>
  );
}
