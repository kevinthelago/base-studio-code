// ── Blueprint display helpers (#…): a hued icon tile keyed by lifecycle category, a visibility
// pill (draft / private gist / public gist), and a shortened gist link. ────────────────────────
import { Layers, GitFork, Shield, Wrench, Database, Zap } from "lucide-react";
import { timeAgoMs, truncate } from "@/shared/lib/core/format";
import { CATEGORY_META, type Blueprint, type BlueprintGist, type BlueprintCategory, type BlueprintStage } from "../stages/blueprints";

export const CAT_ICON: Record<BlueprintCategory, typeof Layers> = {
  greenfield: Layers, transform: GitFork, harden: Shield, maintain: Wrench, data: Database, script: Zap,
};
export function catHue(cat: BlueprintCategory): string {
  return `oklch(0.75 0.13 ${CATEGORY_META[cat]?.h ?? 70})`;
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
  category: BlueprintCategory;
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
      category: b.category ?? "greenfield",
      stages: b.sections.length, sections: b.sections,
      builtIn: b.origin === "built-in",
      gistLabel: hasGist ? prettyGist(b.gist) : undefined,
      updatedLabel: timeAgoMs(sortMs), sort: sortMs,
    });
  }
  return items;
}
