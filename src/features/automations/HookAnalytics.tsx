import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "@/features/mcp/lib/hookTelemetry";
import { Kpi, StackedDayBars } from "@/shared/ui/charts";

// Hook Analytics tab (#865 PR 2) — KPI cards + 3 charts over the hook-fire telemetry
// (~/.base-studio-code/hooks.log via read_hook_log + hookTelemetry.ts). The over-time chart + KPI
// cards are shared primitives (StackedDayBars / Kpi); the per-hook/results charts stay local.
// `activeHooks`/`preCount` come from the live store (enabled hooks); the rest from the parsed log.
// Empty until the hook wrappers emit fires (PR 3) — renders a clean zero state.

const DAYS = 14;

export function HookAnalyticsTab() {
  // Select the raw array (stable ref) and derive in a memo — a selector returning
  // `.filter()` makes a new array every call, which loops forever in zustand v5.
  const hooks = useAppStore(s => s.hooks);
  const enabledHooks = useMemo(() => hooks.filter(e => e.enabled), [hooks]);
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
      <StackedDayBars
        data={an.daily.map(d => ({ day: d.day, upper: d.allows, lower: d.blocks }))}
        title="Fires over time" subtitle="daily hook fires · allow vs block"
        upperLabel="allow" lowerLabel="block"
      />

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
