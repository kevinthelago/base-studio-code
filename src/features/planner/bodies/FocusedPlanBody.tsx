// The Plan review (split from FocusedBodies.tsx #1757): the Plan stage's autonomous output — the
// feature seam/dependency graph and the phases — shown for the user to APPROVE (the catch-point for
// a wrong inferred seam).
import { useState, useMemo } from "react";
import type { ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import { RelationshipGraphView } from "@/features/planner/relationship/RelationshipGraphView";
import {
  buildRelationshipGraph, EDGE_KIND_META,
  type Topology, type RelFocus,
} from "@/features/planner/relationship/relationshipGraph";

export function FocusedPlanBody({ data, focus: focusProp, onFocus }: {
  data?: ProjectPaneData;
  /** Controlled graph focus (#1392 streams-link): in the merged "Streams" stage the parent lifts
   *  focus so the permissions roster expands whichever stream the graph spotlights (and vice-versa).
   *  Omitted ⇒ FocusedPlanBody owns its own focus (the standalone Plan stage). */
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
  const phases = data?.phaseStructure ?? [];

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

  if (phases.length === 0 && !hasRel) {
    return (
      <div className="empty-state">
        <span className="empty-icon">◫</span>
        <span>No plan yet — define the features, then Claude drafts the phases + seams</span>
      </div>
    );
  }

  const kindsUsed = relGraph ? [...new Set(edges.map((e) => e.kind))] : [];
  const cycleN = relGraph?.cycleEdgeIds.size ?? 0;
  const gatePass = !relGraph?.hasCycle;
  const focusName = focus ? (focus.type === "agent" ? focus.id : `contract:${focus.id}`) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {relGraph && (
        <div>
          {/* STREAMS — gate pill on the right (#1429 reskin) */}
          <div className="ulabel" style={{ paddingBottom: 9, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <span>streams</span>
            <span data-testid="relationship-gate" className="mono" style={{
              display: "inline-flex", alignItems: "center", gap: 5, fontWeight: 600, fontSize: 9.5, padding: "3px 8px", borderRadius: 20, textTransform: "none",
              color: gatePass ? "var(--success)" : "var(--danger)",
              background: `color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 87%)`,
              border: `1px solid color-mix(in oklch, ${gatePass ? "var(--success)" : "var(--danger)"}, transparent 67%)`,
              animation: gatePass ? undefined : "pulse 1.8s ease-in-out infinite",
            }}>
              {gatePass ? "✓ no dependency cycles" : `⨯ gate blocked · ${cycleN} edge${cycleN === 1 ? "" : "s"} in a cycle`}
            </span>
          </div>
          {/* graph card + legend */}
          <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 9, padding: "8px 8px 4px" }}>
            <RelationshipGraphView
              graph={relGraph}
              focus={focus}
              hover={hover}
              onHover={setHover}
              onFocusAgent={(id) => setFocus((f) => (f && f.type === "agent" && f.id === id ? null : { type: "agent", id }))}
              onInspectEdge={(id) => setFocus({ type: "edge", id })}
              onInspectArtifact={(id) => setFocus({ type: "art", id })}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, padding: "7px 4px 5px", borderTop: "1px solid var(--border-soft)", marginTop: 2 }}>
              {kindsUsed.map((k) => (
                <span key={k} className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, fontSize: 8.5, color: "var(--fg-dim)" }}>
                  <span style={{ width: 11, height: 0, borderTop: `1.6px solid ${EDGE_KIND_META[k].color}` }} />{EDGE_KIND_META[k].label}
                </span>
              ))}
              <span className="mono" style={{ display: "inline-flex", alignItems: "center", gap: 4, fontWeight: 500, fontSize: 8.5, color: "var(--fg-dim)" }}>
                <span style={{ width: 7, height: 7, transform: "rotate(45deg)", background: "var(--success)" }} />contract ready
              </span>
            </div>
          </div>
          <div className="mono" style={{ fontWeight: 500, fontSize: 9, color: focus ? "var(--accent)" : "var(--fg-dim)", marginTop: 7, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
            <span>{focus ? `◆ focused: ${focusName} — neighborhood spotlit` : "hover a lane to spotlight its neighborhood · click to focus"}</span>
            {focus && <button className="mini" onClick={() => { setFocus(null); setHover(null); }} style={{ fontSize: 9 }}>clear ✕</button>}
          </div>
        </div>
      )}
      {phases.length > 0 && (
        <div>
          <div className="ulabel" style={{ paddingBottom: 6 }}>phases</div>
          {/* Numbered roadmap (#1429 reskin): a circle per phase + its done-when, foundations first. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {phases.map((p, i) => {
              const first = i === 0;
              return (
                <div key={p.id}>
                  <div style={{ display: "flex", gap: 11, padding: "8px 4px" }}>
                    <span style={{
                      flexShrink: 0, width: 20, height: 20, borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, fontWeight: 600,
                      color: first ? "var(--accent)" : "var(--fg-muted)",
                      background: first ? "color-mix(in oklch, var(--accent), transparent 86%)" : "var(--bg-elev2)",
                      border: "1px solid " + (first ? "color-mix(in oklch, var(--accent), transparent 65%)" : "var(--border)"),
                    }}>{i + 1}</span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 11.5, fontWeight: 600, color: "var(--fg)" }}>{p.name}</div>
                      <div className="mono" style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 2 }}>
                        {p.doneWhen ? `done when · ${p.doneWhen}` : `${p.total} issue${p.total === 1 ? "" : "s"}`}
                      </div>
                    </div>
                  </div>
                  {i < phases.length - 1 && <div style={{ height: 1, background: "var(--border-soft)", marginLeft: 31 }} />}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
