// MarketBody — right-pane body for the "market" planning stage (#2430): the desk-research market
// assessment. READ-FOCUSED by design (the UI-as-read-only direction, #2382): the planner does all
// the editing via `bsc plan market set`; this pane renders the recorded artifact — the gap-statement
// summary, the six-dimension scored rubric (weighted by the blueprint CATEGORY's rubric weights),
// the competitor landscape, and the go/caution/no-go verdict.

import { useAppStore } from "@/store";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Chip, type ChipTone } from "@/shared/ui/data/Chip";
import { FillBar } from "@/shared/ui/data/FillBar";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Card } from "./bodyPrimitives";
import {
  MARKET_DIMENSIONS, marketWeights, marketDimensionMeta, weightedMarketScore, marketContribution,
  type MarketConfig, type MarketRecommendation,
} from "../lib/marketConfig";

/** Verdict chip tones: go=success · caution=accent (amber IS this app's accent, the `.tag amber`
 *  convention) · no-go=danger. */
const VERDICT_TONE: Record<MarketRecommendation, ChipTone> = {
  go: "success", caution: "accent", "no-go": "danger",
};

/** Score-band color for the per-dimension fill: 1-2 danger · 3 accent · 4-5 success. */
function scoreColor(score: number): string {
  return score <= 2 ? "var(--danger)" : score === 3 ? "var(--accent)" : "var(--success)";
}

export function MarketBody({ projectId }: { projectId?: string }) {
  const pid = projectId ?? "";
  const cfg: MarketConfig | null = useAppStore((s) => s.planMarketConfig[pid] ?? null);
  // The active blueprint's lifecycle category selects the weight table (greenfield weighs
  // reachable-market/timing; transform/harden weigh severity/gap). Unbound → greenfield.
  const category = useAppStore((s) => s.blueprints.find((b) => b.id === s.projectBlueprintId[pid])?.category);
  const weights = marketWeights(category);

  if (!cfg) {
    return (
      <EmptyState
        iconVariant="dashed" icon="◔" title="No market assessment yet"
        description="The planner records this via bsc plan market set."
      />
    );
  }

  const total = weightedMarketScore(cfg, weights);
  const verdict = cfg.verdict;
  const competitors = cfg.competitors ?? [];
  const sizing = Object.entries(cfg.sizing ?? {});

  return (
    <Stack gap={8}>
      {/* The gap statement — the synthesis headline. */}
      {cfg.summary?.trim() && (
        <Card label="Gap statement">
          <Text as="div" size={11.5} style={{ lineHeight: 1.55, color: "var(--fg)" }}>{cfg.summary}</Text>
        </Card>
      )}

      {/* The scored rubric — six rows, each weighted by the blueprint category's table. */}
      <Card
        label="Scored rubric"
        hint={`${category ?? "greenfield"} weights`}
        badge={<Chip tone="accent" size="xs" title="The 0-100 weighted total across the six dimensions">{total}/100</Chip>}
      >
        <Stack gap={7}>
          {MARKET_DIMENSIONS.map((id) => {
            const meta = marketDimensionMeta(id);
            const s = cfg.scores[id];
            const score = s?.score ?? 0;
            const sources = (s?.sources ?? []).filter((src) => src.trim());
            const contribution = marketContribution(cfg, id, weights);
            return (
              <Row key={id} gap={8} data-testid={`market-dim-${id}`}>
                <Text mono size={10} tone="muted" title={meta.blurb} style={{ width: 118, flex: "0 0 auto" }}>
                  {meta.label}
                </Text>
                <FillBar value={score / 5} color={scoreColor(score)} height={6} style={{ flex: 1 }} />
                <Text mono size={10} style={{ width: 26, textAlign: "right", color: "var(--fg)" }}>
                  {s ? `${score}/5` : "—"}
                </Text>
                <Text
                  mono size={9.5} tone="dim" style={{ width: 44, textAlign: "right" }}
                  title={s?.rationale ?? ""}
                >
                  +{contribution.toFixed(1)}
                </Text>
                <Text
                  mono size={9.5} tone="dim" style={{ width: 40, textAlign: "right" }}
                  title={sources.join("\n")}
                >
                  {sources.length} src
                </Text>
              </Row>
            );
          })}
        </Stack>
      </Card>

      {/* Bottom-up sizing figures (TAM/SAM/SOM), when recorded. */}
      {sizing.length > 0 && (
        <Card label="Sizing">
          <Stack gap={4}>
            {sizing.map(([k, v]) => (
              <Row key={k} gap={8}>
                <Text mono size={10} tone="dim" style={{ textTransform: "uppercase" }}>{k}</Text>
                <Spacer />
                <Text mono size={10.5} style={{ color: "var(--fg)" }}>{String(v)}</Text>
              </Row>
            ))}
          </Stack>
        </Card>
      )}

      {/* The competitor landscape matrix, when recorded. */}
      {competitors.length > 0 && (
        <Card label="Competitors" hint={`${competitors.length}`}>
          <Stack gap={4}>
            {competitors.map((c) => (
              <Row key={c.name} gap={8} data-testid={`market-competitor-${c.name}`}>
                <Text mono size={10.5} style={{ color: "var(--fg)" }} title={c.source ?? ""}>{c.name}</Text>
                {c.segment && <Chip tone="neutral" size="xs">{c.segment}</Chip>}
                <Spacer />
                {c.pricing && <Text mono size={10} tone="muted">{c.pricing}</Text>}
              </Row>
            ))}
          </Stack>
        </Card>
      )}

      {/* The verdict — the user confirms the stage on top of this. */}
      {verdict && (
        <Card label="Verdict" accent>
          <Row gap={8} align="start" data-testid="market-verdict">
            <Chip tone={VERDICT_TONE[verdict.recommendation] ?? "neutral"} size="md" dot>
              {verdict.recommendation}
            </Chip>
            <Text as="div" size={11} tone="muted" style={{ lineHeight: 1.5 }}>{verdict.rationale}</Text>
          </Row>
        </Card>
      )}
    </Stack>
  );
}
