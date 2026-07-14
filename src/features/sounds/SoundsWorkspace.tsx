// The Sounds tab (#3072 · #3077) — the synthesis-first audio library, on the shared GraphCanvas stack
// like Components/Algorithms. The CENTER is the kit's composition graph (Primitives → Voices → Cues,
// wired by `composes`); the LEFT rail is a folder tree of cues/voices/primitives; the inspector shows the
// selected node. Clicking a graph node plays it; the rail browses quietly (Play is in the inspector).
import { useEffect, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { useCrumbEntity } from "@/shared/hooks/useCrumbEntity";
import { SoundsKitGraph } from "./SoundsKitGraph";
import { SoundsRail } from "./SoundsRail";
import { SoundsInspector } from "./SoundsInspector";
import { buildSoundGraph, layoutSoundGraph, playableCueForNode, NODE_W, NODE_H, type SoundNode } from "./lib/soundGraph";
import { playCue } from "./lib/synth";
import { STARTER_KIT } from "./lib/soundSeeds";
import "./sounds.css";

export function SoundsWorkspace() {
  // Phase 1/2 read the seed kit directly (the durable bsc-sound store is Phase 3).
  const kit = STARTER_KIT;
  useCrumbEntity("sounds", kit.name);

  const graph = useMemo(() => buildSoundGraph(kit), [kit]);
  const layout = useMemo(() => layoutSoundGraph(graph), [graph]);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedNode = selected ? graph.nodes.find((n) => n.id === selected) ?? null : null;

  const vp = useGraphViewport(layout.world, { contentBounds: () => layout.bounds });
  // Frame the graph once on mount (like AlgorithmsWorkspace) — we only want the initial fit.
  useEffect(() => { vp.fit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const play = (node: SoundNode) => {
    const cue = playableCueForNode(node, kit);
    if (cue) playCue(cue, kit);
  };
  // Rail click: select + pan to the node, no sound (browse quietly).
  const select = (id: string) => {
    setSelected(id);
    const p = layout.pos.get(id);
    if (p) vp.centerOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };
  // Graph-node click: select + play.
  const activate = (id: string) => {
    setSelected(id);
    const node = graph.nodes.find((n) => n.id === id);
    if (node) play(node);
  };

  const counts = useMemo(() => ({
    cues: graph.nodes.filter((n) => n.kind === "cue").length,
    voices: graph.nodes.filter((n) => n.kind === "voice").length,
    primitives: graph.nodes.filter((n) => n.kind === "primitive").length,
  }), [graph.nodes]);

  const toolbar = (
    <>
      <Eyebrow size={10}>Sounds</Eyebrow>
      <Text mono size="xxs" tone="dim">{kit.name} · {counts.cues} cues · {counts.voices} voices · {counts.primitives} primitives</Text>
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
      rail={<SoundsRail graph={graph} selected={selected} onSelect={select} />}
      railResizable
      railWidth={230}
      inspector={<SoundsInspector node={selectedNode} kit={kit} onPlay={play} />}
      inspectorResizable
      inspectorWidth={320}
      onBackgroundClick={() => setSelected(null)}
    >
      <SoundsKitGraph graph={graph} layout={layout} selected={selected} onActivate={activate} />
    </GraphCanvas>
  );
}
