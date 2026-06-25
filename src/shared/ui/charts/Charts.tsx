// Shared analytics chart primitives (#399), ported from
// design/fleet-github-skills/js/charts.jsx. On-brand viewBox-based SVG charts
// tuned to the token system, with optional hover tooltips (see useTip). Used by
// the Fleet and (later) Repo Pulse analytics pages.
import type { ReactNode } from "react";

/** Hover-tooltip controller handle (see {@link useTip}). */
export interface ChartTip {
  show: (x: number, y: number, content: ReactNode) => void;
  hide: () => void;
}

// ── multi-series line / area ────────────────────────────────────────────────
export interface LineSeries {
  name: string;
  color: string;
  data: number[];
  width?: number;
  dash?: string;
  dots?: boolean;
  fill?: boolean;
  dotR?: number;
}
interface LineAreaProps {
  series: LineSeries[];
  labels: string[];
  height?: number;
  yMax?: number;
  area?: boolean;
  fmtY?: (v: number) => ReactNode;
  tip?: ChartTip;
}
export function LineArea({ series, labels, height = 150, yMax, area = true, fmtY = (v) => v, tip }: LineAreaProps) {
  const W = 720, H = height, PAD = { l: 34, r: 14, t: 12, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = labels.length;
  const max = yMax ?? Math.max(1, ...series.flatMap(s => s.data));
  const x = (i: number) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v: number) => PAD.t + (1 - v / max) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(max * t));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} onMouseLeave={() => tip?.hide()}>
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="var(--border-soft)" strokeDasharray="2 3" />
          <text x={PAD.l - 5} y={y(v) + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{fmtY(v)}</text>
        </g>
      ))}
      {labels.map((l, i) => i % Math.ceil(n / 8 || 1) === 0 && (
        <text key={i} x={x(i)} y={H - PAD.b + 13} textAnchor="middle" fontFamily="var(--mono)" fontSize="8.5" fill="var(--fg-dim)">{l}</text>
      ))}
      {series.map((s, si) => {
        const line = s.data.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`).join(" ");
        const fillPath = `${line} L ${x(n - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;
        const show = (e: React.MouseEvent, i: number) =>
          tip?.show(e.clientX, e.clientY, <span><b style={{ color: s.color }}>{s.name}</b> · {labels[i]} · {fmtY(s.data[i])}</span>);
        return (
          <g key={si}>
            {area && s.fill !== false && <path d={fillPath} fill={s.color} opacity="0.12" />}
            <path d={line} fill="none" stroke={s.color} strokeWidth={s.width ?? 2} strokeDasharray={s.dash ?? "0"} strokeLinejoin="round" strokeLinecap="round" />
            {s.dots !== false && s.data.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={s.dotR ?? 2.4} fill={s.color}
                style={{ cursor: tip ? "pointer" : "default" }}
                onMouseEnter={(e) => show(e, i)} onMouseMove={(e) => show(e, i)} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ── grouped / stacked bars ──────────────────────────────────────────────────
export interface BarGroup { name: string; color: string; data: number[] }
interface BarsProps {
  groups: BarGroup[];
  labels: string[];
  height?: number;
  stacked?: boolean;
  fmtY?: (v: number) => ReactNode;
  tip?: ChartTip;
}
export function Bars({ groups, labels, height = 130, stacked = false, fmtY = (v) => v, tip }: BarsProps) {
  const W = 720, H = height, PAD = { l: 30, r: 12, t: 10, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = labels.length;
  const seriesCount = groups.length;
  const max = stacked
    ? Math.max(1, ...labels.map((_, i) => groups.reduce((s, g) => s + g.data[i], 0)))
    : Math.max(1, ...groups.flatMap(g => g.data));
  const slot = iw / n;
  const y = (v: number) => PAD.t + (1 - v / max) * ih;
  const bw = stacked ? Math.min(26, slot * 0.5) : Math.min(13, (slot * 0.7) / seriesCount);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} onMouseLeave={() => tip?.hide()}>
      {[0, 0.5, 1].map((t, i) => {
        const v = Math.round(max * t);
        return <g key={i}><line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="var(--border-soft)" strokeDasharray="2 3" />
          <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{fmtY(v)}</text></g>;
      })}
      {labels.map((lab, i) => {
        const cx = PAD.l + slot * i + slot / 2;
        return (
          <g key={i}>
            {groups.map((g, gi) => {
              const v = g.data[i];
              const h = (v / max) * ih;
              // Stacked offset = sum of preceding groups at this label (no mutation).
              const below = groups.slice(0, gi).reduce((a, gg) => a + gg.data[i], 0);
              let bx: number, by: number;
              if (stacked) { bx = cx - bw / 2; by = y(below + v); }
              else { bx = cx - (bw * seriesCount + 2 * (seriesCount - 1)) / 2 + gi * (bw + 2); by = y(v); }
              return <rect key={gi} x={bx} y={by} width={bw} height={Math.max(0, h)} rx="1.5" fill={g.color}
                style={{ cursor: tip ? "pointer" : "default" }}
                onMouseMove={(e) => tip?.show(e.clientX, e.clientY, <span><b style={{ color: g.color }}>{g.name}</b> · {lab} · {fmtY(v)}</span>)} />;
            })}
            <text x={cx} y={H - PAD.b + 13} textAnchor="middle" fontFamily="var(--mono)" fontSize="8.5" fill="var(--fg-dim)">{lab}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── donut / gauge ───────────────────────────────────────────────────────────
export interface DonutSlice { name: string; value: number; color: string }
interface DonutProps { slices: DonutSlice[]; size?: number; thickness?: number; center?: { value: ReactNode; label: string } }
export function Donut({ slices, size = 132, thickness = 16, center }: DonutProps) {
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-elev2)" strokeWidth={thickness} />
      {slices.map((s, i) => {
        const frac = s.value / total;
        const dash = frac * C;
        // Cumulative offset of preceding slices (no render-time mutation).
        const before = slices.slice(0, i).reduce((a, x) => a + x.value, 0) / total;
        return <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color}
          strokeWidth={thickness} strokeDasharray={`${dash} ${C - dash}`}
          strokeDashoffset={-before * C} transform={`rotate(-90 ${cx} ${cy})`}><title>{s.name}: {s.value}</title></circle>;
      })}
      {center && <>
        <text x={cx} y={cy - 2} textAnchor="middle" fontFamily="var(--mono)" fontSize="20" fontWeight="700" fill="var(--fg)">{center.value}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{center.label}</text>
      </>}
    </svg>
  );
}

// ── horizontal bars (ranked) ─────────────────────────────────────────────────
export interface HBarRow {
  label: string;
  value: number;
  color?: string;
  strong?: boolean;
  icon?: ReactNode;
  tag?: ReactNode;
}
interface HBarsProps { rows: HBarRow[]; fmtV?: (v: number) => ReactNode; max?: number }
export function HBars({ rows, fmtV = (v) => v, max: maxOverride }: HBarsProps) {
  const max = maxOverride ?? Math.max(1, ...rows.map(r => r.value));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
      {rows.map((r, i) => (
        <div key={i} className="hrow" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 46px", gap: 10, alignItems: "center", padding: "1px 2px", borderRadius: 4 }}>
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

// ── swimlane / activity timeline ─────────────────────────────────────────────
export interface SwimLane { name: string; color?: string }
export interface SwimEvent { lane: number; t0: number; t1?: number; color: string; label: string; r?: number }
export interface SwimMark { t: number; label: string }
interface SwimlaneProps { lanes: SwimLane[]; events: SwimEvent[]; height?: number; tip?: ChartTip; marks?: SwimMark[] }
export function Swimlane({ lanes, events, height = 26, tip, marks = [] }: SwimlaneProps) {
  const W = 720, laneH = height, top = 16, left = 96, right = 14;
  const iw = W - left - right;
  const H = top + lanes.length * laneH + 6;
  const xt = (t: number) => left + t * iw;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} onMouseLeave={() => tip?.hide()}>
      {marks.map((m, i) => (
        <g key={`mk${i}`}>
          <line x1={xt(m.t)} y1={top - 4} x2={xt(m.t)} y2={H - 4} stroke="var(--border-soft)" strokeDasharray="2 4" />
          <text x={xt(m.t)} y={top - 6} textAnchor="middle" fontFamily="var(--mono)" fontSize="8" fill="var(--fg-dim)">{m.label}</text>
        </g>
      ))}
      {lanes.map((ln, li) => {
        const cy = top + li * laneH + laneH / 2;
        return (
          <g key={li}>
            <text x={left - 8} y={cy + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9.5" fill={ln.color ?? "var(--fg-muted)"}>{ln.name}</text>
            <line x1={left} y1={cy} x2={W - right} y2={cy} stroke="var(--border-soft)" strokeWidth="1" />
          </g>
        );
      })}
      {events.map((e, i) => {
        const cy = top + e.lane * laneH + laneH / 2;
        if (e.t1 != null) {
          const x0 = xt(e.t0), x1 = xt(e.t1);
          return <rect key={i} x={x0} y={cy - 4} width={Math.max(3, x1 - x0)} height={8} rx="3" fill={e.color} opacity="0.85"
            style={{ cursor: tip ? "pointer" : "default" }}
            onMouseMove={(ev) => tip?.show(ev.clientX, ev.clientY, <span>{e.label}</span>)} />;
        }
        return <circle key={i} cx={xt(e.t0)} cy={cy} r={e.r ?? 4} fill={e.color} stroke="var(--bg-panel)" strokeWidth="1.5"
          style={{ cursor: tip ? "pointer" : "default" }}
          onMouseMove={(ev) => tip?.show(ev.clientX, ev.clientY, <span>{e.label}</span>)} />;
      })}
    </svg>
  );
}

// ── inline sparkline ─────────────────────────────────────────────────────────
interface SparkProps { data: number[]; color: string; w?: number; h?: number }
export function Spark({ data, color, w = 70, h = 20 }: SparkProps) {
  const max = Math.max(1, ...data), min = Math.min(...data);
  const span = max - min || 1;
  const x = (i: number) => (i / (data.length - 1)) * w;
  const y = (v: number) => h - 2 - ((v - min) / span) * (h - 4);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block" }}>
      <path d={`${line} L ${w} ${h} L 0 ${h} Z`} fill={color} opacity="0.13" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(data.length - 1)} cy={y(data[data.length - 1])} r="2" fill={color} />
    </svg>
  );
}

// ── legend ──────────────────────────────────────────────────────────────────
export interface LegendItem { color: string; label: string; value?: ReactNode }
export function Legend({ items, style }: { items: LegendItem[]; style?: React.CSSProperties }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", ...style }}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 9, height: 9, borderRadius: 2, background: it.color, display: "inline-block" }} />
          {it.label}{it.value != null && <b style={{ color: "var(--fg)" }}>{it.value}</b>}
        </span>
      ))}
    </div>
  );
}
