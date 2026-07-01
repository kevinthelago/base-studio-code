// Telemetry-tab primitives (#1826) — the framed panel + the two bar shapes the analytics tabs
// (McpAnalytics, HookAnalytics, …) were copy-pasting. Composed with the existing chart primitives
// (StatCard / StackedDayBars) each tab already uses; each tab keeps its own top-level layout and
// any bespoke bits (a results log, a legend) as local JSX, so there are no awkward optional slots.
import type { ReactNode } from "react";
import { FillBar } from "@/shared/ui/data/FillBar";

/** A framed analytics panel: `bg-panel` card + a baseline header (title · optional hint · optional
 *  right-aligned slot). The repeated `<div class card><h3>…</h3></div>` wrapper. */
export function TelemetryPanel({ title, hint, right, children }: {
  title: string;
  hint?: string;
  /** Right-aligned header content (a legend, a filter, a count) — a spacer is inserted before it. */
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h3 className="mono" style={{ margin: 0, fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>{title}</h3>
        {hint && <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>{hint}</span>}
        {right != null && <><div style={{ flex: 1 }} />{right}</>}
      </div>
      {children}
    </div>
  );
}

/** One row of {@link ItemBars}: a label · optional meta · a right-aligned value over a {@link FillBar}. */
export interface ItemBarRow {
  key: string;
  label: string;
  meta?: string;
  /** The value shown at the right of the row (formatted string or number). */
  value: ReactNode;
  /** The bar fill fraction, 0..1. */
  fraction: number;
  /** Bar color (defaults to the FillBar accent). */
  color?: string;
}

/** A vertical list of labelled `FillBar` rows (Calls-per-server, Fires-per-hook, …). */
export function ItemBars({ rows, empty }: { rows: ItemBarRow[]; empty?: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
      {rows.length === 0 && (empty ?? <span className="hint">No data recorded yet.</span>)}
      {rows.map((r) => (
        <div key={r.key}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg)" }}>{r.label}</span>
            {r.meta && <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{r.meta}</span>}
            <div style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-muted)" }}>{r.value}</span>
          </div>
          <FillBar value={r.fraction} color={r.color} />
        </div>
      ))}
    </div>
  );
}

/** A two-segment proportional bar with a label + the two counts (ok/err, allow/block, …). */
export function SplitBar({ label, a, b, aLabel, bLabel, aColor = "var(--success)", bColor = "var(--danger)" }: {
  label: string;
  a: number;
  b: number;
  aLabel: string;
  bLabel: string;
  aColor?: string;
  bColor?: string;
}) {
  const tot = Math.max(1, a + b);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
        <span className="mono" style={{ fontSize: 11, color: "var(--fg)" }}>{label}</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: aColor }}>{a} {aLabel}</span>
        <span className="mono" style={{ fontSize: 10, color: bColor }}>{b} {bLabel}</span>
      </div>
      <div style={{ height: 10, borderRadius: 99, overflow: "hidden", display: "flex", background: "var(--bg-elev2)" }}>
        <div style={{ height: "100%", width: `${(a / tot) * 100}%`, background: aColor }} />
        <div style={{ height: "100%", width: `${(b / tot) * 100}%`, background: bColor }} />
      </div>
    </div>
  );
}
