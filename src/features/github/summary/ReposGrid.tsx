// Repositories grid — per-repo card with PR count, CI status, and commit sparkline (#1644).

import { useAppStore } from "@/store";
import { timeAgo } from "@/shared/lib/core/format";
import { langColor, type RepoCardData } from "../lib/githubSummary";
import { Spark } from "@/shared/ui/charts";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";
import { CardEmpty } from "./cardStates";
import { Grid } from "@/shared/ui/layout/Grid";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";

export function ReposGrid({ repos, loading }: {
  repos: RepoCardData[];
  loading: boolean;
}) {
  const { setGithubPageMode } = useAppStore();
  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Repositories"
      hint={`${repos.length} connected · click to drill in`}
      right={<Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>+ connect more</Button>}
      headMb={10}
    >
      {loading && repos.length === 0 && (
        <Grid cols={2} gap="sm">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} h={92} radius={10} />)}
        </Grid>
      )}
      {!loading && repos.length === 0 && (
        <CardEmpty icon="⎇" title="No repositories connected" hint="Connect repositories to see them here." />
      )}
      <Grid cols={2} gap="sm">
        {repos.map(r => (
          <Card key={r.full_name} interactive onClick={() => setGithubPageMode("repos")}>
            <Row align="baseline" gap={8} style={{ marginBottom: 4 }}>
              <Box as="span" bg={r.language ? langColor(r.language) : "var(--fg-dim)"} style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, display: "inline-block" }} />
              <Box as="span" className="mono-value">{r.full_name}</Box>
              <Spacer />
              <Text as="span" mono size={9.5} tone="dim">{timeAgo(r.lastPush)}</Text>
            </Row>
            <Box style={{ fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.5, marginBottom: 8 }}>{r.description ?? "No description."}</Box>
            <Row className="mono" gap={14} style={{ fontSize: 10, color: "var(--fg-muted)" }}>
              <Text>⊕ <b style={{ color: "var(--fg)" }}>{loading ? "…" : r.prCount}</b> PR</Text>
              <Text as="span" style={{ color: r.ciStatus === "passing" ? "var(--success)" : r.ciStatus === "failing" ? "var(--danger)" : "var(--fg-dim)" }}>
                ◉ ci {r.ciStatus}
              </Text>
              <Spacer />
              {r.spark.some(v => v > 0) && <Spark data={r.spark} color="var(--accent)" w={90} h={22} fill={false} />}
            </Row>
          </Card>
        ))}
      </Grid>
    </Card>
  );
}
