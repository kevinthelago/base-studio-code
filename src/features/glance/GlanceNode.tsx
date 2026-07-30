// The fleet/project NODE card (#4032) — extracted from the inline JSX in `GlanceCanvas`'s node map so
// it is a real component the designer can reach, and so its live states are authored MOTION DATA
// (`@/shared/ui/kit/glanceNodeAnimations`) rather than a raw keyframe in `glance.css` plus an inline
// `boxShadow`.
//
// ── THE STATE VOCABULARY ────────────────────────────────────────────────────────────────────────
// Three states, three motions, and the differences are deliberate:
//   · building  BREATHES — the worker is working (#4015)
//   · attention RINGS    — it is blocked on a PERSON, the one state that needs someone (#4005)
//   · complete  is STILL — finished; motion means "look at this", and this needs nothing (#4027)
//
// The first two come from the compiled kit CSS, bound to `data-node-state`. The third is the ABSENCE
// of an animation, which is why there is no `complete` entry in the motion data.
//
// ── WHAT STAYED IN THE CANVAS ───────────────────────────────────────────────────────────────────
// Everything positional and model-derived: layout, the border precedence chain (selected → preview →
// off → error → cycle → focus), the health rollup, push offsets. Those are graph CONCERNS, not node
// presentation, and threading them out would have made this a worse component, not a more reusable
// one. This owns the card's body: its states, its dot, its two label rows.
import type React from "react";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { GNode } from "./lib/glanceGraph";
import { GLANCE_NODE_ANIM_CLASSES, ensureGlanceNodeMotion } from "./glanceNodeMotion";

/** Which live state the node's motion should express, or `null` for a still node. */
export type GlanceNodeState = "building" | "attention" | null;

export interface GlanceNodeProps {
  n: GNode;
  /** Precomputed by the canvas — the border precedence chain it owns. */
  border: string;
  boxShadow: string;
  /** Health dot colour + whether it pulses (axis 1). */
  healthColor: string;
  healthPulse: boolean;
  /** Lit only by a downstream dep — dimmed, never pulses. */
  inherited: boolean;
  /** The role/category accent for the lower-left label. */
  roleColor: string;
  roleLabel: string;
  /** Axis-2 word + its colour, and whether it pulses (suppressed while the NODE itself animates). */
  bottomText: string;
  bottomColor: string;
  bottomPulse: boolean;
  /** The user-deactivated / degraded reads, which suppress the completion marker. */
  isOff: boolean;
  degraded: boolean;
  ownDegraded: boolean;
  /** The live motion state, or null. */
  state: GlanceNodeState;
}

export function GlanceNode(p: GlanceNodeProps) {
  const { n } = p;
  // Idempotent + cheap (one string compare after the first call). Done HERE rather than at the canvas
  // so the component carries its own motion: anything that renders a node gets the CSS, and nothing
  // has to remember to mount it.
  ensureGlanceNodeMotion();
  return (
    <Box
      // The applying classes + the state attribute ARE the binding: the compiled kit CSS scopes each
      // animation to `[data-node-state="…"]`, so a designer reading the record sees which state each
      // animation belongs to without any class bookkeeping here.
      className={GLANCE_NODE_ANIM_CLASSES}
      data-node-state={p.state ?? undefined}
      style={{ width: "100%", height: "100%", background: "var(--bg-elev)", border: `1px solid ${p.border}`,
        borderRadius: 9, padding: "10px 12px", display: "flex", flexDirection: "column", justifyContent: "center",
        boxShadow: p.boxShadow, transition: "border-color .15s, box-shadow .15s",
        // #4034 — the glow reads its colour from HERE, so one animation serves every health state and
        // retuning the palette never touches the motion. `position/overflow` keep the wash inside the
        // node's rounded corners.
        ["--node-health" as string]: p.healthColor,
        position: "relative", overflow: "hidden" } as React.CSSProperties}>
      {/* #4034 — the health glow: a radial wash at the top-left, pulsing + growing, animated by the
          authored `health-glow` kit animation. Suppressed on a deactivated node, which is meant to read
          calm — the one place the node is deliberately inert. `pointer-events: none` so it never eats a
          click meant for the node. */}
      {!p.isOff && (
        <Box data-node-glow aria-hidden style={{
          // Wider than the node is tall (NH 66) and over half its width (NW 186), so the wash reads as
          // lighting the corner rather than as a dot in it. `overflow: hidden` on the card clips it to the
          // rounded corner, so oversizing costs nothing visually.
          position: "absolute", top: 0, left: 0, width: 200, height: 160, pointerEvents: "none",
          transformOrigin: "0% 0%", borderRadius: "inherit",
          background: "radial-gradient(circle at 0% 0%, var(--node-health) 0%, transparent 78%)",
        }} />
      )}
      <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Axis-1 health dot. Error pulses at the ORIGIN; an inherited dot is dimmed (no pulse). */}
        <Box title={`${n.rollupHealth}${p.inherited ? " (downstream)" : ""}`}
          style={{ width: 8, height: 8, borderRadius: "50%", background: p.healthColor, flex: "none", opacity: p.inherited ? 0.5 : 1,
            boxShadow: p.healthPulse && !p.inherited ? `0 0 8px ${p.healthColor}` : "none",
            animation: p.healthPulse && !p.inherited ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }} />
        <Text as="span" mono size={13} weight={600} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.slug}</Text>
        {/* The APP-TYPE discriminator (#3786/#3802) — a subtle mono micro-label on the title line: what
            KIND of app this endpoint is (api/serverless/cli/…). Gated on a non-default classification,
            so an unclassified project (appType absent, or "application") renders byte-identical. */}
        {n.appType && n.appType !== "application" && (
          <Text as="span" mono size={8.5} title={`app type: ${n.appType}`}
            style={{ flex: "none", textTransform: "uppercase", letterSpacing: ".4px", color: "var(--fg-muted)", opacity: 0.7,
              border: "1px solid var(--border-soft)", borderRadius: 4, padding: "1px 4px", lineHeight: 1.3 }}>{n.appType}</Text>
        )}
      </Box>
      <Box style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
        <Text as="span" mono size={10} style={{ textTransform: "uppercase", letterSpacing: ".5px", color: p.roleColor }}>{p.roleLabel}</Text>
        <Box style={{ flex: 1 }} />
        {/* #4027 — the FINISHED marker. Static and to the LEFT of the word, so a completed node is
            legible at a glance without reading its label. */}
        {n.activity === "complete" && !p.isOff && !p.degraded && (
          <Text as="span" mono size={10} weight={600} aria-hidden
            style={{ color: "var(--graph-health-healthy)", marginRight: 4, flex: "none" }}>✓</Text>
        )}
        {/* Axis-2 activity word, or the fault reason when degraded. */}
        <Text as="span" mono size={10} weight={500} title={p.ownDegraded && n.reason ? n.reason : n.activity === "complete" ? n.reason : undefined}
          style={{ color: p.bottomColor, maxWidth: 108, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            animation: p.bottomPulse ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }}>{p.bottomText}</Text>
      </Box>
    </Box>
  );
}
