// SeamGraphView — hand-rolled SVG renderer for the per-project dependency DAG
// (#294). No heavy graphing dep; the layout comes from buildSeamGraph (Kahn's
// longest-path topological sort). Nodes are colored by maturity; clicking one
// opens a drill-down panel showing owns, acceptance criteria, and stream.

import { useState } from "react";
import type { SeamGraph, SeamNode, NodeMaturity } from "../../lib/planSeamGraph";

// ── Layout constants ─────────────────────────────────────────────────────────

const NODE_W = 148;   // node rect width
const NODE_H = 36;    // node rect height
const COL_W  = 196;   // horizontal step between layers (includes gap)
const ROW_H  = 54;    // vertical step within a layer (includes gap)
const PAD    = 18;    // canvas padding on all sides

// ── Maturity palette ─────────────────────────────────────────────────────────

const MATURITY_COLOR: Record<NodeMaturity, string> = {
  done:    "var(--success, #3fbb6f)",
  active:  "var(--accent,  #5b8ef7)",
  backlog: "oklch(0.68 0.09 230)",
  stub:    "var(--fg-dim, #555)",
};

// ── Coordinate helpers ────────────────────────────────────────────────────────

function nx(layer: number)  { return PAD + layer * COL_W; }
function ny(order: number)  { return PAD + order * ROW_H; }
function ncx(layer: number) { return nx(layer) + NODE_W; }       // right edge x
function ncy(order: number) { return ny(order) + NODE_H / 2; }   // vertical centre

// ── Edge renderer ─────────────────────────────────────────────────────────────

function EdgePath({ fromNode, toNode, dangling }: { fromNode: SeamNode; toNode: SeamNode; dangling: boolean }) {
  const x1 = ncx(fromNode.layer), y1 = ncy(fromNode.order);
  const x2 = nx(toNode.layer),    y2 = ncy(toNode.order);
  const dx  = Math.max(20, (x2 - x1) * 0.4);
  const d   = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  const stroke  = dangling ? "oklch(0.72 0.15 55)" : "var(--fg-dim, #444)";
  const markerId = dangling ? "seam-arrow-dangle" : "seam-arrow";
  return (
    <path
      d={d}
      stroke={stroke}
      strokeWidth={dangling ? 1.5 : 1.5}
      strokeDasharray={dangling ? "4 3" : undefined}
      fill="none"
      markerEnd={`url(#${markerId})`}
      opacity={0.65}
    />
  );
}

// ── Node renderer ─────────────────────────────────────────────────────────────

function NodeRect({ node, selected, onClick }: { node: SeamNode; selected: boolean; onClick: () => void }) {
  const color  = MATURITY_COLOR[node.maturity];
  const label  = node.title.length > 21 ? node.title.slice(0, 20) + "…" : node.title;
  const x = nx(node.layer), y = ny(node.order);
  return (
    <g onClick={onClick} style={{ cursor: "pointer" }}>
      <rect
        x={x} y={y} width={NODE_W} height={NODE_H} rx={4}
        fill={selected ? "oklch(0.22 0.04 230 / 1)" : "var(--surface-2, #181828)"}
        stroke={selected ? color : "var(--border-subtle, #2e2e40)"}
        strokeWidth={selected ? 2 : 1}
      />
      <circle cx={x + 11} cy={y + NODE_H / 2} r={4} fill={color} opacity={0.9} />
      <text
        x={x + 22} y={y + NODE_H / 2 + 4}
        fontSize={9} fontFamily="var(--mono, monospace)"
        fill={selected ? "var(--fg, #e8e8ef)" : "var(--fg-muted, #a0a0b8)"}
      >
        {label}
      </text>
    </g>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyGraph() {
  return (
    <div style={{
      padding: "28px 0", textAlign: "center",
      fontFamily: "var(--mono, monospace)", fontSize: 10,
      color: "var(--fg-dim, #555)",
    }}>
      No issues yet. Add issues with <code>dependsOn</code> links to see the dependency graph.
    </div>
  );
}

// ── Drill-down panel ──────────────────────────────────────────────────────────

function DrillDown({ node, onClose }: { node: SeamNode; onClose: () => void }) {
  const color = MATURITY_COLOR[node.maturity];
  return (
    <div style={{
      padding: "10px 12px",
      background: "var(--surface-2, #181828)",
      borderRadius: 6,
      fontFamily: "var(--mono, monospace)",
      fontSize: 9.5,
      lineHeight: 1.7,
      borderLeft: `3px solid ${color}`,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <span style={{ color, fontSize: 8, lineHeight: "20px" }}>●</span>
        <span style={{ color: "var(--fg, #e8e8ef)", fontSize: 10, fontWeight: 600, flex: 1 }}>
          {node.title}
        </span>
        <span
          onClick={onClose}
          style={{ color: "var(--fg-dim, #555)", cursor: "pointer", fontSize: 11, lineHeight: "18px" }}
          title="Close"
        >✕</span>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <div>
          <span style={{ color: "var(--fg-dim, #555)" }}>maturity </span>
          <span style={{ color }}>{node.maturity}</span>
        </div>
        {node.stream && (
          <div>
            <span style={{ color: "var(--fg-dim, #555)" }}>stream </span>
            <span style={{ color: "var(--fg-muted, #a0a0b8)" }}>{node.stream}</span>
          </div>
        )}
        {node.phase !== undefined && (
          <div>
            <span style={{ color: "var(--fg-dim, #555)" }}>phase </span>
            <span style={{ color: "var(--fg-muted, #a0a0b8)" }}>{String(node.phase)}</span>
          </div>
        )}
      </div>
      {node.owns.length > 0 && (
        <div style={{ marginTop: 4 }}>
          <span style={{ color: "var(--fg-dim, #555)" }}>owns </span>
          <span style={{ color: "var(--fg-muted, #a0a0b8)" }}>{node.owns.join(", ")}</span>
        </div>
      )}
      {node.acceptance.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ color: "var(--fg-dim, #555)", marginBottom: 2 }}>
            acceptance ({node.acceptance.length})
          </div>
          {node.acceptance.map((a, i) => (
            <div key={i} style={{ color: "var(--fg-muted, #a0a0b8)", paddingLeft: 8 }}>
              · {a.length > 90 ? a.slice(0, 89) + "…" : a}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function Legend({ nodes, layerCount, edgeCount }: { nodes: SeamNode[]; layerCount: number; edgeCount: number }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      fontFamily: "var(--mono, monospace)", fontSize: 8.5, color: "var(--fg-dim, #555)",
    }}>
      <span>{nodes.length} node{nodes.length !== 1 ? "s" : ""}</span>
      <span>{edgeCount} edge{edgeCount !== 1 ? "s" : ""}</span>
      <span>{layerCount} layer{layerCount !== 1 ? "s" : ""}</span>
      <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
        {(["done", "active", "backlog", "stub"] as NodeMaturity[]).map(m => (
          <span key={m} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
            <span style={{ color: MATURITY_COLOR[m], fontSize: 8 }}>●</span>
            <span>{m}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

/**
 * Hand-rolled SVG renderer for the project's dependency DAG (#294).
 * Nodes are issues; edges are `dependsOn` links; layout is topological
 * (left-to-right, sources on the left). Click a node for drill-down.
 */
export function SeamGraphView({ graph }: { graph: SeamGraph }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (graph.nodes.length === 0) return <EmptyGraph />;

  const maxLayer = Math.max(0, ...graph.nodes.map(n => n.layer));
  const maxOrder = Math.max(0, ...graph.nodes.map(n => n.order));
  const svgW = PAD + maxLayer * COL_W + NODE_W + PAD;
  const svgH = PAD + maxOrder * ROW_H + NODE_H + PAD;

  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const selectedNode = selectedId ? nodeById.get(selectedId) ?? null : null;

  function toggleNode(id: string) {
    setSelectedId(prev => prev === id ? null : id);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* Dangling-dep warning */}
      {graph.danglingCount > 0 && (
        <div style={{
          padding: "5px 9px",
          background: "oklch(0.22 0.06 55 / 0.5)",
          borderRadius: 4,
          fontFamily: "var(--mono, monospace)", fontSize: 9.5,
          color: "oklch(0.78 0.12 55)",
        }}>
          {graph.danglingCount} dangling dep{graph.danglingCount !== 1 ? "s" : ""} — dashed edges point to issues not in this plan
        </div>
      )}

      {/* SVG canvas */}
      <div style={{ overflowX: "auto", overflowY: "auto", maxHeight: 380 }}>
        <svg
          width={svgW}
          height={svgH}
          style={{ display: "block" }}
          aria-label="Dependency graph"
        >
          <defs>
            <marker id="seam-arrow" markerWidth="6" markerHeight="6" refX="5.5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L5.5,3 z" fill="var(--fg-dim, #444)" />
            </marker>
            <marker id="seam-arrow-dangle" markerWidth="6" markerHeight="6" refX="5.5" refY="3" orient="auto">
              <path d="M0,0.5 L0,5.5 L5.5,3 z" fill="oklch(0.72 0.15 55)" />
            </marker>
          </defs>

          {/* Edges rendered before nodes so nodes appear on top */}
          {graph.edges.map((e, i) => {
            const fromN = nodeById.get(e.from);
            const toN   = nodeById.get(e.to);
            if (!toN) return null;
            // Dangling edges: draw from a phantom column to the left of layer 0.
            if (e.dangling || !fromN) {
              const x2 = nx(toN.layer), y2 = ncy(toN.order);
              return (
                <path
                  key={i}
                  d={`M${Math.max(0, x2 - 28)},${y2} L${x2},${y2}`}
                  stroke="oklch(0.72 0.15 55)"
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  fill="none"
                  markerEnd="url(#seam-arrow-dangle)"
                  opacity={0.6}
                />
              );
            }
            return <EdgePath key={i} fromNode={fromN} toNode={toN} dangling={false} />;
          })}

          {/* Nodes */}
          {graph.nodes.map(n => (
            <NodeRect
              key={n.id}
              node={n}
              selected={n.id === selectedId}
              onClick={() => toggleNode(n.id)}
            />
          ))}
        </svg>
      </div>

      {/* Drill-down panel (shown when a node is selected) */}
      {selectedNode && (
        <DrillDown node={selectedNode} onClose={() => setSelectedId(null)} />
      )}

      {/* Footer legend */}
      <Legend nodes={graph.nodes} layerCount={graph.layerCount} edgeCount={graph.edges.length} />
    </div>
  );
}
