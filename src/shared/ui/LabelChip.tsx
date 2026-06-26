// A GitHub issue/PR label chip (#1493) — colored pill with a dot, tinted from the label's
// 6-hex color. Consolidates the near-identical copies in the planner Issues / ProjectBoard views.

import type { GhLabel } from "@/shared/lib/github/types";

export function LabelChip({ label }: { label: GhLabel }) {
  const color = `#${label.color}`;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "1px 6px", borderRadius: 99,
      fontFamily: "var(--mono)", fontSize: 9,
      background: `${color}22`, color,
      border: `1px solid ${color}55`,
      whiteSpace: "nowrap",
    }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: color }} />
      {label.name}
    </span>
  );
}
