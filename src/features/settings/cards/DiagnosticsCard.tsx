import { useEffect, useState, useCallback } from "react";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Chip } from "@/shared/ui/data/Chip";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Button } from "@/shared/ui/controls/Button";
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
    <Row align="start" gap={12} style={{
      padding: "12px 14px",
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
        <Row gap={8} wrap>
          <span className="mono" style={{ fontSize: 12.5, color: "var(--fg)" }}>{verdict.name}</span>
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
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>{verdict.version}</span>
          )}
        </Row>
        {verdict.ok ? (
          verdict.path && (
            <div className="mono" style={{ fontSize: 10, color: "var(--fg-dim)", marginTop: 3, wordBreak: "break-all" }}>
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
                  className="mono"
                  style={{ color: "var(--accent)", cursor: "pointer", fontSize: 10.5 }}
                >
                  {url.replace(/^https?:\/\//, "")} ↗
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </Row>
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
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <Row gap={12} style={{
        padding: "12px 14px",
        borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
      }}>
        {banner && (
          <StatusDot
            color={banner.color}
            size={9}
            style={{ boxShadow: `0 0 0 3px color-mix(in oklch, ${banner.color}, transparent 82%)` }}
          />
        )}
        <span className="mono" style={{ flex: 1, fontSize: 12, color: "var(--fg)" }}>
          {banner ? banner.text : running ? "Checking…" : "Not checked yet."}
        </span>
        {takenAt && (
          <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)" }}>
            checked {new Date(takenAt).toLocaleTimeString()}
          </span>
        )}
        <Button variant="ghost" style={{ height: 28, fontSize: 11 }} disabled={running} onClick={() => void runProbe()}>
          {running ? "checking…" : "↺ re-check"}
        </Button>
      </Row>

      {error && (
        <div className="mono" style={{
          padding: "10px 14px", color: "var(--danger)", fontSize: 11,
          borderBottom: "1px solid var(--border-soft)",
        }}>
          Probe failed: {error}
        </div>
      )}

      {report && report.prereqs.length > 0 ? (
        <Stack gap={1}>
          {report.prereqs.map((v, i) => <PrereqRow key={v.name} verdict={v} alt={i % 2 === 1} />)}
        </Stack>
      ) : !running && !error ? (
        <div className="mono" style={{ padding: "20px 14px", textAlign: "center", fontSize: 11, color: "var(--fg-dim)" }}>
          No prerequisite data yet.
        </div>
      ) : null}
    </Card>
  );
}
