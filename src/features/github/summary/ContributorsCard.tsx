// Top-contributors card — commit counts across the sampled repos (#1644).

import { Avatar } from "@/shared/ui/data/Avatar";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import type { Contributor } from "../lib/githubSummary";

export function ContributorsCard({ contributors, loading }: {
  contributors: Contributor[];
  loading: boolean;
}) {
  const maxC = Math.max(...contributors.map(p => p.commits), 1);
  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Top contributors</h3>
        <span className="hint">{loading ? "loading…" : contributors.length > 0 ? `${contributors.length} contributors · all repos` : "no data"}</span>
      </Row>
      {contributors.length === 0 && !loading && (
        <Text mono size={11} tone="dim" as="div" style={{ padding: "4px 0" }}>
          No contributor data yet — GitHub is computing stats.
        </Text>
      )}
      <Stack gap={8}>
        {contributors.map(p => (
          <Grid key={p.login} cols="22px 1fr 1fr 80px" gap={10} align="center">
            <Avatar login={p.login} />
            <span className="mono" style={{ fontSize: 11, color: "var(--fg)" }}>@{p.login}</span>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-elev2)", overflow: "hidden" }}>
              <div style={{ width: `${p.commits / maxC * 100}%`, height: "100%", background: "var(--accent)" }} />
            </div>
            <span className="mono" style={{ fontSize: 10, color: "var(--fg-muted)", textAlign: "right" }}>{p.commits} commits</span>
          </Grid>
        ))}
      </Stack>
    </Card>
  );
}
