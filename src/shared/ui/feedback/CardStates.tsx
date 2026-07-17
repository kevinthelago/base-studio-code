// Per-card loading + empty states, shared across dashboards (#3246 — consolidated from the GitHub
// summary #2244, Fleet #2234, Insights #2243, and MCP/Hook analytics #2246/#2247 copies).
//
// A dashboard card keeps its frame + head; its BODY is one of three — a shimmer skeleton while its
// source loads · a compact empty state when there's no data · the content. Shared here so a card's
// body states don't each re-declare the pair.
import type { ReactNode } from "react";
import { Stack } from "@/shared/ui/layout/Stack";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

/** A compact empty state for a card body — the card frame + head stay; the body shows this. */
export function CardEmpty({ icon = "○", title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return <EmptyState size="sm" iconVariant="dashed" icon={icon} title={title} description={hint} style={{ padding: "20px 12px" }} />;
}

/** A stack of shimmer rows — a loading placeholder for a list/table/chart card body. */
export function SkeletonRows({ rows = 4, h = 30, gap = 6, radius = 6 }: { rows?: number; h?: number; gap?: number; radius?: number }) {
  return (
    <Stack gap={gap}>
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={h} radius={radius} />)}
    </Stack>
  );
}
