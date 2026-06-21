import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  interpretDiagnostics,
  loadReport,
  saveReport,
  loadShellKind,
  saveShellKind,
  coerceShellKind,
  SHELL_OPTIONS,
  type PrereqStatus,
  type PrereqVerdict,
  type DiagnosticsReport,
  type ShellKind,
} from "../../lib/core/diagnostics";

// First URL inside a backend hint string, so "…install from https://x" renders a
// clickable link. Hints are authored in the backend (`prereq_hint`) and always end
// with their URL when they carry one.
function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : null;
}

// Amber matches the in-pane GitHub-readiness warning (TerminalView, #297) so
// "needs attention" reads the same across the app; there is no warning token.
const SEVERITY_COLOR: Record<"critical" | "warning" | "ok", string> = {
  critical: "var(--danger)",
  warning: "#e5c07b",
  ok: "var(--success)",
};

function StatusDot({ verdict }: { verdict: PrereqVerdict }) {
  const color = verdict.ok ? SEVERITY_COLOR.ok : SEVERITY_COLOR[verdict.severity];
  return (
    <span
      title={verdict.ok ? "found" : verdict.severity}
      style={{
        width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
        background: color, boxShadow: `0 0 0 3px color-mix(in oklch, ${color}, transparent 82%)`,
      }}
    />
  );
}

function PrereqRow({ verdict, alt }: { verdict: PrereqVerdict; alt: boolean }) {
  const url = verdict.ok ? null : firstUrl(verdict.hint);
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 12, padding: "12px 14px",
      background: alt ? "var(--bg-panel)" : "var(--bg-elev)",
    }}>
      <div style={{ paddingTop: 3 }}><StatusDot verdict={verdict} /></div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 12.5, color: "var(--fg)" }}>{verdict.name}</span>
          {verdict.ok ? (
            <span className="tag green" style={{ fontSize: 9.5 }}>● found</span>
          ) : (
            <span
              className="tag"
              style={{ fontSize: 9.5, color: SEVERITY_COLOR[verdict.severity], borderColor: SEVERITY_COLOR[verdict.severity] }}
            >
              ● {verdict.severity === "critical" ? "missing" : "attention"}
            </span>
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

// Console-shell selector (#447). Persists the choice both to the backend (where
// `resolve_interactive_shell` reads it at launch) and to localStorage (for instant
// UI), and flags shells where the bsc-* helpers run degraded.
function ShellSelector() {
  const [kind, setKind] = useState<ShellKind>(() => loadShellKind());

  // Reconcile with the backend's persisted value on open (it is the source of truth
  // the launcher reads); fall back to the local copy if the call fails.
  useEffect(() => {
    let live = true;
    invoke<string>("get_preferred_shell")
      .then((v) => { if (live) setKind(coerceShellKind(v)); })
      .catch(() => { /* keep the local value */ });
    return () => { live = false; };
  }, []);

  function choose(next: ShellKind) {
    setKind(next);
    saveShellKind(next);
    invoke("set_preferred_shell", { kind: next }).catch((e) => {
      // Non-fatal: the local copy still drives the UI; surface nothing blocking.
      console.error("set_preferred_shell failed", e);
    });
  }

  const active = SHELL_OPTIONS.find((o) => o.kind === kind) ?? SHELL_OPTIONS[0];

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>Console shell</h3>
        <span className="hint">the shell new console sessions launch under · applies to the next launch</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {SHELL_OPTIONS.map((o) => {
          const on = o.kind === kind;
          return (
            <div
              key={o.kind}
              onClick={() => choose(o.kind)}
              style={{
                padding: "6px 12px", borderRadius: 6, cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 11,
                background: on ? "var(--accent)" : "var(--bg-elev)",
                color: on ? "#1a120a" : "var(--fg-muted)",
                border: "1px solid " + (on ? "transparent" : "var(--border-soft)"),
                fontWeight: on ? 600 : 400,
              }}
            >{o.label}</div>
          );
        })}
      </div>
      <div className="hint" style={{ marginTop: 10, lineHeight: 1.55 }}>
        {active.note}
        {!active.helpersFull && (
          <>
            {" "}
            <span style={{ color: "#e5c07b" }}>
              ⚠ The bsc-* helpers (checkpoint, notes, coordination) and startup-prompt
              injection are bash-only — sessions under this shell run without them.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

export function DiagnosticsSettings() {
  // Render the cached report instantly, then re-probe on open for fresh truth.
  const [report, setReport] = useState<DiagnosticsReport | null>(() => loadReport()?.report ?? null);
  const [takenAt, setTakenAt] = useState<number | null>(() => loadReport()?.takenAt ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runProbe = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      // Global host check — no repo cwd, default env. The backend runs it through
      // the same resolved login shell agent subshells use.
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

  // Probe once on open.
  useEffect(() => { void runProbe(); }, [runProbe]);

  const banner = report
    ? report.allOk
      ? { color: SEVERITY_COLOR.ok, text: report.headline }
      : { color: SEVERITY_COLOR[report.worst ?? "warning"], text: report.headline }
    : null;

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Diagnostics</h2>
        <span className="hint">host environment · external prerequisites</span>
      </div>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 20px", fontSize: 12, lineHeight: 1.6 }}>
        Checks the tools agents depend on — the console shell, the <code>claude</code> CLI, and{" "}
        <code>git</code>/<code>gh</code> — in the same environment a session runs under, so a missing
        prerequisite surfaces here instead of failing an agent mid-task.
      </p>

      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        {/* Header / summary banner */}
        <div style={{
          display: "flex", alignItems: "center", gap: 12, padding: "12px 14px",
          borderBottom: "1px solid var(--border-soft)", background: "var(--bg-elev)",
        }}>
          {banner && (
            <span style={{
              width: 9, height: 9, borderRadius: "50%", flexShrink: 0, background: banner.color,
              boxShadow: `0 0 0 3px color-mix(in oklch, ${banner.color}, transparent 82%)`,
            }} />
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

        {/* Prerequisite rows */}
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

      <ShellSelector />
    </div>
  );
}
