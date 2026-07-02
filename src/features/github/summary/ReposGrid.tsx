// Repositories grid — per-repo card with PR count, CI status, and commit sparkline (#1644).

import { useAppStore } from "@/store";
import { timeAgo } from "@/shared/lib/core/format";
import { langColor, type RepoCardData } from "../lib/githubSummary";
import { Spark } from "@/shared/ui/charts";
import { Grid } from "@/shared/ui/layout/Grid";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";

export function ReposGrid({ repos, loading }: {
  repos: RepoCardData[];
  loading: boolean;
}) {
  const { setGithubPageMode } = useAppStore();
  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Repositories</h3>
        <span className="hint">{repos.length} connected · click to drill in</span>
        <Spacer />
        <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>+ connect more</Button>
      </Row>
      {repos.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No repositories connected.</div>
      )}
      <Grid cols={2} gap="sm">
        {repos.map(r => (
          <div key={r.full_name} onClick={() => setGithubPageMode("repos")} style={{
            padding: "12px 14px", borderRadius: 6,
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            cursor: "pointer",
          }}>
            <Row align="baseline" gap={8} style={{ marginBottom: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.language ? langColor(r.language) : "var(--fg-dim)", flexShrink: 0, display: "inline-block" }} />
              <span className="mono-value">{r.full_name}</span>
              <Spacer />
              <span className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)" }}>{timeAgo(r.lastPush)}</span>
            </Row>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 8 }}>{r.description ?? "No description."}</div>
            <Row className="mono" gap={14} style={{ fontSize: 10, color: "var(--fg-muted)" }}>
              <span>⊕ <b style={{ color: "var(--fg)" }}>{loading ? "…" : r.prCount}</b> PR</span>
              <span style={{ color: r.ciStatus === "passing" ? "var(--success)" : r.ciStatus === "failing" ? "var(--danger)" : "var(--fg-dim)" }}>
                ◉ ci {r.ciStatus}
              </span>
              <Spacer />
              {r.spark.some(v => v > 0) && <Spark data={r.spark} color="var(--accent)" w={90} h={22} fill={false} />}
            </Row>
          </div>
        ))}
      </Grid>
    </Card>
  );
}
