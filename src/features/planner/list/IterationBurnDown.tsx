// Iteration burn-down card (real, from the project's Projects V2 Iteration field).
// Burn-down math lives in ../github/burndown.ts; this renders the resolved series.

import { type ReactNode } from "react";
import type { BurndownResult } from "../github/burndown";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";

function BurnCard({ hint, badge, children }: {
  hint: string;
  badge?: { text: string; tone: string };
  children?: ReactNode;
}) {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row gap={10} align="baseline" style={{ marginBottom: 6 }}>
        <h3 style={{ margin: 0 }}>Iteration burn-down</h3>
        <span className="hint">{hint}</span>
        <Spacer />
        {badge && <span className="mono" style={{ fontSize: 10.5, color: badge.tone }}>● {badge.text}</span>}
      </Row>
      {children}
    </Card>
  );
}

const burnNote = (text: string): ReactNode => (
  <Text as="div" mono size={11} tone="dim" style={{ padding: "12px 0" }}>{text}</Text>
);

export function IterationBurnDown({ data, loading }: { data: BurndownResult | null; loading: boolean }) {
  if (loading && !data) return <BurnCard hint="loading…">{burnNote("loading…")}</BurnCard>;
  if (!data || data.status === "no-field")
    return <BurnCard hint="Projects V2 Iteration field">{burnNote("No Iteration field on the lead project — add one in the project's field settings to see a real burn-down.")}</BurnCard>;
  if (data.status === "no-active-iteration")
    return <BurnCard hint={data.projectTitle}>{burnNote("No active iteration right now (today is between iterations).")}</BurnCard>;

  const { series, projectTitle, iterationTitle } = data;
  if (series.total === 0)
    return <BurnCard hint={`${projectTitle} · ${iterationTitle}`}>{burnNote("No items assigned to this iteration yet.")}</BurnCard>;

  const { total, daysTotal, daysElapsed, ideal, actual, remaining, onTrack } = series;
  const W = 720, H = 180, PAD = { l: 36, r: 20, t: 14, b: 24 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (i / daysTotal) * innerW;
  const y = (v: number) => PAD.t + (1 - v / total) * innerH;
  const idealPath = ideal.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(v)}`).join(" ");
  const pts = actual.flatMap((v, i) => (v != null ? [{ v, i }] : []));
  const actualPath = pts.map((p, k) => `${k === 0 ? "M" : "L"} ${x(p.i)} ${y(p.v)}`).join(" ");
  const yTicks = [0, Math.round(total * 0.25), Math.round(total * 0.5), Math.round(total * 0.75), total];

  return (
    <BurnCard
      hint={`${projectTitle} · ${iterationTitle} · day ${daysElapsed + 1}/${daysTotal}`}
      badge={{ text: onTrack ? "on track" : "behind", tone: onTrack ? "var(--success)" : "var(--danger)" }}
    >
      <svg width={W} height={H} style={{ width: "100%", maxWidth: W, display: "block" }}>
        {yTicks.map(v => (
          <g key={v}>
            <line x1={PAD.l} y1={y(v)} x2={W - PAD.r} y2={y(v)} stroke="var(--border-soft)" strokeDasharray="2 3" />
            <text x={PAD.l - 4} y={y(v) + 3} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">{v}</text>
          </g>
        ))}
        {ideal.map((_, i) => i % 2 === 0 ? (
          <text key={i} x={x(i)} y={H - PAD.b + 12} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">d{i + 1}</text>
        ) : null)}
        <path d={idealPath} fill="none" stroke="var(--fg-dim)" strokeDasharray="3 4" strokeWidth="1.5" />
        <path d={actualPath} fill="none" stroke="var(--accent)" strokeWidth="2" />
        {pts.map(p => <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r="2.5" fill="var(--accent)" />)}
        <line x1={x(daysElapsed)} y1={PAD.t} x2={x(daysElapsed)} y2={H - PAD.b} stroke="var(--accent)" strokeDasharray="2 3" strokeWidth="1" />
        <text x={x(daysElapsed)} y={PAD.t - 3} textAnchor="middle" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">today</text>
        <text x={x(daysTotal) - 2} y={y(remaining) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--accent)">remaining · {remaining}</text>
        <text x={x(daysTotal) - 2} y={y(0) - 6} textAnchor="end" fontFamily="var(--mono)" fontSize="9" fill="var(--fg-dim)">ideal · 0</text>
      </svg>
    </BurnCard>
  );
}
