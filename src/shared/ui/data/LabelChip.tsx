// A GitHub issue/PR label chip (#1493) — colored pill with a dot, tinted from the label's
// 6-hex color. Consolidates the near-identical copies in the planner Issues / ProjectBoard views.

import type { GhLabel } from "@/shared/lib/github/types";
import { Chip } from "./Chip";

export function LabelChip({ label }: { label: GhLabel }) {
  // A GitHub label's colour is dynamic (6-hex) → the Chip `color` path. bg/border alphas approximate
  // the old `${color}22`/`${color}55` tints.
  return (
    <Chip color={`#${label.color}`} dot gap={4} padding="1px 6px" fontSize={9} bgAlpha={87} borderAlpha={67}>
      {label.name}
    </Chip>
  );
}
