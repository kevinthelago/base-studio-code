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
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import type { GNode } from "./lib/glanceGraph";
import { GLANCE_NODE_ANIM_CLASSES, ensureGlanceNodeMotion } from "./glanceNodeMotion";
import { progressFraction } from "./lib/streamProgress";

/** Which live state the node's motion should express, or `null` for a still node. */
export type GlanceNodeState = "building" | null;

export interface GlanceNodeProps {
  n: GNode;
  /** Precomputed by the canvas — the border precedence chain it owns. */
  border: string;
  boxShadow: string;
  /** Health dot colour + whether it pulses (axis 1). */
  healthColor: string;
  healthPulse: boolean;
  /** Pulse CHARACTER (#4052) — an alarm (fast + haloed, `error`) vs a breath (slow + bare,
   *  `modifying`). Both optional so the alarm stays the default and `error` renders unchanged. */
  healthPulseMs?: number;
  healthGlow?: boolean;
  /** Lit only by a DOWNSTREAM dep — dimmed, never pulses, so the eye lands on the fault's ORIGIN. */
  inherited: boolean;
  /** The lower-left FUNCTION chip — fleet (L1) nodes only (#4052). Both absent ⇒ the slot renders
   *  nothing at all, which is how an L0 project node reads now that the lifecycle axis is gone. */
  roleColor?: string;
  roleLabel?: string;
  /** Axis-2 word + its colour, and whether it pulses (suppressed while the NODE itself animates).
   *  ABSENT on an L0 project node (#4058), which reads on health + edges alone. */
  bottomText?: string;
  bottomColor: string;
  bottomPulse: boolean;
  /** The user-deactivated / degraded reads, which suppress the completion marker. */
  isOff: boolean;
  degraded: boolean;
  ownDegraded: boolean;
  /** The live motion state, or null. */
  state: GlanceNodeState;
  /** Owned-issue completion (#4050), or 0 for "no bar". Presentational only. */
  progress?: { done: number; total: number };
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
        // `relative` so the progress bar can sit on the bottom edge; `overflow: hidden` keeps it inside
        // the rounded corners.
        position: "relative", overflow: "hidden" }}>
      <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {/* Axis-1 health DOT. Restored in #4040 with the glow gone — health is a colour, and without
            this the node had no colour surface for it at all. An INHERITED dot is dimmed and never
            pulses, so the eye lands on the ORIGIN of a fault rather than everything downstream
            (#2541). */}
        {/* The reason rides on the DOT (#4058). It used to be the activity word's `title`, which an L0
            project node no longer renders — without this, hovering a degraded project would explain
            nothing and the reason would live only in the inspector. */}
        <Box title={`${n.rollupHealth}${p.inherited ? " (downstream)" : ""}${n.reason ? ` — ${n.reason}` : ""}`}
          style={{ width: 8, height: 8, borderRadius: "50%", background: p.healthColor, flex: "none", opacity: p.inherited ? 0.5 : 1,
            boxShadow: p.healthPulse && !p.inherited && p.healthGlow !== false ? `0 0 8px ${p.healthColor}` : "none",
            animation: p.healthPulse && !p.inherited ? `glance-softpulse ${p.healthPulseMs ?? 1400}ms ease-in-out infinite` : "none" }} />
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
      {/* The axis-2 row — FLEET (L1) nodes only (#4058). An L0 project node carries just two things:
          its EDGES (how it interacts with other projects) and its HEALTH (the state of the project).
          The activity word restated, in the weaker channel, what the dot already says: the build state
          IS the lifecycle indicator (`modifying`), maintenance is INFERRED from a project that is
          running clean and unmodified, and attention is grabbed by `warning`/`error`. With no label and
          no word the whole row is empty, so it is not rendered at all rather than left as dead space. */}
      {(p.roleLabel || p.bottomText) && (
        <Box style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 9 }}>
          {p.roleLabel && (
            <Text as="span" mono size={10} style={{ textTransform: "uppercase", letterSpacing: ".5px", color: p.roleColor }}>{p.roleLabel}</Text>
          )}
          <Box style={{ flex: 1 }} />
          {/* #4027 — the FINISHED marker. Static and to the LEFT of the word, so a completed node is
              legible at a glance without reading its label. */}
          {p.bottomText && n.activity === "complete" && !p.isOff && !p.degraded && (
            <Text as="span" mono size={10} weight={600} aria-hidden
              style={{ color: "var(--graph-health-healthy)", marginRight: 4, flex: "none" }}>✓</Text>
          )}
          {/* Axis-2 activity word, or the fault reason when degraded. */}
          {p.bottomText && (
            <Text as="span" mono size={10} weight={500} title={p.ownDegraded && n.reason ? n.reason : n.activity === "complete" ? n.reason : undefined}
              style={{ color: p.bottomColor, maxWidth: 108, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                animation: p.bottomPulse ? "glance-softpulse 1.4s ease-in-out infinite" : "none" }}>{p.bottomText}</Text>
          )}
        </Box>
      )}
      {/* #4050 — owned-issue progress: a thin fill on the bottom edge, `done / total`.
          Rendered only when the stream OWNS issues: an empty bar and a zero-progress bar say different
          things, and drawing one for a node with no work would say the false one.
          Coloured with the COMPLETE blue, so a full bar and the `complete` state agree by construction
          rather than by coincidence. `pointer-events: none` so it never eats a click on the node. */}
      {p.progress && p.progress.total > 0 && (
        <Box aria-hidden title={`${p.progress.done}/${p.progress.total} issues complete`}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, pointerEvents: "none",
            background: "color-mix(in oklch, var(--fg-muted) 22%, transparent)" }}>
          <Box style={{ width: `${progressFraction(p.progress) * 100}%`, height: "100%",
            background: "var(--graph-health-complete)", transition: "width .3s ease" }} />
        </Box>
      )}
    </Box>
  );
}
