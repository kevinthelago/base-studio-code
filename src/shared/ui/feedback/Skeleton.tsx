// Skeleton (#2234) — the shared loading placeholder. A shimmering block that keeps a page's LAYOUT
// present while data loads, instead of a blank screen: a card body renders skeletons shaped like the
// content it's waiting for. Pairs with EmptyState (the no-data view) — a card body is one of three:
// loading skeleton · compact empty state · content.
//
// Built on the existing layout primitive (Box) + the `shimmer` style atom (./shimmer), promoted from the
// blueprint-import loading rows (#2128), so the whole app shares ONE skeleton look (keyframe
// `skeleton-shimmer`, tokens.css). Use the component, or spread `shimmer` onto any Box directly.
import type { CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { shimmer } from "./shimmer";

export interface SkeletonProps {
  /** Width — number (px) or CSS length. Default "100%". */
  w?: number | string;
  /** Height — number (px) or CSS length. Default 12. */
  h?: number | string;
  /** Corner radius (px). Default 6. */
  radius?: number;
  style?: CSSProperties;
}

/** A single shimmering block (a Box with the shimmer style). */
export function Skeleton({ w = "100%", h = 12, radius = 6, style }: SkeletonProps) {
  return <Box aria-hidden radius={radius} style={{ width: w, height: h, ...shimmer, ...style }} />;
}

/** A stack of shimmer lines (the last one short) — a text/paragraph placeholder. */
export function SkeletonText({ lines = 3, gap = 8, lineH = 11 }: { lines?: number; gap?: number; lineH?: number }) {
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} h={lineH} w={i === lines - 1 ? "60%" : "100%"} />
      ))}
    </Box>
  );
}

/** A block sized like a chart/graph — a shimmer rectangle at the chart's height. */
export function SkeletonChart({ height = 130 }: { height?: number }) {
  return <Skeleton w="100%" h={height} radius={8} />;
}
