// Top-contributors card — commit counts across the sampled repos (#1644).

import { Avatar } from "@/shared/ui/data/Avatar";
import type { Contributor } from "../lib/githubSummary";

export function ContributorsCard({ contributors, loading }: {
  contributors: Contributor[];
  loading: boolean;
}) {
  const maxC = Math.max(...contributors.map(p => p.commits), 1);
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Top contributors</h3>
        <span className="hint">{loading ? "loading…" : contributors.length > 0 ? `${contributors.length} contributors · all repos` : "no data"}</span>
      </div>
      {contributors.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>
          No contributor data yet — GitHub is computing stats.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {contributors.map(p => (
          <div key={p.login} style={{ display: "grid", gridTemplateColumns: "22px 1fr 1fr 80px", gap: 10, alignItems: "center" }}>
            <Avatar login={p.login} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>@{p.login}</span>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-elev2)", overflow: "hidden" }}>
              <div style={{ width: `${p.commits / maxC * 100}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)", textAlign: "right" }}>{p.commits} commits</span>
          </div>
        ))}
      </div>
    </div>
  );
}
