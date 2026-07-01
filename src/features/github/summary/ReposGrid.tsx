// Repositories grid — per-repo card with PR count, CI status, and commit sparkline (#1644).

import { useAppStore } from "@/store";
import { timeAgo } from "@/shared/lib/core/format";
import { langColor, type RepoCardData } from "../lib/githubSummary";
import { Spark } from "@/shared/ui/charts";

export function ReposGrid({ repos, loading }: {
  repos: RepoCardData[];
  loading: boolean;
}) {
  const { setGithubPageMode } = useAppStore();
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Repositories</h3>
        <span className="hint">{repos.length} connected · click to drill in</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>+ connect more</button>
      </div>
      {repos.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No repositories connected.</div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8 }}>
        {repos.map(r => (
          <div key={r.full_name} onClick={() => setGithubPageMode("repos")} style={{
            padding: "12px 14px", borderRadius: 6,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            cursor: "pointer",
          }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.language ? langColor(r.language) : "var(--fg-dim)", flexShrink: 0, display: "inline-block" }} />
              <span className="mono-value">{r.full_name}</span>
              <div style={{ flex: 1 }} />
              <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{timeAgo(r.lastPush)}</span>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 8 }}>{r.description ?? "No description."}</div>
            <div className="mono" style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 10, color: "var(--fg-muted)" }}>
              <span>⊕ <b style={{ color: "var(--fg)" }}>{loading ? "…" : r.prCount}</b> PR</span>
              <span style={{ color: r.ciStatus === "passing" ? "var(--success)" : r.ciStatus === "failing" ? "var(--danger)" : "var(--fg-dim)" }}>
                ◉ ci {r.ciStatus}
              </span>
              <div style={{ flex: 1 }} />
              {r.spark.some(v => v > 0) && <Spark data={r.spark} color="var(--accent)" w={90} h={22} fill={false} />}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
