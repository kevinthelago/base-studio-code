// Open pull-requests card — open PRs across all sampled repos (#1644).

import type { OpenPR } from "../lib/githubSummary";
import { Chip } from "@/shared/ui/data/Chip";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Grid } from "@/shared/ui/layout/Grid";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";

export function OpenPRsAllRepos({ prs, loading }: {
  prs: OpenPR[];
  loading: boolean;
}) {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Open pull requests</h3>
        <span className="hint">{loading ? "loading…" : `${prs.length} across all repos`}</span>
        <Spacer />
        <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>filter by reviewer</Button>
      </Row>
      {prs.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "8px 0" }}>No open pull requests.</div>
      )}
      {prs.length > 0 && (
        <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
          {prs.map((p, i) => (
            <Grid key={p.n + p.repo} cols="50px 1fr auto 50px" gap={10} align="baseline" style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              fontSize: 11,
              borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
            }}>
              <span className="mono" style={{ color: "var(--fg-dim)" }}>{p.n}</span>
              <div style={{ minWidth: 0 }}>
                <div style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.t}</div>
                <div className="mono" style={{ marginTop: 3, fontSize: 10, color: "var(--fg-dim)" }}>@{p.who} · {p.repo}</div>
              </div>
              {p.draft && <Chip style={{ fontSize: 9.5 }}>draft</Chip>}
              <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)", textAlign: "right" }}>{p.age}</span>
            </Grid>
          ))}
        </div>
      )}
    </Card>
  );
}
