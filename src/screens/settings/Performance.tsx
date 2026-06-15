import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { PerfConfig } from "../../store";

// ── Reusable atoms ─────────────────────────────────────────────────────────────

function Toggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <span
      onClick={onToggle}
      style={{
        display: "inline-flex", alignItems: "center",
        width: 32, height: 18, borderRadius: 99, cursor: "pointer",
        background: on ? "var(--accent)" : "var(--bg-elev2)",
        border: "1px solid " + (on ? "transparent" : "var(--border)"),
        transition: "background 0.15s",
        flex: "0 0 auto",
      }}
    >
      <span style={{
        width: 12, height: 12, borderRadius: "50%",
        background: on ? "#1a120a" : "var(--fg-dim)",
        marginLeft: on ? "auto" : 2,
        marginRight: on ? 2 : "auto",
        transition: "margin 0.15s",
      }} />
    </span>
  );
}

function ConfirmButton({ label, armedLabel, onConfirm, danger = true }: {
  label: string; armedLabel: string; onConfirm: () => void | Promise<void>; danger?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else { setArmed(true); } }}
      onBlur={() => setArmed(false)}
      style={{
        alignSelf: "flex-start",
        padding: "8px 14px", borderRadius: 6, cursor: "pointer",
        fontFamily: "var(--mono)", fontSize: 11.5,
        background: armed && danger ? "var(--danger)" : "var(--bg-elev)",
        color: armed && danger ? "var(--bg-canvas)" : danger ? "var(--danger)" : "var(--fg)",
        border: "1px solid " + (armed && danger
          ? "var(--danger)"
          : danger ? "color-mix(in oklch, var(--danger), transparent 55%)" : "var(--border)"),
      }}
    >{armed ? armedLabel : label}</button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {hint && <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Select({ value, options, onChange }: {
  value: number | string;
  options: { label: string; value: number | string }[];
  onChange: (v: number | string) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(typeof value === "number" ? Number(raw) : raw);
      }}
      style={{
        fontFamily: "var(--mono)", fontSize: 11.5,
        background: "var(--bg-elev)", color: "var(--fg)",
        border: "1px solid var(--border)", borderRadius: 6,
        padding: "5px 8px", cursor: "pointer",
      }}
    >
      {options.map(o => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function PerformanceSettings() {
  const { perfConfig, setPerfConfig } = useAppStore();
  const idleReaper = useAppStore((s) => s.idleReaper);
  const setIdleReaperConfig = useAppStore((s) => s.setIdleReaperConfig);
  const MIN = 60_000;
  const [clearStatus, setClearStatus] = useState<"idle" | "ok" | "err">("idle");

  const update = (patch: Partial<PerfConfig>) => {
    setPerfConfig({ ...perfConfig, ...patch });
  };

  const clearHistory = async () => {
    try {
      await invoke("perf_clear_history");
      setClearStatus("ok");
      setTimeout(() => setClearStatus("idle"), 2000);
    } catch {
      setClearStatus("err");
      setTimeout(() => setClearStatus("idle"), 2000);
    }
  };

  return (
    <div style={{ maxWidth: 640, display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 16, color: "var(--fg)", marginBottom: 6 }}>Performance</div>
        <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>
          Track per-agent resource usage (RSS, CPU) and frontend metrics (heap, jank). Samples
          persist to a local SQLite database so you can spot memory leaks as an upward slope
          over time, not just a point-in-time number.
        </div>
      </div>

      <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px" }}>
        <Row
          label="Enable metrics collection"
          hint="Disabling stops sampling and stops writing new rows; existing history is kept."
        >
          <Toggle on={perfConfig.enabled} onToggle={() => update({ enabled: !perfConfig.enabled })} />
        </Row>

        <Row
          label="Sampling interval"
          hint="How often to capture a snapshot of each agent's RSS and CPU usage."
        >
          <Select
            value={perfConfig.intervalSecs}
            options={[
              { label: "Off", value: 0 },
              { label: "1 s", value: 1 },
              { label: "2 s (default)", value: 2 },
              { label: "5 s", value: 5 },
            ]}
            onChange={(v) => update({ intervalSecs: v as number })}
          />
        </Row>

        <Row
          label="Metric families"
          hint="Which sources to record. Process = per-agent shell RSS/CPU. Frontend = WebView heap, jank, PTY throughput."
        >
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>
              <Toggle on={perfConfig.trackProcess} onToggle={() => update({ trackProcess: !perfConfig.trackProcess })} />
              Process
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>
              <Toggle on={perfConfig.trackFrontend} onToggle={() => update({ trackFrontend: !perfConfig.trackFrontend })} />
              Frontend
            </label>
          </div>
        </Row>
      </div>

      <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px", marginTop: 12 }}>
        <Row
          label="Reap idle background sessions"
          hint="Kill the PTY of an idle, non-visible project/planner session after the timeout to free memory. It shows a dormant placeholder and resumes (where it left off) on click — never destructive."
        >
          <Toggle on={idleReaper.enabled} onToggle={() => setIdleReaperConfig({ enabled: !idleReaper.enabled })} />
        </Row>
        <Row
          label="Idle timeout"
          hint="How long a project/planner session sits idle (and unwatched) before it's reaped."
        >
          <Select
            value={idleReaper.idleMs}
            options={[
              { label: "15 min", value: 15 * MIN },
              { label: "30 min (default)", value: 30 * MIN },
              { label: "1 hour", value: 60 * MIN },
              { label: "2 hours", value: 120 * MIN },
            ]}
            onChange={(v) => setIdleReaperConfig({ idleMs: v as number })}
          />
        </Row>
        <Row
          label="Also reap idle workers"
          hint="Off by default — fleet workers idle legitimately (parked on a dependency or the director). When on, a worker is reaped only after a much longer idle (2×)."
        >
          <Toggle
            on={idleReaper.workerIdleMs !== null}
            onToggle={() => setIdleReaperConfig({ workerIdleMs: idleReaper.workerIdleMs === null ? idleReaper.idleMs * 2 : null })}
          />
        </Row>
      </div>

      <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px", marginTop: 12 }}>
        <Row
          label="History retention"
          hint="Samples older than this are deleted from the database automatically."
        >
          <Select
            value={perfConfig.retentionHours}
            options={[
              { label: "1 hour", value: 1 },
              { label: "6 hours", value: 6 },
              { label: "24 hours (default)", value: 24 },
              { label: "72 hours", value: 72 },
              { label: "Unlimited", value: 0 },
            ]}
            onChange={(v) => update({ retentionHours: v as number })}
          />
        </Row>

        <Row
          label="Max database size"
          hint="Prune oldest rows if the DB file exceeds this size. 0 = no limit."
        >
          <Select
            value={perfConfig.maxDbMb}
            options={[
              { label: "10 MB", value: 10 },
              { label: "50 MB (default)", value: 50 },
              { label: "200 MB", value: 200 },
              { label: "No limit", value: 0 },
            ]}
            onChange={(v) => update({ maxDbMb: v as number })}
          />
        </Row>

        <Row
          label="Clear history"
          hint="Delete all stored samples from the database and the in-memory ring buffer."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ConfirmButton
              label="Clear history"
              armedLabel="Click again to confirm"
              onConfirm={clearHistory}
            />
            {clearStatus === "ok" && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>Cleared</span>
            )}
            {clearStatus === "err" && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>Failed</span>
            )}
          </div>
        </Row>
      </div>

      <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-dim)", marginTop: 12 }}>
        Samples are stored in <code style={{ fontFamily: "var(--mono)" }}>~/.base-studio-code/perf.db</code>.
        Unbounded log files (audit.log, coord.log) are trimmed to {new Intl.NumberFormat().format(10000)} lines on each startup.
      </div>
    </div>
  );
}
