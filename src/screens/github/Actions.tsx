import { useState, useEffect, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, type GithubRepo } from "../../store";

interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: "active" | "deleted" | "disabled_fork" | "disabled_inactivity" | "disabled_manually";
  updated_at: string;
  badge_url: string;
}

interface GhRun {
  id: number;
  name: string;
  head_branch: string;
  head_sha: string;
  run_number: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  created_at: string;
  updated_at: string;
  actor: { login: string };
  workflow_id: number;
  html_url: string;
}

interface GhFileContent {
  content: string;
  encoding: string;
}

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function runDuration(run: GhRun): string {
  if (run.status !== "completed") return "—";
  const ms = new Date(run.updated_at).getTime() - new Date(run.created_at).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function runLabel(run: GhRun): { text: string; color: string; icon: string } {
  if (run.status === "queued")     return { text: "queued",    color: "var(--accent)",  icon: "◑" };
  if (run.status === "in_progress")return { text: "running",   color: "var(--accent)",  icon: "◑" };
  if (run.conclusion === "success")return { text: "passing",   color: "var(--success)", icon: "✓" };
  if (run.conclusion === "failure")return { text: "failing",   color: "var(--danger)",  icon: "✗" };
  if (run.conclusion === "cancelled") return { text: "cancelled", color: "var(--fg-dim)", icon: "—" };
  return { text: run.conclusion ?? run.status, color: "var(--fg-dim)", icon: "·" };
}

function wfStatusDot(wf: GhWorkflow, runs: GhRun[]): string {
  if (wf.state !== "active") return "var(--fg-dim)";
  const latest = runs.filter(r => r.workflow_id === wf.id)[0];
  if (!latest) return "var(--fg-dim)";
  if (latest.status !== "completed") return "var(--accent)";
  if (latest.conclusion === "success") return "var(--success)";
  if (latest.conclusion === "failure") return "var(--danger)";
  return "var(--fg-dim)";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function Section2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6,
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
        textTransform: "uppercase", letterSpacing: ".08em",
      }}>
        <span>{label}</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
        <span style={{ color: "var(--fg-dim)", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>+ add</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function RowEditable({ icon, t, v, on, placeholder }: { icon: string; t: string; v: string; on?: boolean; placeholder?: boolean }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "22px 130px 1fr 22px",
      gap: 10, alignItems: "center", padding: "6px 10px", borderRadius: 5,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      <span style={{ color: on ? "var(--accent)" : "var(--fg-dim)" }}>{icon}</span>
      <span style={{ color: on ? "var(--fg)" : "var(--fg-muted)" }}>{t}</span>
      <span style={{ color: placeholder ? "var(--fg-dim)" : "var(--fg-muted)", fontStyle: placeholder ? "italic" : "normal", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{v}</span>
      <span style={{ color: "var(--fg-dim)", textAlign: "right", cursor: "pointer" }}>⋯</span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "180px 1fr",
      gap: 10, alignItems: "center", padding: "5px 10px", borderRadius: 5,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      <span style={{ color: "var(--info)" }}>{k}</span>
      <span style={{ color: "var(--fg)" }}>{v}</span>
    </div>
  );
}

function JobRow({ name, runs, steps, dur, st }: { name: string; runs: string; steps: string; dur: string; st: string }) {
  return (
    <div style={{
      padding: "8px 12px", borderRadius: 6,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      display: "flex", flexDirection: "column", gap: 5,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", background: st === "passing" ? "var(--success)" : st === "failing" ? "var(--danger)" : "var(--accent)" }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)" }}>{name}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>runs-on: {runs}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{dur}</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", paddingLeft: 15 }}>{steps}</div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ActionsBody({ repo }: { repo: GithubRepo | null }) {
  const { githubToken } = useAppStore();

  const [workflows, setWorkflows] = useState<GhWorkflow[]>([]);
  const [runs, setRuns]           = useState<GhRun[]>([]);
  const [loading, setLoading]     = useState(false);
  const [filter, setFilter]       = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [viewMode, setViewMode]   = useState<"structured" | "raw">("structured");
  const [yamlContent, setYamlContent] = useState<string | null>(null);
  const [yamlLoading, setYamlLoading] = useState(false);

  useEffect(() => {
    if (!repo || !githubToken) return;
    setLoading(true);
    const slug = repo.full_name;

    Promise.all([
      invoke<{ total_count: number; workflows: GhWorkflow[] }>("github_request", {
        token: githubToken, path: `repos/${slug}/actions/workflows`,
      }),
      invoke<{ total_count: number; workflow_runs: GhRun[] }>("github_request", {
        token: githubToken, path: `repos/${slug}/actions/runs?per_page=30`,
      }),
    ])
      .then(([wfData, runData]) => {
        const wfs = Array.isArray(wfData?.workflows) ? wfData.workflows.filter(w => w.state !== "deleted") : [];
        const rs  = Array.isArray(runData?.workflow_runs) ? runData.workflow_runs : [];
        setWorkflows(wfs);
        setRuns(rs);
        if (wfs.length > 0 && selectedId === null) setSelectedId(wfs[0].id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [repo?.full_name, githubToken]);

  // Fetch YAML when switching to raw mode
  useEffect(() => {
    const wf = workflows.find(w => w.id === selectedId);
    if (!wf || !repo || !githubToken || viewMode !== "raw") return;
    setYamlLoading(true);
    setYamlContent(null);
    invoke<GhFileContent>("github_request", {
      token: githubToken,
      path: `repos/${repo.full_name}/contents/${wf.path}`,
    })
      .then(data => {
        try {
          setYamlContent(atob(data.content.replace(/\n/g, "")));
        } catch {
          setYamlContent("# Could not decode file content");
        }
      })
      .catch(() => setYamlContent("# Could not load workflow file"))
      .finally(() => setYamlLoading(false));
  }, [selectedId, viewMode, repo?.full_name, githubToken]);

  const selectedWf = workflows.find(w => w.id === selectedId) ?? workflows[0] ?? null;
  const visibleRuns = runs.filter(r => r.workflow_id === selectedId);

  const filteredWfs = workflows.filter(w =>
    w.name.toLowerCase().includes(filter.toLowerCase()) ||
    w.path.toLowerCase().includes(filter.toLowerCase())
  );

  // Stat card calculations
  const now = useMemo(() => Date.now(), []);
  const weekRuns = runs.filter(r => now - new Date(r.created_at).getTime() < 7 * 86_400_000);
  const passing  = weekRuns.filter(r => r.conclusion === "success").length;
  const failing  = weekRuns.filter(r => r.conclusion === "failure").length;
  const inFlight = runs.filter(r => r.status !== "completed").length;
  const lastRun  = runs[0];
  const activeCount = workflows.filter(w => w.state === "active").length;

  const latestRunLabel = lastRun
    ? `${runLabel(lastRun).icon} ${runLabel(lastRun).text}`
    : "—";

  const statCards = [
    ["workflows", loading ? "…" : String(workflows.length),   `${activeCount} active`,        "fg"     ],
    ["last run",  loading ? "…" : lastRun ? timeAgo(lastRun.created_at) : "—", latestRunLabel, "success"],
    ["this week", loading ? "…" : String(weekRuns.length),    `${passing} ✓ · ${failing} ✗`,  "accent" ],
    ["running",   loading ? "…" : String(inFlight),           inFlight > 0 ? "in progress" : "idle",    "info"   ],
  ] as const;

  const wfFilename = selectedWf ? selectedWf.path.split("/").pop()! : "—";
  const selectedLatestRun = selectedWf ? runs.find(r => r.workflow_id === selectedWf.id) : null;

  return (
    <>
      {/* Stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {statCards.map(([k, v, sub, tone]) => (
          <div key={k} className="card" style={{ padding: "10px 14px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>{k}</div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600, marginTop: 2,
              color: tone === "success" ? "var(--success)" : tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : "var(--fg)",
            }}>{v}</div>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
          </div>
        ))}
      </div>

      {loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0", textAlign: "center" }}>
          Loading workflows…
        </div>
      )}

      {!loading && workflows.length === 0 && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "20px 0", textAlign: "center" }}>
          No GitHub Actions workflows found in this repository.
        </div>
      )}

      {!loading && workflows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
          {/* Workflow list */}
          <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border-soft)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h3 style={{ margin: 0 }}>Workflows</h3>
                <span className="hint">.github/workflows/</span>
              </div>
              <input
                className="input"
                placeholder="filter…"
                value={filter}
                onChange={e => setFilter(e.target.value)}
                style={{ marginTop: 8, height: 24, fontSize: 10.5 }}
              />
            </div>
            <div style={{ flex: 1, overflow: "auto" }}>
              {filteredWfs.length === 0 && (
                <div style={{ padding: "14px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", textAlign: "center" }}>
                  No workflows match "{filter}"
                </div>
              )}
              {filteredWfs.map(w => {
                const sel = w.id === selectedId;
                const latest = runs.find(r => r.workflow_id === w.id);
                const dotColor = wfStatusDot(w, runs);
                const filename = w.path.split("/").pop()!;
                return (
                  <div key={w.id} onClick={() => { setSelectedId(w.id); setYamlContent(null); }}
                    style={{
                      padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", cursor: "pointer",
                      background: sel ? "var(--bg-elev)" : "transparent",
                      borderLeft: sel ? "2px solid var(--accent)" : "2px solid transparent",
                      paddingLeft: sel ? 12 : 14,
                    }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: dotColor, flexShrink: 0 }} />
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: sel ? "var(--fg)" : "var(--fg-muted)" }}>
                        {filename}
                      </span>
                      <span style={{ flex: 1 }} />
                      {w.state !== "active" && <span className="tag" style={{ fontSize: 9.5 }}>off</span>}
                    </div>
                    <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", flex: 1 }}>
                        {w.name}
                      </span>
                      {latest && (
                        <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
                          {timeAgo(latest.created_at)}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)" }}>
              <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>+ New workflow</button>
            </div>
          </div>

          {/* Editor + runs */}
          {selectedWf && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
                <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>.github/workflows/</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>{wfFilename}</span>
                  {selectedLatestRun && (() => {
                    const { text, color } = runLabel(selectedLatestRun);
                    return <span className="tag" style={{ fontSize: 10, color }}>● {text}</span>;
                  })()}
                  <span className="hint">{selectedWf.state !== "active" ? "disabled" : `updated ${timeAgo(selectedWf.updated_at)}`}</span>
                  <div style={{ flex: 1 }} />
                  <div style={{ display: "flex", gap: 4, padding: 2, background: "var(--bg-elev)", borderRadius: 5, border: "1px solid var(--border-soft)" }}>
                    {(["structured", "raw"] as const).map(mode => (
                      <button key={mode} onClick={() => setViewMode(mode)} className="btn"
                        style={{
                          height: 22, padding: "0 10px", fontSize: 10.5,
                          background: viewMode === mode ? "var(--bg-elev2)" : "transparent",
                          borderColor: viewMode === mode ? "var(--accent-dim)" : "transparent",
                          color: viewMode === mode ? "var(--accent)" : "var(--fg-muted)",
                        }}>
                        {mode === "structured" ? "structured" : "raw yaml"}
                      </button>
                    ))}
                  </div>
                  <button className="btn ghost" style={{ height: 24 }}
                    onClick={() => selectedWf && repo && window.open(`https://github.com/${repo.full_name}/actions/workflows/${wfFilename}`, "_blank")}>
                    open ↗
                  </button>
                </div>

                {viewMode === "structured" ? (
                  <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
                    <Section2 label="on">
                      <RowEditable on icon="↑" t="push"             v="branches: main, feat/**" />
                      <RowEditable on icon="⇄" t="pull_request"     v="any branch" />
                      <RowEditable    icon="⏱" t="schedule"         v="not set" placeholder />
                      <RowEditable    icon="·" t="workflow_dispatch" v="not set" placeholder />
                    </Section2>
                    <Section2 label="env">
                      <KV k="RUST_VERSION"     v="1.82" />
                      <KV k="CARGO_TERM_COLOR" v="always" />
                      <KV k="RUSTFLAGS"        v="-D warnings" />
                    </Section2>
                    <Section2 label="jobs">
                      <JobRow name="test"   runs="ubuntu-latest" steps="checkout · setup-rust · cargo test"   dur="—" st="passing" />
                      <JobRow name="clippy" runs="ubuntu-latest" steps="checkout · setup-rust · cargo clippy" dur="—" st="passing" />
                    </Section2>
                  </div>
                ) : (
                  <div style={{ padding: "14px 16px" }}>
                    {yamlLoading && (
                      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)" }}>Loading…</div>
                    )}
                    {!yamlLoading && yamlContent && (
                      <pre style={{
                        margin: 0, fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
                        lineHeight: 1.6, whiteSpace: "pre-wrap", background: "transparent",
                        maxHeight: 360, overflow: "auto",
                      }}>
                        {yamlContent}
                      </pre>
                    )}
                  </div>
                )}
              </div>

              {/* Runs table */}
              <div className="card" style={{ padding: "14px 16px" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                  <h3 style={{ margin: 0 }}>Recent runs · {wfFilename}</h3>
                  <span className="hint">{visibleRuns.length > 0 ? `${visibleRuns.length} shown` : "no runs"}</span>
                  <div style={{ flex: 1 }} />
                  <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}
                    onClick={() => repo && window.open(`https://github.com/${repo.full_name}/actions`, "_blank")}>
                    view all on github →
                  </button>
                </div>
                {visibleRuns.length === 0 ? (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>
                    No recent runs for this workflow.
                  </div>
                ) : (
                  <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
                    {visibleRuns.slice(0, 10).map((r, i) => {
                      const { text, color, icon } = runLabel(r);
                      return (
                        <div key={r.id} style={{
                          display: "grid", gridTemplateColumns: "72px 72px 80px 1fr 80px 60px",
                          gap: 12, padding: "9px 14px", alignItems: "baseline", fontSize: 11,
                          background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                          borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
                          cursor: "pointer",
                        }}
                          onClick={() => window.open(r.html_url, "_blank")}
                        >
                          <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>#{r.run_number}</span>
                          <span style={{ fontFamily: "var(--mono)", color: "var(--accent)", fontSize: 10.5 }}>
                            {r.head_sha.slice(0, 7)}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color }}>
                            {icon} {text}
                          </span>
                          <span style={{ color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 10.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {r.head_branch}
                            {r.name && r.name !== selectedWf.name && (
                              <span style={{ color: "var(--fg-dim)" }}> · {r.name}</span>
                            )}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                            @{r.actor.login}
                          </span>
                          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", textAlign: "right" }}>
                            {runDuration(r)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
