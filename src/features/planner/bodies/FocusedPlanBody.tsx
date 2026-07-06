// The Plan review (split from FocusedBodies.tsx #1757): the Plan stage's autonomous output — the
// feature seam/dependency graph — shown for the user to APPROVE (the catch-point for a wrong
// inferred seam).
import { useState, useMemo } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { RelationshipGraphView } from "@/features/planner/relationship/RelationshipGraphView";
import { RelationshipInspector } from "@/features/planner/relationship/RelationshipInspector";
import {
  buildRelationshipGraph, EDGE_KIND_META,
  type Topology, type RelFocus,
} from "@/features/planner/relationship/relationshipGraph";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { SectionLabel } from "@/shared/ui/layout/SectionLabel";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";

export function PlanBody({ data, focus: focusProp, onFocus }: {
  data?: ProjectPaneData;
  /** Controlled graph focus (#1392 streams-link): in the merged "Streams" stage the parent lifts
   *  focus so the permissions roster expands whichever stream the graph spotlights (and vice-versa).
   *  Omitted ⇒ PlanBody owns its own focus (the standalone Plan stage). */
  focus?: RelFocus;
  onFocus?: (f: RelFocus) => void;
}) {
  const [focusState, setFocusState] = useState<RelFocus>(null);
  const focus = focusProp !== undefined ? focusProp : focusState;
  const setFocus = (f: RelFocus | ((prev: RelFocus) => RelFocus)) => {
    const next = typeof f === "function" ? (f as (p: RelFocus) => RelFocus)(focus) : f;
    if (onFocus) onFocus(next); else setFocusState(next);
  };
  const [hover, setHover] = useState<string | null>(null);

  // Agent-relationship graph (#…): the typed coordination graph over the fleet streams.
  const artifacts = data?.relationshipArtifacts ?? [];
  const edges = data?.relationships ?? [];
  const topology = (data?.topology ?? "hybrid") as Topology;
  // Renders for ANY planned fleet (≥1 stream) — and, before the fleet is authored, straight from
  // the FEATURES (a feature IS a stream; #plan-db), so the stream graph shows during the Structure
  // stage. `relationships` (edges) falls back to dependsOn-derived edges in projectPaneData.
  const relGraph = useMemo(() => {
    const nodes = (data?.agents?.length ?? 0) > 0
      ? (data?.agents ?? []).map((a) => ({ id: a.id, role: a.role, repo: a.repo, owns: a.owns }))
      : (data?.features ?? []).map((f) => ({ id: f.slug, role: "worker" as const, repo: "", owns: [] }));
    return nodes.length ? buildRelationshipGraph(nodes, artifacts, edges, topology) : null;
  }, [data?.agents, data?.features, artifacts, edges, topology]);
  const hasRel = !!relGraph;

  if (!hasRel) {
    return <EmptyState iconVariant="dashed" icon="◫" title="No plan yet — define the features, then Claude drafts the dependency seams" />;
  }

  const kindsUsed = relGraph ? [...new Set(edges.map((e) => e.kind))] : [];
  const cycleN = relGraph?.cycleEdgeIds.size ?? 0;
  const gatePass = !relGraph?.hasCycle;
  const focusName = focus ? (focus.type === "agent" ? focus.id : `contract:${focus.id}`) : null;

  return (
    <Stack gap={12}>
      {relGraph && (
        <Box>
          {/* STREAMS — gate pill on the right (#1429 reskin) */}
          <SectionLabel size={9.5} style={{ paddingBottom: 9 }} right={
            <Box as="span" data-testid="relationship-gate" className="mono" pad={[3, 8]} bg={`color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 87%)`} radius={20} style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, fontSize: 9.5, textTransform: "none",
              color: gatePass ? "var(--success)" : "var(--danger)",
              border: `1px solid color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 67%)`,
              animation: gatePass ? undefined : "pulse 1.8s ease-in-out infinite",
            }}>
              {gatePass ? "✓ no dependency cycles" : `⨯ gate blocked · ${cycleN} edge${cycleN === 1 ? "" : "s"} in a cycle`}
            </Box>
          }>streams</SectionLabel>
          {/* graph card + legend */}
          <Box bg="var(--bg-elev)" border radius={9} style={{ padding: "8px 8px 4px" }}>
            <RelationshipGraphView
              graph={relGraph}
              focus={focus}
              hover={hover}
              onHover={setHover}
              onFocusAgent={(id) => setFocus((f) => (f && f.type === "agent" && f.id === id ? null : { type: "agent", id }))}
              onInspectEdge={(id) => setFocus({ type: "edge", id })}
              onInspectArtifact={(id) => setFocus({ type: "art", id })}
            />
            <Row wrap gap={10} align="stretch" style={{ padding: "7px 4px 5px", borderTop: "1px solid var(--border-soft)", marginTop: 2 }}>
              {kindsUsed.map((k) => (
                <Box as="span" key={k} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, fontSize: 8.5, color: "var(--fg-dim)" }}>
                  <Box as="span" style={{ width: 11, height: 0, borderTop: `1.6px solid ${EDGE_KIND_META[k].color}` }} />{EDGE_KIND_META[k].label}
                </Box>
              ))}
              <Box as="span" className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, fontSize: 8.5, color: "var(--fg-dim)" }}>
                <Box as="span" bg="var(--success)" style={{ width: 7, height: 7, transform: "rotate(45deg)"}} />contract ready
              </Box>
            </Row>
          </Box>
          <Row className="mono" justify="center" gap={9} style={{ fontWeight: 500, fontSize: 9, color: focus ? "var(--accent)" : "var(--fg-dim)", marginTop: 7, textAlign: "center" }}>
            <Text as="span">{focus ? `◆ focused: ${focusName} — neighborhood spotlit` : "hover a lane to spotlight its neighborhood · click to focus"}</Text>
            {/* eslint-disable-next-line no-restricted-syntax -- bespoke `.mini` text button, not a `.btn`-family control */}
            {focus && <button className="mini" onClick={() => { setFocus(null); setHover(null); }} style={{ fontSize: 9 }}>clear ✕</button>}
          </Row>

          {/* INSPECTOR */}
          <SectionLabel size={9.5} style={{ padding: "13px 0 9px" }}>inspector</SectionLabel>
          <Box pad={[12, 13]} bg="var(--bg-elev)" border radius={9}>
            <RelationshipInspector
              graph={relGraph}
              focus={focus}
              onFocusAgent={(id) => setFocus({ type: "agent", id })}
              onInspectArtifact={(id) => setFocus({ type: "art", id })}
              onInspectEdge={(id) => setFocus({ type: "edge", id })}
            />
          </Box>
        </Box>
      )}
    </Stack>
  );
}
