// ── Blueprint display helpers (#…): the blueprint's OWN hued icon tile, a visibility
// pill (draft / private gist / public gist), and a shortened gist link. ────────────────────────
//
// The tile used to be keyed off the lifecycle `category`, which #3785 removed from the model — and
// which had degenerated anyway: every packaged blueprint was `greenfield`, so all six cards drew the
// same glyph, the same hue, and the same meaningless "greenfield" badge. A blueprint is a
// goal/domain route now, so it carries its own `icon`/`h` (CRM → hub, HR → group, …) and the card
// renders those, exactly as the setup page already did.
import { timeAgoMs, truncate } from "@/shared/lib/core/format";
import type { Blueprint, BlueprintGist, BlueprintStage } from "../stages/blueprints";

/** The fallback accent hue for a blueprint that declares no `h` — matches the setup page's `?? 70`. */
export const DEFAULT_BLUEPRINT_HUE = 70;

/** A blueprint's accent colour, from its own hue. */
export function blueprintHue(h?: number): string {
  return `oklch(0.75 0.13 ${h ?? DEFAULT_BLUEPRINT_HUE})`;
}

/** The icon NAME a blueprint's tile renders (an `<Ic>` glyph). A blueprint that declares none falls
 *  back to `category` — the generic grid glyph, which is what `Ic` itself resolves an unknown name
 *  to, made explicit here so the fallback is visible at the call site rather than a surprise.
 *  (Deliberately NOT the name's initial: `Ic` renders SVG paths, never letters, so an initial would
 *  silently resolve to this same generic glyph anyway.) */
export function blueprintIcon(b: Pick<Blueprint, "icon">): string {
  return b.icon ?? "category";
}
export function prettyGist(g?: BlueprintGist): string | undefined {
  if (!g) return undefined;
  if (g.url) {
    const s = g.url.replace(/^https?:\/\//, "").replace(/^www\./, "");
    return truncate(s, 32, 30);
  }
  return g.id ? `gist · ${g.id.slice(0, 7)}` : undefined;
}

/** A blueprint surfaced in the Projects page — a saved library or built-in blueprint. */
export interface BpItem {
  id: string;          // library blueprint id
  name: string;
  pitch: string;
  icon: string;        // the blueprint's own `<Ic>` glyph name
  h?: number;          // the blueprint's own accent hue
  stages: number;
  sections: BlueprintStage[];   // the blueprint's sections — drives the gate-row preview
  builtIn?: boolean;   // a code-owned app template (can't be deleted)
  gistLabel?: string;
  updatedLabel: string;
  sort: number;        // recency key (epoch ms)
}

/** Build the blueprint list surfaced in the rail: ALL blueprints — the built-in app templates AND
 *  the user's saved library — so a blueprint can be SELECTED for the next project right here
 *  (#blueprints). */
export function buildBlueprintItems(blueprints: Blueprint[]): BpItem[] {
  const items: BpItem[] = [];
  for (const b of blueprints) {
    const hasGist = !!b.gist?.id;
    const sortMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    items.push({
      id: b.id, name: b.name,
      pitch: b.pitch ?? b.desc ?? "",
      icon: blueprintIcon(b), h: b.h,
      stages: b.sections.length, sections: b.sections,
      builtIn: b.origin === "built-in",
      gistLabel: hasGist ? prettyGist(b.gist) : undefined,
      updatedLabel: timeAgoMs(sortMs), sort: sortMs,
    });
  }
  return items;
}
