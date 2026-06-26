// Cross-project activity feed — recent GitHub events across all project repos.
// The event parsing lives in projectsSummaryDerive.ts (buildActivityFeed).

import { useMemo } from "react";
import { timeAgo } from "@/shared/lib/core/format";
import { Avatar } from "@/shared/ui/Avatar";
import type { GHEvent } from "@/shared/lib/github/types";
import { buildActivityFeed, EVENT_TONE, type GhProject } from "./projectsSummaryDerive";

export function CrossProjectActivity({ events, projects, loading }: {
  events: GHEvent[];
  projects: GhProject[];
  loading: boolean;
}) {
  const feed = useMemo(() => buildActivityFeed(events, projects), [events, projects]);

  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <span className="hint">across all projects</span>
      </div>
      {feed.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No recent activity.</div>
      )}
      {loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>Loading…</div>
      )}
      {feed.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {feed.map((e, i) => (
            <div key={i} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: "22px 80px 1fr 110px 50px",
              gap: 10, alignItems: "center", fontSize: 11,
            }}>
              <Avatar login={e.login} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: EVENT_TONE[e.action] ?? "var(--fg-muted)" }}>{e.action}</span>
              <span style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{e.target}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{e.repo}</span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{timeAgo(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
