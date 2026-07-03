// Per-card loading + empty states for the GitHub summary dashboard (#2244).
//
// Mirrors the Fleet dashboard idiom (#2234): a card keeps its frame + head; its BODY is one of
// three — a shimmer skeleton while its GitHub source loads · a compact empty state when there's
// no data · the content. Shared here so the summary's cards don't each re-declare the pair.
import type { ReactNode } from "react";
import { Stack } from "@/shared/ui/layout/Stack";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
import { Skeleton } from "@/shared/ui/feedback/Skeleton";

/** A compact empty state for a card body — the card frame + head stay; the body shows this. */
export function CardEmpty({ icon = "○", title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return <EmptyState size="sm" iconVariant="dashed" icon={icon} title={title} description={hint} style={{ padding: "20px 12px" }} />;
}

/** A stack of shimmer rows — a loading placeholder for a list/table card body. */
export function SkeletonRows({ rows = 4, h = 30 }: { rows?: number; h?: number }) {
  return (
    <Stack gap={6}>
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} h={h} radius={6} />)}
    </Stack>
  );
}
