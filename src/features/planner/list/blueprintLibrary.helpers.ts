// ── Blueprint display helpers (#…): a hued icon tile keyed by lifecycle category, a visibility
// pill (draft / private gist / public gist), and a shortened gist link. ────────────────────────
import { Layers, GitFork, Shield, Wrench, Database } from "lucide-react";
import { timeAgoMs, truncate } from "@/shared/lib/core/format";
import { CATEGORY_META, type Blueprint, type BlueprintGist, type BlueprintCategory, type BlueprintStage } from "../stages/blueprints";
import type { DraftRow } from "./drafts";

export const CAT_ICON: Record<BlueprintCategory, typeof Layers> = {
  greenfield: Layers, transform: GitFork, harden: Shield, maintain: Wrench, data: Database,
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

/** A blueprint surfaced in the Projects page: either a saved library blueprint, or an in-progress
 *  authoring draft (a planning session bound to the blueprint-author lifecycle). */
export interface BpItem {
  id: string;          // library blueprint id, or "draft:<key>" for an authoring draft
  kind: "library" | "draft";
  draftKey?: string;   // present for authoring drafts (its resume / delete target)
  draftTitle?: string;
  draftPitch?: string;
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
 *  (#blueprints), plus any in-progress authoring drafts not yet saved. The saved/published version
 *  wins the dedup (by name) over a still-open authoring draft. */
export function buildBlueprintItems(
  blueprints: Blueprint[],
  authoringDrafts: DraftRow[],
  planAuthoredBlueprint: Record<string, Blueprint>,
): BpItem[] {
  const items: BpItem[] = [];
  const seen = new Set<string>();
  for (const b of blueprints) {
    seen.add(b.name.toLowerCase());
    const hasGist = !!b.gist?.id;
    const sortMs = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    items.push({
      id: b.id, kind: "library", name: b.name,
      pitch: b.pitch ?? b.desc ?? "",
      category: b.category ?? "greenfield",
      stages: b.sections.length, sections: b.sections,
      builtIn: b.origin === "built-in",
      gistLabel: hasGist ? prettyGist(b.gist) : undefined,
      updatedLabel: timeAgoMs(sortMs), sort: sortMs,
    });
  }
  for (const d of authoringDrafts) {
    const bp = planAuthoredBlueprint[d.key] as Blueprint | undefined;
    const name = bp?.name ?? d.title;
    if (seen.has(name.toLowerCase())) continue;
    items.push({
      id: "draft:" + d.key, kind: "draft", draftKey: d.key, draftTitle: d.title, draftPitch: d.pitch,
      name, pitch: bp?.pitch ?? bp?.desc ?? d.pitch ?? "",
      category: bp?.category ?? "greenfield",
      stages: bp?.sections?.length ?? 0, sections: bp?.sections ?? [],
      updatedLabel: timeAgoMs(d.sort), sort: d.sort,
    });
  }
  return items;
}
