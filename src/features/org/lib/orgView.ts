// Org view models (#2193) — pure presentation helpers that turn the org graph + the persona library +
// the vocabulary into the shapes the canvas + inspector render. React-free + unit-testable; the design
// prototype's per-role glyph/department metadata lives here (presentation only, not in the data model).
import type { SessionRole } from "@/shared/lib/session/sessionRoles";
import { roleCapability } from "@/shared/lib/session/sessionRoles";
import type { Persona } from "@/features/personas";
import { archetypeById, deriveCommunication, type CommunicationForm, type Org, type Position } from "./org";

/** Per-role display metadata — the department bucket (left-rail grouping) + a glyph. Presentation-only
 *  (the role gate itself carries no glyph); a role not listed falls back to a neutral default. */
export const ROLE_META: Record<string, { dept: string; glyph: string }> = {
  planner:    { dept: "Leadership",  glyph: "◆" },
  director:   { dept: "Leadership",  glyph: "◆" },
  worker:     { dept: "Engineering", glyph: "●" },
  issuer:     { dept: "Support",     glyph: "◇" },
  triage:     { dept: "Support",     glyph: "◇" },
  reviewer:   { dept: "Quality",     glyph: "◈" },
  tester:     { dept: "Quality",     glyph: "◈" },
  juror:      { dept: "Quality",     glyph: "▲" },
};

const KIND_GLYPH = { resource: "⬢", external: "◍" } as const;

export interface PositionDisplay {
  name: string;
  glyph: string;
  dept: string;
  /** The role tag (agents) — undefined for resource/external nodes. */
  role?: SessionRole;
  blurb: string;
  kind: Position["kind"];
}

/** Resolve a position's display fields, reading through to its persona for agent nodes. */
export function positionDisplay(pos: Position, personas: Persona[]): PositionDisplay {
  if (pos.kind !== "agent") {
    return {
      name: pos.label ?? pos.nodeId,
      glyph: KIND_GLYPH[pos.kind],
      dept: pos.kind === "resource" ? "Resource" : "External",
      blurb: pos.kind === "resource" ? "A shared resource the org stewards." : "An actor outside the org.",
      kind: pos.kind,
    };
  }
  const persona = personas.find((p) => p.id === pos.personaId);
  const role = persona?.role;
  const meta = (role && ROLE_META[role]) || { dept: "Team", glyph: "●" };
  return {
    name: pos.label ?? persona?.name ?? pos.nodeId,
    glyph: meta.glyph,
    dept: meta.dept,
    role,
    blurb: persona?.blurb ?? "",
    kind: "agent",
  };
}

export interface TierChip { label: string; tier: string }

/** The capability tiers a role carries, as `git·write`-style labels — omitting the `none` capabilities
 *  but always stating net as on/off (mirrors the design's node-card tier row). */
export function tierChips(role: SessionRole): TierChip[] {
  const cap = roleCapability(role);
  const out: TierChip[] = [];
  for (const k of ["git", "github", "code"] as const) {
    if (cap[k] !== "none") out.push({ label: `${k}·${cap[k]}`, tier: cap[k] });
  }
  out.push({ label: `net·${cap.net === "none" ? "off" : "on"}`, tier: cap.net === "none" ? "off" : "on" });
  return out;
}

export interface CommSummary {
  /** The relationship's other end. */
  counterpartNode: string;
  counterpartName: string;
  archetype: string;
  archetypeLabel: string;
  hue: number;
  /** Forms this position SENDS across the edge. */
  sends: CommunicationForm[];
  /** Forms this position RECEIVES across the edge. */
  receives: CommunicationForm[];
}

/** The per-relationship communication summary for a position — `deriveCommunication` grouped by
 *  counterpart+archetype, so the inspector shows one card per relationship (head = who, then the forms
 *  sent/received). This is the auto-derived "who I talk to and how", the generate-from-facets payoff. */
export function positionComms(org: Org, pos: Position, personas: Persona[]): CommSummary[] {
  const byKey = new Map<string, CommSummary>();
  for (const edge of deriveCommunication(org, pos.nodeId)) {
    const key = `${edge.withNode}:${edge.archetype}`;
    let sum = byKey.get(key);
    if (!sum) {
      const arch = archetypeById(edge.archetype);
      const other = org.positions.find((p) => p.nodeId === edge.withNode);
      sum = {
        counterpartNode: edge.withNode,
        counterpartName: other ? positionDisplay(other, personas).name : edge.withNode,
        archetype: edge.archetype,
        archetypeLabel: arch?.label ?? edge.archetype,
        hue: arch?.hue ?? 0,
        sends: [],
        receives: [],
      };
      byKey.set(key, sum);
    }
    (edge.dir === "out" ? sum.sends : sum.receives).push(edge.form);
  }
  return [...byKey.values()];
}

/** A CSS color for an archetype hue (oklch, so it sits in the same space as the app's tokens). */
export function hueColor(hue: number, l = 0.72, c = 0.13): string {
  return `oklch(${l} ${c} ${hue})`;
}

/** The accent color for a communication form, by its semantics (mirrors the design): authority-bearing
 *  forms are amber, blocking/advisory forms blue, the review gate purple, the rest neutral. */
export function formColor(form: CommunicationForm): string {
  if (form.id === "review") return hueColor(300, 0.75, 0.12);
  if (form.authority) return hueColor(70, 0.78, 0.12);
  if (form.id === "escalation" || form.id === "consult") return hueColor(250, 0.75, 0.12);
  return "var(--fg-dim)";
}

/** The direction glyph shown on a form chip (↓ down · ↑ up · ↔ lateral · → in/out · ⊘ the review gate). */
export function formArrow(form: CommunicationForm): string {
  if (form.id === "review") return "⊘";
  switch (form.direction) {
    case "down": return "↓";
    case "up": return "↑";
    case "lateral": return "↔";
    default: return "→";
  }
}
