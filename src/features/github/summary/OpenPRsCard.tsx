// Open pull-requests card — open PRs across all sampled repos (#1644).

import type { OpenPR } from "../lib/githubSummary";
import { Chip } from "@/shared/ui/data/Chip";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { Button } from "@/shared/ui/controls/Button";
import { CardEmpty, SkeletonRows } from "./cardStates";

export function OpenPRsAllRepos({ prs, loading }: {
  prs: OpenPR[];
  loading: boolean;
}) {
  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Open pull requests"
      hint={loading ? "loading…" : `${prs.length} across all repos`}
      right={<Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>filter by reviewer</Button>}
      headMb={10}
    >
      {loading && prs.length === 0 && <SkeletonRows rows={3} h={40} />}
      {!loading && prs.length === 0 && (
        <CardEmpty icon="⇄" title="No open pull requests" hint="Open PRs across your repos surface here." />
      )}
      {prs.length > 0 && (
        <Box border="soft" radius={6} style={{ overflow: "hidden" }}>
          {prs.map((p, i) => (
            <Grid key={p.n + p.repo} cols="50px 1fr auto 50px" gap={10} align="baseline" style={{
              padding: "10px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              fontSize: 11,
              borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
            }}>
              <Text as="span" mono tone="dim">{p.n}</Text>
              <Box style={{ minWidth: 0 }}>
                <Box style={{ color: "var(--fg)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.t}</Box>
                <Box className="mono" style={{ marginTop: 3, fontSize: 10, color: "var(--fg-dim)" }}>@{p.who} · {p.repo}</Box>
              </Box>
              {p.draft && <Chip style={{ fontSize: 9.5 }}>draft</Chip>}
              <Text as="span" mono size={10} tone="dim" style={{ textAlign: "right" }}>{p.age}</Text>
            </Grid>
          ))}
        </Box>
      )}
    </Card>
  );
}
