import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { parseHookLog, aggregateHookTelemetry, type HookAnalytics } from "@/features/mcp/lib/hookTelemetry";
import { StatCard, StackedDayBars, TelemetryPanel, ItemBars, SplitBar } from "@/shared/ui/charts";

// Hook Analytics tab (#865 PR 2) — KPI cards + 3 charts over the hook-fire telemetry
// (~/.base-studio-code/hooks.log via read_hook_log + hookTelemetry.ts). The over-time chart + KPI
// cards are shared primitives (StackedDayBars / StatCard); the per-hook/results charts stay local.
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
        <StatCard k="Total fires" v={an.total} sub={`last ${DAYS} days`} />
        <StatCard k="Blocks" v={an.blocks} sub="PreToolUse denied" tone="danger" />
        <StatCard k="Allow rate" v={`${an.allowRate}%`} sub={`${an.allows} allowed`} tone="success" />
        <StatCard k="Active hooks" v={activeHooks} sub={`${preCount} PreToolUse`} />
      </div>

      {/* Fires over time */}
      <StackedDayBars
        data={an.daily.map(d => ({ day: d.day, upper: d.allows, lower: d.blocks }))}
        title="Fires over time" subtitle="daily hook fires · allow vs block"
        upperLabel="allow" lowerLabel="block"
      />

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        {/* Fires per hook */}
        <TelemetryPanel title="Fires per hook" hint="by event · matcher">
          <ItemBars
            rows={an.perHook.map(h => ({ key: h.hook, label: h.hook, meta: h.event, value: h.fires, fraction: h.fires / maxHookFires }))}
            empty={<span className="hint">No hook fires recorded yet.</span>}
          />
        </TelemetryPanel>

        {/* Blocks vs allows */}
        <TelemetryPanel title="Blocks vs allows" hint="PreToolUse hooks only">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {an.perPreHook.length === 0 && <span className="hint">No PreToolUse decisions yet.</span>}
            {an.perPreHook.map(p => (
              <SplitBar key={p.hook} label={p.hook} a={p.allows} b={p.blocks} aLabel="allow" bLabel="block" />
            ))}
          </div>
          <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--border-soft)", fontSize: 10.5, color: "var(--fg-dim)", lineHeight: 1.5 }}>
            Parsed from <span className="mono" style={{ color: "var(--fg-muted)" }}>~/.base-studio-code/hooks.log</span> via <span className="mono" style={{ color: "var(--fg-muted)" }}>hookTelemetry.ts</span> — one line per fire (ts · event · hook · outcome).
          </div>
        </TelemetryPanel>
      </div>
    </div>
  );
}
