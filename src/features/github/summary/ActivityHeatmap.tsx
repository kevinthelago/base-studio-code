// Activity heatmap card — 28-week × 7-day contribution calendar (#1644).

import { useState } from "react";
import { heatFill } from "../heatFill";
import { formatHeatDate } from "../lib/githubSummary";

export function ActivityHeatmap({
  cells, rawCounts, rawDates, totalContribs, totalMerged, loading,
}: {
  cells: number[];
  rawCounts: number[];
  rawDates: string[];
  totalContribs: number;
  totalMerged: number;
  loading: boolean;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const cols = 28, rows = 7;
  const cell = 12, gap = 3;
  const W = cols * cell + (cols - 1) * gap;
  const H = rows * cell + (rows - 1) * gap;
  const svgW = W + 30, svgH = H + 8;

  const tooltip = hoveredIdx !== null ? (() => {
    const c = Math.floor(hoveredIdx / rows);
    const r = hoveredIdx % rows;
    const count = rawCounts[hoveredIdx] ?? 0;
    const date = rawDates[hoveredIdx] ?? "";
    const label = date
      ? (count === 0 ? `No activity · ${formatHeatDate(date)}` : `${count} contribution${count !== 1 ? "s" : ""} · ${formatHeatDate(date)}`)
      : null;
    if (!label) return null;
    const tipW = 152, tipH = 16;
    const cellCx = 30 + c * (cell + gap) + cell / 2;
    const cellTop = r * (cell + gap) + 4;
    const tipX = Math.max(0, Math.min(svgW - tipW, cellCx - tipW / 2));
    const above = r >= 2;
    const tipY = above ? cellTop - tipH - 4 : cellTop + cell + 4;
    return { label, tipX, tipY, tipW, tipH };
  })() : null;

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Activity · last 28 weeks</h3>
        <span className="hint">all contributions · GitHub calendar</span>
        <div style={{ flex: 1 }} />
        <span style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
          less
          {[0, 0.25, 0.5, 0.75, 1].map((v, i) => (
            <span key={i} style={{ width: 10, height: 10, borderRadius: 2, display: "inline-block", background: heatFill(v) }} />
          ))}
          more
        </span>
      </div>
      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ display: "block", width: "100%", overflow: "visible" }}>
        {["Mon", "", "Wed", "", "Fri", "", ""].map((d, i) => (
          <text key={i} x={0} y={4 + i * (cell + gap) + cell / 2}
            dominantBaseline="middle"
            fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{d}</text>
        ))}
        {cells.map((v, i) => {
          const c = Math.floor(i / rows), r = i % rows;
          return (
            <rect key={i}
              x={30 + c * (cell + gap)} y={r * (cell + gap) + 4}
              width={cell} height={cell} rx={2}
              fill={heatFill(v)}
              style={{ cursor: "default" }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            />
          );
        })}
        {tooltip && (
          <g pointerEvents="none">
            <rect x={tooltip.tipX} y={tooltip.tipY} width={tooltip.tipW} height={tooltip.tipH} rx={3}
              fill="var(--bg-panel)" stroke="var(--border-soft)" strokeWidth="0.8" />
            <text x={tooltip.tipX + tooltip.tipW / 2} y={tooltip.tipY + tooltip.tipH / 2}
              dominantBaseline="middle" textAnchor="middle"
              fontFamily="var(--mono)" fontSize="8.5" fill="var(--fg)">
              {tooltip.label}
            </text>
          </g>
        )}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)", paddingLeft: 30 }}>
        <span>28 weeks ago</span><span>today</span>
      </div>
      <div style={{ display: "flex", gap: 24, marginTop: 12, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
        <span><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalContribs}</b> contributions</span>
        <span><b style={{ color: "var(--fg)" }}>{loading ? "…" : totalMerged}</b> PRs merged</span>
      </div>
    </div>
  );
}
