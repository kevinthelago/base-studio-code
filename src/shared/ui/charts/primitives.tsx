// Shared analytics card + control primitives (#399), ported from
// design/fleet-github-skills/js/shell.jsx. Used alongside the SVG charts on the
// Fleet / Repo Pulse analytics pages.
import { useState, useCallback, type ReactNode, type CSSProperties } from "react";
import type { ChartTip } from "./Charts";
import { loginColor } from "@/shared/lib/core/format";

/** Compact number formatter (e.g. 1234 → "1.2k", 12000 → "12k"). */
export function fmt(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n);
}

export type StatTone = "fg" | "accent" | "info" | "success" | "danger";
interface StatCardProps {
  k: string;
  v: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  delta?: { dir: "up" | "down" | "flat"; text: string };
}
export function StatCard({ k, v, sub, tone, delta }: StatCardProps) {
  const color =
    tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" :
    tone === "success" ? "var(--success)" : tone === "danger" ? "var(--danger)" : "var(--fg)";
  return (
    <div className="card statcard">
      <div className="k">{k}</div>
      <div className="v" style={{ color }}>{v}</div>
      <div className="sub">
        {delta && <span className={`delta ${delta.dir}`}>{delta.dir === "up" ? "▲" : delta.dir === "down" ? "▼" : "■"} {delta.text}</span>}
        {sub}
      </div>
    </div>
  );
}

/** A compact KPI card (mono uppercase label · large value · sub) used on the Mcp/Hook
 *  analytics tabs. Distinct from StatCard (which uses the .statcard class + delta chip). */
export function Kpi({ label, value, sub, color }: { label: string; value: ReactNode; sub: string; color?: string }) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: color ?? "var(--fg)", marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

export function CardHead({ title, hint, right }: { title: string; hint?: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
      <h3 style={{ margin: 0 }}>{title}</h3>
      {hint && <span className="hint">{hint}</span>}
      <div style={{ flex: 1 }} />
      {right}
    </div>
  );
}

/** Time-range segmented control. */
export function RangeToggle({ value, onChange, options = ["7d", "14d", "30d"] }: {
  value: string;
  onChange: (v: string) => void;
  options?: string[];
}) {
  return (
    <div className="seg">
      {options.map(o => (
        <button key={o} className={o === value ? "on" : ""} onClick={() => onChange(o)}>{o}</button>
      ))}
    </div>
  );
}

/** A small agent/user avatar; `bot` renders a rounded-square agent glyph. */
export function Avatar({ login, size = 20, bot = false }: { login: string; size?: number; bot?: boolean }) {
  const color = bot ? "oklch(0.78 0.14 70)" : loginColor(login);
  return (
    <span title={login} style={{
      width: size, height: size, borderRadius: bot ? size * 0.28 : "50%",
      background: color, color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * 0.46,
      display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      {bot ? "◆" : (login.replace(/^@/, "")[0]?.toUpperCase() ?? "?")}
    </span>
  );
}

/** A lightweight hover-tooltip controller for the charts. Render `node` once
 *  near the page root; pass the handle to a chart's `tip` prop. */
export function useTip(): ChartTip & { node: ReactNode } {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const show = useCallback((x: number, y: number, content: ReactNode) => setTip({ x, y, content }), []);
  const hide = useCallback(() => setTip(null), []);
  const tipStyle: CSSProperties = tip
    ? { left: tip.x, top: tip.y, transform: "translate(-50%,-120%)" }
    : {};
  const node = tip ? <div className="chart-tip" style={tipStyle}>{tip.content}</div> : null;
  return { show, hide, node };
}
