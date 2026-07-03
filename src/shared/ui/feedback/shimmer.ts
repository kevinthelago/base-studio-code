// The shared loading-shimmer style atom (#2234) — a moving gradient. Spread onto any Box:
// `<Box style={{ ...shimmer, width, height }} />`, or use the <Skeleton> component. Promoted from the
// blueprint-import loading rows (#2128) so the whole app has ONE skeleton look (keyframe
// `skeleton-shimmer`, tokens.css). Kept in a non-component module so component files fast-refresh.
import type { CSSProperties } from "react";

export const shimmer: CSSProperties = {
  background: "linear-gradient(90deg,var(--bg-elev) 0%,var(--bg-elev2) 50%,var(--bg-elev) 100%)",
  backgroundSize: "260px 100%", animation: "skeleton-shimmer 1.1s linear infinite",
};
