// InlineError — the small mono danger callout (#2138). A static, bordered, danger-toned box that
// wraps a short error string in monospace. The pattern was pasted ~identically at every place that
// surfaced a failed action or query (the delete-project modal, the published-projects list, the
// board query banner), so it lives here once.
//
// This is deliberately its own primitive rather than a Banner tone: Banner is a status STRIP (louder
// tint, optional lead/dismiss/right slots, a flex row), whereas this is a plain read-only callout —
// danger-colored monospace text on the fixed 88%-transparent danger wash, no icon, no dismiss. The
// only per-site knobs are padding, corner radius, and the border tint (60% vs 70%), all exposed so
// each call site renders pixel-identical to the inline version it replaced. `style` passes through
// for the per-site margin.

import type { CSSProperties, ReactNode } from "react";
import { Box, type Radius } from "@/shared/ui/layout/Box";
import type { Space } from "@/shared/ui/layout/space";

export interface InlineErrorProps {
  /** The error message. */
  children: ReactNode;
  /** Inner padding — a rung/px or a [block, inline] pair. Default [8, 12]. */
  pad?: Space | [Space, Space];
  /** Corner radius — a rung (sm/md/lg → --r-*) or raw px. Default 4. */
  radius?: Radius;
  /** Border tint — the transparency % of --danger in the 1px border. Default 70 (some sites use 60). */
  borderFade?: number;
  className?: string;
  style?: CSSProperties;
}

/** InlineError — the shared mono danger callout: monospace, danger-colored text on a translucent
 *  danger wash with a matching hairline border. Renders its message children; nothing else. */
export function InlineError({
  children, pad = [8, 12], radius = 4, borderFade = 70, className, style,
}: InlineErrorProps) {
  return (
    <Box
      className={"mono" + (className ? ` ${className}` : "")}
      pad={pad}
      radius={radius}
      bg="color-mix(in oklch, var(--danger), transparent 88%)"
      border={`color-mix(in oklch, var(--danger), transparent ${borderFade}%)`}
      style={{ fontSize: 11, color: "var(--danger)", ...style }}
    >
      {children}
    </Box>
  );
}
