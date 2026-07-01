// Open pull-requests card — open PRs across all sampled repos (#1644).

import type { OpenPR } from "../lib/githubSummary";
import { Chip } from "@/shared/ui/data/Chip";

export function OpenPRsAllRepos({ prs, loading }: {
  prs: OpenPR[];
  loading: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Open pull requests</h3>
        <span className="hint">{loading ? "loading…" : `${prs.length} across all repos`}</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>filter by reviewer</button>
      </div>
      {prs.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No open pull requests.</div>
      )}
      {prs.length > 0 && (
        <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {prs.map((p, i) => (
            <div key={p.n + p.repo} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: "50px 1fr auto 50px",
              gap: 10, alignItems: "baseline", fontSize: 11,
              borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
            }}>
              <span className="mono" style={{ color: "var(--fg-dim)" }}>{p.n}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.t}</div>
                <div className="mono" style={{ marginTop: 3, fontSize: 10, color: "var(--fg-dim)" }}>@{p.who} · {p.repo}</div>
              </div>
              {p.draft && <Chip style={{ fontSize: 9.5 }}>draft</Chip>}
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{p.age}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
