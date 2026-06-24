// Minimal SVG chart primitives used by the Skills screen, ported from
// design/fleet-github-skills/js/charts.jsx (HBars) and skillsView.jsx (Spark).
//
// These live here, scoped to the Skills screen, rather than in a shared
// src/components/charts/. The shared analytics chart library is #399 — when it
// lands, HBars should be imported from there and this file trimmed to Spark.

import type { ReactNode } from "react";

interface SparkProps {
  data: number[];
  color: string;
  w?: number;
  h?: number;
}

/** A tiny inline area+line sparkline for a skill's invocation trend. */
export function Spark({ data, color, w = 70, h = 20 }: SparkProps) {
  const max = Math.max(1, ...data);
  const min = Math.min(...data);
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * w;
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const line = data
    .map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.13" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="2" fill={color} />
    </svg>
  );
}

export interface HBarRow {
  label: string;
  value: number;
  color?: string;
  /** Render the label in full-strength foreground. */
  strong?: boolean;
  icon?: ReactNode;
  tag?: ReactNode;
}

interface HBarsProps {
  rows: HBarRow[];
  fmtV?: (v: number) => ReactNode;
  max?: number;
}

/** Ranked horizontal bars (leaderboard). */
export function HBars({ rows, fmtV = (v) => v, max: maxOverride }: HBarsProps) {
  const max = maxOverride ?? Math.max(1, ...rows.map(r => r.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((r, i) => (
        <div
          key={i}
          className="hrow"
          style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 46px", gap: 10, alignItems: "center", padding: "1px 2px", borderRadius: 4 }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>
              {r.icon}
              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: r.strong ? "var(--fg)" : undefined }}>{r.label}</span>
              {r.tag}
            </div>
            <div className="meter" style={{ height: 6 }}>
              <i style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? "var(--accent)" }} />
            </div>
          </div>
          <div style={{ textAlign: "right", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{fmtV(r.value)}</div>
        </div>
      ))}
    </div>
  );
}
