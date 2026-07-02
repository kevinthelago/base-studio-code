// Top-contributors card — commit counts across the sampled repos (#1644).

import { Avatar } from "@/shared/ui/data/Avatar";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Card } from "@/shared/ui/data/Card";
import { FillBar } from "@/shared/ui/data/FillBar";
import { Text } from "@/shared/ui/typography/Text";
import type { Contributor } from "../lib/githubSummary";

export function ContributorsCard({ contributors, loading }: {
  contributors: Contributor[];
  loading: boolean;
}) {
  const maxC = Math.max(...contributors.map(p => p.commits), 1);
  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Top contributors"
      hint={loading ? "loading…" : contributors.length > 0 ? `${contributors.length} contributors · all repos` : "no data"}
      headMb={10}
    >
      {contributors.length === 0 && !loading && (
        <Text mono size={11} tone="dim" as="div" style={{ padding: "4px 0" }}>
          No contributor data yet — GitHub is computing stats.
        </Text>
      )}
      <Stack gap={8}>
        {contributors.map(p => (
          <Grid key={p.login} cols="22px 1fr 1fr 80px" gap={10} align="center">
            <Avatar login={p.login} />
            <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>@{p.login}</Text>
            <FillBar value={p.commits / maxC} height={5} />
            <Text as="span" mono size={10} tone="muted" style={{ textAlign: "right" }}>{p.commits} commits</Text>
          </Grid>
        ))}
      </Stack>
    </Card>
  );
}
