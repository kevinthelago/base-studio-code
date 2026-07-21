// GraphLegend (#2909) — the shared on-canvas legend overlay for the graph pages (Algorithms / Designs /
// Teams), mirroring Glance's inline legend. A frosted corner card pinned over the canvas (it is NOT
// transformed — pass it to GraphCanvas's `overlays` slot), fed level-relevant rows from the SAME meta the
// canvas draws with, so the key never drifts from the graph.
//
// Two row kinds: a NODE row (a colored dot/bar swatch — a node kind/role) and an EDGE row (a short line
// swatch — an edge/relationship type, solid or dashed). Sections render as side-by-side columns. The card
// is `pointerEvents: none` so it never eats a click meant for the graph beneath it.
import type { CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

/** One node (kind/role) key row — a colored dot (default) or short bar + label. */
export interface LegendNode {
  label: string;
  color: string;
  shape?: "dot" | "bar";
}

/** One edge (relationship) key row — a short line swatch (color + dashed) + label. */
export interface LegendEdge {
  label: string;
  /** Line color; defaults to the neutral edge tone. */
  color?: string;
  dashed?: boolean;
}

/** A labelled column of rows. Provide `nodes` and/or `edges`; an empty section is dropped. */
export interface LegendSection {
  label: string;
  nodes?: LegendNode[];
  edges?: LegendEdge[];
}

const CORNER: Record<"br" | "bl", CSSProperties> = {
  br: { right: 16, bottom: 16 },
  bl: { left: 16, bottom: 16 },
};

/**
 * The shared on-canvas graph legend (#2909). Renders a frosted corner card of legend columns, or nothing
 * when no section has content. `corner` picks which corner it pins to (default bottom-right, like Glance).
 */
export function GraphLegend({ sections, corner = "br" }: { sections: LegendSection[]; corner?: "br" | "bl" }) {
  const shown = sections.filter((s) => (s.nodes?.length ?? 0) + (s.edges?.length ?? 0) > 0);
  if (!shown.length) return null;
  return (
    <Box
      className="graph-legend"
      style={{
        position: "absolute", ...CORNER[corner], zIndex: 3, pointerEvents: "none",
        display: "flex", gap: 20,
        padding: "11px 14px", borderRadius: 9,
        border: "1px solid var(--border)",
        background: "color-mix(in oklch, var(--bg-elev) 85%, transparent)",
        backdropFilter: "blur(8px)",
      }}
    >
      {shown.map((s) => (
        <Box key={s.label} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <Text mono size="xxs" tone="dim" style={{ letterSpacing: ".08em", textTransform: "uppercase" }}>{s.label}</Text>
          {s.nodes?.map((n) => (
            <Box key={n.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Box style={n.shape === "bar"
                ? { width: 11, height: 3, borderRadius: 2, background: n.color, flex: "none" }
                : { width: 8, height: 8, borderRadius: 2, background: n.color, flex: "none" }} />
              <Text size={11.5}>{n.label}</Text>
            </Box>
          ))}
          {s.edges?.map((e) => (
            <Box key={e.label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Box style={{ width: 22, height: 0, borderTop: `2px ${e.dashed ? "dashed" : "solid"} ${e.color ?? "var(--fg-dim)"}`, flex: "none" }} />
              <Text size={11.5}>{e.label}</Text>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
