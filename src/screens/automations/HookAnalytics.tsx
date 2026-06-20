import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "../../lib/session/hookTelemetry";

// Hook Analytics tab (#865 PR 2) — KPI cards + 3 charts over the hook-fire telemetry
// (~/.base-studio-code/hooks.log via read_hook_log + hookTelemetry.ts). Charts are hand-rolled
// inline SVG (the house style; cf. Insights.tsx). `activeHooks`/`preCount` come from the live
// store (enabled hooks); the rest from the parsed log. Empty until the hook wrappers emit
// fires (PR 3) — renders a clean zero state.

const DAYS = 14;

function Kpi({ label, value, sub, color }: { label: string; value: React.ReactNode; sub: string; color?: string }) {
  return (
    <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "10px 14px" }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{label}</div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 20, fontWeight: 600, color: color ?? "var(--fg)", marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
    </div>
  );
}

export function HookAnalyticsTab() {
  const enabledHooks = useAppStore(s => s.hooks.filter(e => e.enabled));
  const activeHooks = enabledHooks.length;
  const preCount = enabledHooks.filter(h => h.event === "PreToolUse").length;

  const [an, setAn] = useState<HookAnalytics | null>(null);
  useEffect(() => {
    let cancelled = false;
    invoke<string[]>("read_hook_log", { limit: 8000 })
      .then(lines => { if (!cancelled) setAn(aggregateHookTelemetry(parseHookLog((lines ?? []).join("\n")), new Date(), DAYS)); })
      .catch(() => { if (!cancelled) setAn(aggregateHookTelemetry([], new Date(), DAYS)); });
    return () => { cancelled = true; };
  }, []);

  if (!an) return <div className="hint" style={{ padding: 16 }}>Loading hook telemetry…</div>;

  // ── Fires-over-time chart geometry (stacked allow/block bars) ──
  const W = 600, H = 160, x0 = 30, baseY = 140, topY = 12;
  const maxTotal = Math.max(1, ...an.daily.map(d => d.allows + d.blocks));
  const bw = (W - x0 - 10) / DAYS;
  const scaleY = (v: number) => (v / maxTotal) * (baseY - topY);
  const gridVals = [0, Math.ceil(maxTotal / 2), maxTotal];

  const maxHookFires = Math.max(1, ...an.perHook.map(h => h.fires));

  return (
    <div style={{ padding: "4px 0 12px" }}>
      {/* KPI cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 8, marginBottom: 12 }}>
        <Kpi label="Total fires" value={an.total} sub={`last ${DAYS} days`} />
        <Kpi label="Blocks" value={an.blocks} sub="PreToolUse denied" color="var(--danger)" />
        <Kpi label="Allow rate" value={`${an.allowRate}%`} sub={`${an.allows} allowed`} color="var(--success)" />
        <Kpi label="Active hooks" value={activeHooks} sub={`${preCount} PreToolUse`} />
      </div>

      {/* Fires over time */}
      <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Fires over time</h3>
          <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>daily hook fires · allow vs block</span>
          <div style={{ flex: 1 }} />
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--accent)" }} />allow</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}><span style={{ width: 9, height: 9, borderRadius: 2, background: "var(--danger)" }} />block</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block", fontFamily: "var(--mono)" }}>
          {gridVals.map((v, i) => {
            const y = baseY - scaleY(v);
            return (
              <g key={i}>
                <line x1={x0} y1={y} x2={W - 8} y2={y} stroke="var(--border-soft)" strokeWidth={1} />
                <text x={x0 - 6} y={y + 3} textAnchor="end" fill="var(--fg-dim)" fontSize={9}>{v}</text>
              </g>
            );
          })}
          {an.daily.map((d, i) => {
            const x = x0 + 4 + i * bw;
            const w = bw - 5;
            const hBlock = scaleY(d.blocks);
            const hAllow = scaleY(d.allows);
            const yBlock = baseY - hBlock;
            const yAllow = yBlock - hAllow;
            const showLabel = i % 3 === 0;
            return (
              <g key={i}>
                {hBlock > 0 && <rect x={x} y={yBlock} width={w} height={hBlock} rx={2} fill="var(--danger)" />}
                {hAllow > 0 && <rect x={x} y={yAllow} width={w} height={hAllow} rx={2} fill="var(--accent)" />}
                {showLabel && <text x={x + w / 2} y={152} textAnchor="middle" fill="var(--fg-dim)" fontSize={8.5}>{d.day.slice(5)}</text>}
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {/* Fires per hook */}
        <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Fires per hook</h3>
            <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>by event · matcher</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
            {an.perHook.length === 0 && <span className="hint">No hook fires recorded yet.</span>}
            {an.perHook.map(h => (
              <div key={h.hook}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{h.hook}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{h.event}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>{h.fires}</span>
                </div>
                <div style={{ height: 8, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${(h.fires / maxHookFires) * 100}%`, background: "var(--accent)", borderRadius: 99 }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Blocks vs allows */}
        <div style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "14px 16px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
            <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)", fontWeight: 600 }}>Blocks vs allows</h3>
            <span style={{ fontSize: 10.5, color: "var(--fg-dim)" }}>PreToolUse hooks only</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {an.perPreHook.length === 0 && <span className="hint">No PreToolUse decisions yet.</span>}
            {an.perPreHook.map(p => {
              const tot = Math.max(1, p.allows + p.blocks);
              return (
                <div key={p.hook}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 5 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{p.hook}</span>
                    <div style={{ flex: 1 }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--success)" }}>{p.allows} allow</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--danger)" }}>{p.blocks} block</span>
                  </div>
                  <div style={{ height: 10, borderRadius: 99, overflow: "hidden", display: "flex", background: "var(--bg-elev2)" }}>
                    <div style={{ height: "100%", width: `${(p.allows / tot) * 100}%`, background: "var(--success)" }} />
                    <div style={{ height: "100%", width: `${(p.blocks / tot) * 100}%`, background: "var(--danger)" }} />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>~/.base-studio-code/hooks.log</span> via <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>hookTelemetry.ts</span> — one line per fire (ts · event · hook · outcome).
          </div>
        </div>
      </div>
    </div>
  );
}
