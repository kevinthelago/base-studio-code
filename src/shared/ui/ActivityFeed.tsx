import type { ReactNode } from "react";
import { Avatar } from "@/shared/ui/Avatar";
import { timeAgo } from "@/shared/lib/core/format";

/** One row of the activity feed — the normalized shape shared by the github cross-repo feed and the
 *  planner cross-project feed. */
export interface ActivityItem {
  login: string;
  action: string;
  target: string;
  repo: string;
  createdAt: string;
}

/** The "Recent activity" striped feed: a `.card` with a header (title + hint + optional control) and
 *  a list of `Avatar · action · target · repo · timeAgo` rows. Unifies CrossRepoActivity (github)
 *  and CrossProjectActivity (planner), which were byte-identical apart from the hint, the optional
 *  filter, and the action-column width. The `action → color` map is passed in (`tone`) so each
 *  caller keeps its own EVENT_TONE rather than coupling the two. */
export function ActivityFeed({ items, hint, loading, tone, right, actionWidth = 80 }: {
  items: ActivityItem[];
  hint: string;
  loading: boolean;
  tone: Record<string, string>;
  /** Optional header control on the right (e.g. a filter select). */
  right?: ReactNode;
  /** Width of the action column in px (github uses 70, planner 80). */
  actionWidth?: number;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Recent activity</h3>
        <span className="hint">{hint}</span>
        {right != null && <><div style={{ flex: 1 }} />{right}</>}
      </div>
      {items.length === 0 && !loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No recent activity.</div>
      )}
      {loading && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>Loading…</div>
      )}
      {items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 1, borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {items.map((e, i) => (
            <div key={i} style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              display: "grid", gridTemplateColumns: `22px ${actionWidth}px 1fr 110px 50px`,
              gap: 10, alignItems: "center", fontSize: 11,
            }}>
              <Avatar login={e.login} />
              <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: tone[e.action] ?? "var(--fg-muted)" }}>{e.action}</span>
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
