import { useEffect, useState, useCallback } from "react";
import { StatusDot } from "@/shared/ui/StatusDot";
import { Chip } from "@/shared/ui/Chip";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  interpretDiagnostics,
  loadReport,
  saveReport,
  type PrereqStatus,
  type PrereqVerdict,
  type DiagnosticsReport,
} from "@/shared/lib/core/diagnostics";

function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

const SEVERITY_COLOR: Record<"critical" | "warning" | "ok", string> = {
  critical: "var(--danger)",
  warning: "#e5c07b",
  ok: "var(--success)",
};

function PrereqRow({ verdict, alt }: { verdict: PrereqVerdict; alt: boolean }) {
  const url = verdict.ok ? null : firstUrl(verdict.hint);
  const dotColor = verdict.ok ? SEVERITY_COLOR.ok : SEVERITY_COLOR[verdict.severity];
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px",
      background: alt ? "var(--bg-panel)" : "var(--bg-elev)",
    }}>
      <div style={{ paddingTop: 3 }}>
        <StatusDot
          color={dotColor}
          size={9}
          title={verdict.ok ? "found" : verdict.severity}
          style={{ boxShadow: `0 0 0 3px color-mix(in oklch, ${dotColor}, transparent 82%)` }}
        />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg)" }}>{verdict.name}</span>
          {verdict.ok ? (
            <Chip tone="success" style={{ fontSize: 9.5 }}><StatusDot style={{ marginRight: 4 }} />found</Chip>
          ) : (
            <Chip
              style={{ fontSize: 9.5, color: SEVERITY_COLOR[verdict.severity], borderColor: SEVERITY_COLOR[verdict.severity] }}
            >
              <StatusDot style={{ marginRight: 4 }} />{verdict.severity === "critical" ? "missing" : "attention"}
            </Chip>
          )}
          {verdict.version && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)" }}>{verdict.version}</span>
          )}
        </div>
        {verdict.ok ? (
          verdict.path && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", marginTop: 3, wordBreak: "break-all" }}>
              {verdict.path}
            </div>
          )
        ) : (
          <div style={{ fontSize: 11.5, color: "var(--fg-muted)", marginTop: 4, lineHeight: 1.55 }}>
            {verdict.consequence}
            {url && (
              <>
                {" "}
                <a
                  onClick={(e) => { e.preventDefault(); openUrl(url); }}
                  href={url}
                  style={{ color: "var(--accent)", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5 }}
                >
                  {url.replace(/^https?:\/\//, "")} ↗
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function DiagnosticsCard() {
  const [report, setReport] = useState<DiagnosticsReport | null>(() => loadReport()?.report ?? null);
  const [takenAt, setTakenAt] = useState<number | null>(() => loadReport()?.takenAt ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const prereqs = await invoke<PrereqStatus[]>("preflight", { cwd: "", env: null });
      const next = interpretDiagnostics(Array.isArray(prereqs) ? prereqs : []);
      const now = Date.now();
      setReport(next);
      setTakenAt(now);
      saveReport(next, now);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  useEffect(() => { void runProbe(); }, [runProbe]);

  const banner = report
    ? report.allOk
      ? { color: SEVERITY_COLOR.ok, text: report.headline }
      : { color: SEVERITY_COLOR[report.worst ?? "warning"], text: report.headline }
    : null;

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
        borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
      }}>
        {banner && (
          <StatusDot
            color={banner.color}
            size={9}
            style={{ boxShadow: `0 0 0 3px color-mix(in oklch, ${banner.color}, transparent 82%)` }}
          />
        )}
        <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>
          {banner ? banner.text : running ? "Checking…" : "Not checked yet."}
        </span>
        {takenAt && (
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
            checked {new Date(takenAt).toLocaleTimeString()}
          </span>
        )}
        <button className="btn ghost" style={{ height: 28, fontSize: 11 }} disabled={running} onClick={() => void runProbe()}>
          {running ? "checking…" : "↺ re-check"}
        </button>
      </div>

      {error && (
        <div style={{
          padding: "10px 14px", color: "var(--danger)", fontFamily: "var(--mono)", fontSize: 11,
          borderBottom: "1px solid var(--border-soft)",
        }}>
          Probe failed: {error}
        </div>
      )}

      {report && report.prereqs.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {report.prereqs.map((v, i) => <PrereqRow key={v.name} verdict={v} alt={i % 2 === 1} />)}
        </div>
      ) : !running && !error ? (
        <div style={{ padding: "20px 14px", textAlign: "center", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>
          No prerequisite data yet.
        </div>
      ) : null}
    </div>
  );
}
