/* global React, useTip */
// On-brand SVG chart primitives, tuned to the base-studio-code token system.
// All charts are viewBox-based (width:100%) with optional hover tooltips.

const { useState: _useState, useMemo: _useMemo } = React;

// ── multi-series line / area ────────────────────────────────────────────────
function LineArea({ series, labels, height = 150, yMax, area = true, fmtY = (v) => v, tip }) {
  const W = 720, H = height, PAD = { l: 34, r: 14, t: 12, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = labels.length;
  const max = yMax ?? Math.max(1, ...series.flatMap(s => s.data));
  const x = (i) => PAD.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => PAD.t + (1 - v / max) * ih;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(max * t));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}
      onMouseLeave={() => tip?.hide()}>
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
        return (
          <g key={si}>
            {area && s.fill !== false && <path d={fillPath} fill={s.color} opacity="0.12" />}
            <path d={line} fill="none" stroke={s.color} strokeWidth={s.width ?? 2}
              strokeDasharray={s.dash ?? "0"} strokeLinejoin="round" strokeLinecap="round" />
            {s.dots !== false && s.data.map((v, i) => (
              <circle key={i} cx={x(i)} cy={y(v)} r={s.dotR ?? 2.4} fill={s.color}
                style={{ cursor: tip ? "pointer" : "default" }}
                onMouseEnter={(e) => tip?.show(e.clientX, e.clientY, <span><b style={{ color: s.color }}>{s.name}</b> · {labels[i]} · {fmtY(v)}</span>)}
                onMouseMove={(e) => tip?.show(e.clientX, e.clientY, <span><b style={{ color: s.color }}>{s.name}</b> · {labels[i]} · {fmtY(v)}</span>)}
              />
            ))}
          </g>
        );
      })}
    </svg>
  );
}

// ── grouped / stacked bars ──────────────────────────────────────────────────
function Bars({ groups, labels, height = 130, stacked = false, fmtY = (v) => v, tip }) {
  const W = 720, H = height, PAD = { l: 30, r: 12, t: 10, b: 22 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const n = labels.length;
  const seriesCount = groups.length;
  const max = stacked
    ? Math.max(1, ...labels.map((_, i) => groups.reduce((s, g) => s + g.data[i], 0)))
    : Math.max(1, ...groups.flatMap(g => g.data));
  const slot = iw / n;
  const y = (v) => PAD.t + (1 - v / max) * ih;
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
        let stackY = 0;
        return (
          <g key={i}>
            {groups.map((g, gi) => {
              const v = g.data[i];
              const h = (v / max) * ih;
              let bx, by;
              if (stacked) { bx = cx - bw / 2; by = y(stackY + v); stackY += v; }
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
function Donut({ slices, size = 132, thickness = 16, center }) {
  const r = (size - thickness) / 2, cx = size / 2, cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = slices.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--bg-elev2)" strokeWidth={thickness} />
      {slices.map((s, i) => {
        const frac = s.value / total;
        const dash = frac * C;
        const el = <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={s.color}
          strokeWidth={thickness} strokeDasharray={`${dash} ${C - dash}`}
          strokeDashoffset={-acc * C} transform={`rotate(-90 ${cx} ${cy})`}>
            <title>{s.name}: {s.value}</title></circle>;
        acc += frac;
        return el;
      })}
      {center && <>
        <text x={cx} y={cy - 2} textAnchor="middle" fontFamily="var(--mono)" fontSize="20" fontWeight="700" fill="var(--fg)">{center.value}</text>
        <text x={cx} y={cy + 14} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{center.label}</text>
      </>}
    </svg>
  );
}

// ── horizontal bars (ranked) ─────────────────────────────────────────────────
function HBars({ rows, fmtV = (v) => v, max: maxOverride, height = 22 }) {
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
// lanes: [{name,color}], events: [{lane, t0, t1?, kind, color, label}], span [0,1] of width
function Swimlane({ lanes, events, height = 26, fmtT, tip, marks = [] }) {
  const W = 720, laneH = height, top = 16, left = 96, right = 14;
  const iw = W - left - right;
  const H = top + lanes.length * laneH + 6;
  const xt = (t) => left + t * iw;
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
        return <circle key={i} cx={xt(e.t0)} cy={cy} r={e.r ?? 4} fill={e.color}
          stroke="var(--bg-panel)" strokeWidth="1.5"
          style={{ cursor: tip ? "pointer" : "default" }}
          onMouseMove={(ev) => tip?.show(ev.clientX, ev.clientY, <span>{e.label}</span>)} />;
      })}
    </svg>
  );
}

// ── heatmap grid (day x hour or generic) ─────────────────────────────────────
function Heat({ cols, rows, values, color = "var(--accent)", fmtCell, tip }) {
  // values: 2D [rows][cols], 0..1 normalized intensity carried separately via norm
  const max = Math.max(1, ...values.flat().map(v => v.v));
  return (
    <div style={{ display: "grid", gridTemplateColumns: `34px repeat(${cols.length}, 1fr)`, gap: 3, alignItems: "center" }}>
      <div />
      {cols.map((c, i) => <div key={i} style={{ fontFamily: "var(--mono)", fontSize: 8.5, color: "var(--fg-dim)", textAlign: "center" }}>{c}</div>)}
      {rows.map((rlab, ri) => (
        <React.Fragment key={ri}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--fg-dim)", textAlign: "right", paddingRight: 4 }}>{rlab}</div>
          {cols.map((_, ci) => {
            const cell = values[ri][ci];
            const t = cell.v / max;
            const a = cell.v === 0 ? 0 : 0.16 + 0.78 * t;
            return <div key={ci} title={fmtCell ? fmtCell(cell, rlab, cols[ci]) : ""}
              style={{ aspectRatio: "1.6", borderRadius: 3, border: "1px solid var(--border-soft)",
                background: cell.v === 0 ? "var(--bg-elev)" : `color-mix(in oklch, ${color} ${Math.round(a * 100)}%, var(--bg-elev))`,
                cursor: tip ? "pointer" : "default" }}
              onMouseMove={(e) => tip?.show(e.clientX, e.clientY, <span>{fmtCell ? fmtCell(cell, rlab, cols[ci]) : cell.v}</span>)}
              onMouseLeave={() => tip?.hide()} />;
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

// ── legend ──────────────────────────────────────────────────────────────────
function Legend({ items, style }) {
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

Object.assign(window, { LineArea, Bars, Donut, HBars, Swimlane, Heat, Legend });
