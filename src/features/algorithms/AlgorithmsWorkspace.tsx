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
import { TextField } from "@/shared/ui/controls/Field";
import { GraphCanvas, ZoomControls } from "@/shared/ui/layouts/GraphCanvas";
import { useGraphViewport } from "@/shared/ui/layouts/useGraphViewport";
import { AlgorithmsCanvas } from "./AlgorithmsCanvas";
import { AlgorithmsInspector } from "./AlgorithmsInspector";
import { AlgorithmsRail } from "./AlgorithmsRail";
import {
  KNOWLEDGE, KIND_ORDER, KIND_META, TECHS, TECH_META, NODE_W, NODE_H, layoutKnowledge, neighborsOf, nodeIndex,
  type KnowledgeKind, type Tech,
} from "./lib/knowledge";
import { runExtract } from "./lib/extractionBridge";
import { sitesByConcept, siteCounts, duplicateConcepts, callsFor, type ExtractResult } from "./lib/extraction";
import { composeDiff, driftConcepts } from "./lib/compositionDiff";
import "./algorithms.css";

export function AlgorithmsWorkspace() {
  const graph = KNOWLEDGE;
  const layout = useMemo(() => layoutKnowledge(graph.nodes), [graph.nodes]);
  const byId = useMemo(() => nodeIndex(graph.nodes), [graph.nodes]);

  const [selected, setSelected] = useState<string | null>(null);
  const [activeKinds, setActiveKinds] = useState<Set<KnowledgeKind>>(() => new Set(KIND_ORDER));
  const [activeTech, setActiveTech] = useState<Tech>(TECHS[0]);
  // The extracted-from-code reality lift (#2777) — `null` until a scan runs (or the bridge is absent),
  // in which case NO dedup badges show.
  const [extract, setExtract] = useState<ExtractResult | null>(null);
  const [scanPath, setScanPath] = useState("");

  const lit = useMemo(() => (selected ? neighborsOf(graph, selected) : null), [graph, selected]);
  // The concept ids that carry an implementation in the active tech — drives the node "</>" badge.
  const implConcepts = useMemo(
    () => new Set(graph.implementations.filter((im) => im.tech === activeTech).map((im) => im.concept)),
    [graph.implementations, activeTech],
  );
  // The extraction lens (#2777): concept → real-site count + the >1-site (duplicate) set drive the node
  // dedup badge; the selected concept's sites feed the inspector's "Implementations found" list.
  const siteCountMap = useMemo(() => (extract ? siteCounts(extract) : null), [extract]);
  const dupConcepts = useMemo(() => (extract ? duplicateConcepts(extract) : null), [extract]);
  const selectedSites = useMemo(
    () => (extract && selected ? sitesByConcept(extract).get(selected) ?? [] : []),
    [extract, selected],
  );
  // The selected concept's outbound extracted call edges (#2779) — feeds the inspector's "Calls (from
  // code)" section. `extract.calls` is already tech-scoped to the scan's tech.
  const selectedCalls = useMemo(
    () => (extract && selected ? callsFor(extract, selected) : []),
    [extract, selected],
  );
  // The intent-vs-reality composition diff (#2781): declared `composes` edges vs extracted `calls`.
  // Only implemented concepts get a diff; `driftSet` are those whose observed composition diverged —
  // the canvas paints them a drift badge, and the selected concept's diff feeds the inspector.
  const diffs = useMemo(() => (extract ? composeDiff(graph, extract) : null), [extract, graph]);
  const driftSet = useMemo(() => (diffs ? driftConcepts(diffs) : null), [diffs]);
  const selectedDiff = selected && diffs ? diffs.get(selected) : undefined;

  const runScan = () => {
    const dir = scanPath.trim();
    if (!dir) return;
    runExtract(dir, activeTech).then(setExtract);
  };

  const vp = useGraphViewport(layout.world, { contentBounds: () => layout.bounds });
  // Frame the content on first mount (the ref callback has set the viewport element by commit time).
  useEffect(() => { vp.fit(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleKind = (k: KnowledgeKind) =>
    setActiveKinds((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });

  // Rail selection also pans the node to center (the rail is navigation, not just selection).
  const selectFromRail = (id: string) => {
    setSelected(id);
    const p = layout.pos.get(id);
    if (p) vp.centerOn(p.x + NODE_W / 2, p.y + NODE_H / 2);
  };

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
      <Row gap={4} align="center" title="Implementation language (#2770)">
        {TECHS.map((t) => {
          const on = t === activeTech;
          return (
            <Box as="button" key={t} onClick={() => setActiveTech(t)} title={`${TECH_META[t].label} implementations`}
              style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 9px", borderRadius: 7, border: "1px solid var(--border)", background: on ? "var(--accent)" : "transparent", color: on ? "var(--on-accent, #fff)" : "var(--fg-dim)", cursor: "pointer", fontSize: 11.5, fontWeight: on ? 600 : 400 }}>
              {TECH_META[t].label}
              <Text as="span" mono size="xxs" style={{ opacity: 0.75 }}>.{TECH_META[t].ext}</Text>
            </Box>
          );
        })}
      </Row>
      <Box style={{ flex: 1 }} />
      <Row gap={6} align="center" title="Scan a directory — count real implementations per concept (#2777)">
        <TextField
          value={scanPath}
          onChange={setScanPath}
          placeholder="path to scan…"
          aria-label="Path to scan"
          style={{ width: 180 }}
          onKeyDown={(e) => { if (e.key === "Enter") runScan(); }}
        />
        <Button size="sm" onClick={runScan}>Scan</Button>
      </Row>
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
      inspector={<AlgorithmsInspector graph={graph} selected={selected ? byId.get(selected) ?? null : null} activeTech={activeTech} sites={selectedSites} calls={selectedCalls} diff={selectedDiff} onSelectNode={setSelected} />}
      inspectorResizable
      inspectorWidth={340}
      onBackgroundClick={() => setSelected(null)}
    >
      <AlgorithmsCanvas graph={graph} layout={layout} selected={selected} lit={lit} activeKinds={activeKinds} implConcepts={implConcepts} siteCounts={siteCountMap ?? undefined} dupConcepts={dupConcepts ?? undefined} driftConcepts={driftSet ?? undefined} extractedCalls={extract?.calls} onSelect={setSelected} />
    </GraphCanvas>
  );
}
