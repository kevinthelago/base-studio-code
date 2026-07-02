// Language mix card — byte-count breakdown across the sampled repos (#1644).

import { useMemo } from "react";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Card } from "@/shared/ui/data/Card";
import { Text } from "@/shared/ui/typography/Text";
import { langColor, SUMMARY_REPO_SAMPLE } from "../lib/githubSummary";

export function LanguageMix({ langTotals, repoCount, totalRepos, loading }: {
  langTotals: Record<string, number>;
  /** Sampled repos that contributed language data. */
  repoCount: number;
  /** Total connected repos (the sample is capped at SUMMARY_REPO_SAMPLE). */
  totalRepos: number;
  loading: boolean;
}) {
  const entries = useMemo(() => {
    const total = Object.values(langTotals).reduce((s, b) => s + b, 0);
    if (total === 0) return [];
    return Object.entries(langTotals)
      .map(([n, b]) => ({ n, pct: Math.round(b / total * 100), c: langColor(n) }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 6);
  }, [langTotals]);

  // The summary only samples the most-recently-updated repos, so say so plainly:
  // "N of M repos" when capped, "N repos" otherwise. The tooltip spells out the cap.
  const sampled = Math.min(SUMMARY_REPO_SAMPLE, totalRepos);
  const capped = totalRepos > SUMMARY_REPO_SAMPLE;
  const repoLabel = capped
    ? `${repoCount} of ${sampled} sampled repos`
    : `${repoCount} repo${repoCount === 1 ? "" : "s"}`;
  const title = capped
    ? `Aggregated across the ${sampled} most-recently-updated of your ${totalRepos} repos${repoCount < sampled ? ` (${repoCount} had detected languages)` : ""}.`
    : undefined;

  return (
    <Card style={{ padding: "14px 16px" }}>
      <Row align="baseline" gap={10} style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Languages</h3>
        <Box as="span" className="hint" title={title}>{loading ? "loading…" : entries.length > 0 ? `by byte count · ${repoLabel}` : "no data"}</Box>
      </Row>
      {entries.length === 0 && !loading && (
        <Text mono size={11} tone="dim" as="div" style={{ padding: "4px 0" }}>No language data available.</Text>
      )}
      {entries.length > 0 && (
        <>
          <Row align="stretch" style={{ height: 10, borderRadius: 5, overflow: "hidden", background: "var(--bg-elev2)", marginBottom: 10 }}>
            {entries.map(l => (
              <Box key={l.n} title={`${l.n} · ${l.pct}%`} bg={l.c} style={{ width: `${l.pct}%`}} />
            ))}
          </Row>
          <Stack className="mono" gap={5} style={{ fontSize: 10.5, color: "var(--fg-muted)" }}>
            {entries.map(l => (
              <Grid key={l.n} cols="12px 1fr 40px" gap={8} align="center">
                <ColorSwatch color={l.c} />
                <Text as="span" style={{ color: "var(--fg)" }}>{l.n}</Text>
                <Text as="span" tone="dim" style={{ textAlign: "right" }}>{l.pct}%</Text>
              </Grid>
            ))}
          </Stack>
        </>
      )}
    </Card>
  );
}
