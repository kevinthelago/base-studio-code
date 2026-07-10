// The Algorithms knowledge-graph Workspace (#2761, epic #2760) — Graph 1, the curated concept ontology,
// rendered on the shared GraphCanvas + useGraphViewport (the Glance/Teams/Designs stack). Nodes column
// by kind (structures → algorithms → concepts → outputs); select one to light its neighbors; toggle a
// kind to dim its column. Read-only for now — the seed is authored in @data/knowledge; Phase 2 (#2745)
// layers the extracted-from-code `implements` join + the dedup lens on top.
import { useEffect, useMemo, useState } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { Eyebrow } from "@/shared/ui/typography/Eyebrow";
import { Button } from "@/shared/ui/controls/Button";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { AlgorithmsCanvas } from "./AlgorithmsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import {
  KNOWLEDGE, KIND_ORDER, KIND_META, layoutKnowledge, neighborsOf, nodeIndex,
  type KnowledgeKind,
} from "./lib/knowledge";
import "./algorithms.css";

export function AlgorithmsWorkspace() {
  const graph = KNOWLEDGE;
  const layout = useMemo(() => layoutKnowledge(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => nodeIndex(graph.nodes), [graph.nodes]);

  const [selected, setSelected] = useState<string | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<KnowledgeKind>>(() => new Set(KIND_ORDER));

  const lit = useMemo(() => (selected ? neighborsOf(graph, selected) : null), [graph, selected]);

  const vp = useGraphViewport(layout.world, { contentBounds: () => layout.bounds });
  // Frame the content on first mount (the ref callback has set the viewport element by commit time).
  useEffect(() => { vp.fit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleKind = (k: KnowledgeKind) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  const toolbar = (
    <>
      <Eyebrow size={10}>Algorithms</Eyebrow>
      <Text mono size="xxs" tone="dim">{graph.nodes.length} concepts · {graph.edges.length} links</Text>
      <Row gap={6} align="center">
        {KIND_ORDER.map((k) => {
          const on = activeKinds.has(k);
          return (
            <Box as="button" key={k} onClick={() => toggleKind(k)} title={KIND_META[k].label}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 9px", borderRadius: 7, border: "1px solid var(--border)", background: on ? "var(--bg-elev)" : "transparent", color: on ? "var(--fg)" : "var(--fg-dim)", cursor: "pointer", fontSize: 11.5 }}>
              <Box style={{ width: 9, height: 9, borderRadius: 2, background: KIND_META[k].color, opacity: on ? 1 : 0.4 }} />
              {KIND_META[k].label}
            </Box>
          );
        })}
      </Row>
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
      inspector={<AlgorithmsInspector graph={graph} selected={selected ? byId.get(selected) ?? null : null} onSelectNode={setSelected} />}
      inspectorResizable
      inspectorWidth={340}
      onBackgroundClick={() => setSelected(null)}
    >
      <AlgorithmsCanvas graph={graph} layout={layout} selected={selected} lit={lit} activeKinds={activeKinds} onSelect={setSelected} />
    </GraphCanvas>
  );
}
