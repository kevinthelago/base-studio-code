// Pure facet / filter / sort logic for the Skills library screen (#1706). Extracted from
// SkillsScreen.tsx so the search + multi-facet filtering, the five sort orders, the facet
// definitions (with their live counts), the grouped/kind sectioning, and the telemetry merge
// are all unit-testable in isolation, free of React.
//
// Free of React / Tauri imports — mirrors lib/skills.ts.

import { KIND, type SkillKind, type SkillSource } from "@/shared/data/skills";
import { skillSlug, type SkillDef, type SkillGroup } from "./skills";
import type { SkillStats } from "./skillTelemetry";

const KIND_KEYS = Object.keys(KIND) as SkillKind[];
const SOURCE_KEYS: SkillSource[] = ["first-party", "team", "imported", "community"];

/** The four library densities (view modes). */
export type Density = "list" | "cards" | "grouped" | "kind";

/** The five library sort orders. */
export type SortKey = "Most invoked" | "Name (A–Z)" | "Success rate" | "Recently used" | "Recently added";

export const SORTS: SortKey[] = ["Most invoked", "Name (A–Z)", "Success rate", "Recently used", "Recently added"];

/** Stable pseudo-recency from the id so "Recently used/added" sort is deterministic in the demo. */
export const hashN = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

/** Merge the live telemetry (keyed by skill-name slug) over the library — a skill with no usage
 *  reads zero invocations / success / trend. */
export function mergeSkillStats(skills: SkillDef[], stats: Record<string, SkillStats>): SkillDef[] {
  return skills.map((s) => {
    const st = stats[skillSlug(s.name)];
    return st
      ? { ...s, invocations: st.invocations, success: st.successRate, trend: st.trend }
      : { ...s, invocations: 0, success: 0, trend: [] };
  });
}

/** Index of skillId → the task groups it belongs to (for the ⬡ membership badge). */
export function indexGroupsBySkill(skillGroups: SkillGroup[]): Map<string, SkillGroup[]> {
  const m = new Map<string, SkillGroup[]>();
  for (const g of skillGroups) for (const id of g.skillIds) {
    const a = m.get(id) ?? [];
    a.push(g);
    m.set(id, a);
  }
  return m;
}

export interface FacetOption {
  value: string;
  label: string;
  glyph: string;
  color: string;
  count: number;
  match: (s: SkillDef) => boolean;
}

export interface FacetDef {
  key: string;
  title: string;
  options: FacetOption[];
}

/** A facet selection: facet key → the set of selected option values. */
export type FacetSelection = Record<string, Set<string>>;

/** The facet column definitions, with each option's live count computed over `merged`. */
export function buildFacetDefs(merged: SkillDef[]): FacetDef[] {
  const c = (pred: (s: SkillDef) => boolean) => merged.filter(pred).length;
  return [
    { key: "kind", title: "Kind", options: KIND_KEYS.map((k) => ({ value: k, label: k, glyph: KIND[k].glyph, color: KIND[k].color, count: c((s) => s.kind === k), match: (s: SkillDef) => s.kind === k })) },
    { key: "source", title: "Source", options: SOURCE_KEYS.map((k) => ({ value: k, label: k, glyph: "", color: "", count: c((s) => s.source === k), match: (s: SkillDef) => s.source === k })) },
    { key: "scope", title: "Scope", options: [
      { value: "global", label: "global", glyph: "", color: "", count: c((s) => !s.projects.length), match: (s: SkillDef) => !s.projects.length },
      { value: "scoped", label: "project-scoped", glyph: "", color: "", count: c((s) => s.projects.length > 0), match: (s: SkillDef) => s.projects.length > 0 },
    ] },
    { key: "status", title: "Status", options: [
      { value: "enabled", label: "enabled", glyph: "", color: "", count: c((s) => s.enabled), match: (s: SkillDef) => s.enabled },
      { value: "disabled", label: "disabled", glyph: "", color: "", count: c((s) => !s.enabled), match: (s: SkillDef) => !s.enabled },
      { value: "pinned", label: "pinned", glyph: "", color: "", count: c((s) => s.pinned), match: (s: SkillDef) => s.pinned },
    ] },
    { key: "usage", title: "Usage", options: [
      { value: "used", label: "used · 7d", glyph: "", color: "", count: c((s) => s.invocations > 0), match: (s: SkillDef) => s.invocations > 0 },
      { value: "never", label: "never run", glyph: "", color: "", count: c((s) => s.invocations === 0), match: (s: SkillDef) => s.invocations === 0 },
    ] },
  ];
}

export interface FilterArgs {
  query: string;
  /** Selected task group id (single-select), or null for all. */
  groupFilter: string | null;
  skillGroups: SkillGroup[];
  facetDefs: FacetDef[];
  facetSel: FacetSelection;
  sort: SortKey;
}

/** Apply the group filter, free-text query, multi-facet filters (OR within a facet, AND across
 *  facets), then sort. Returns a fresh array; `merged` is never mutated. */
export function filterSkills(merged: SkillDef[], args: FilterArgs): SkillDef[] {
  const { query, groupFilter, skillGroups, facetDefs, facetSel, sort } = args;
  const q = query.trim().toLowerCase();
  let pool = merged;
  if (groupFilter) {
    const g = skillGroups.find((x) => x.id === groupFilter);
    const ids = new Set(g?.skillIds ?? []);
    pool = pool.filter((s) => ids.has(s.id));
  }
  if (q) pool = pool.filter((s) => (s.name + " " + s.desc + " " + s.tools.join(" ") + " " + s.source).toLowerCase().includes(q));
  for (const def of facetDefs) {
    const sel = facetSel[def.key];
    if (!sel?.size) continue;
    const opts = def.options.filter((o) => sel.has(o.value));
    pool = pool.filter((s) => opts.some((o) => o.match(s)));   // OR within a facet
  }
  const sorters: Record<SortKey, (a: SkillDef, b: SkillDef) => number> = {
    "Name (A–Z)": (a, b) => a.name.localeCompare(b.name),
    "Most invoked": (a, b) => b.invocations - a.invocations,
    "Success rate": (a, b) => (b.success || 0) - (a.success || 0),
    "Recently used": (a, b) => hashN(b.id + "u") - hashN(a.id + "u"),
    "Recently added": (a, b) => hashN(b.id + "a") - hashN(a.id + "a"),
  };
  return [...pool].sort(sorters[sort]);
}

export interface GroupedSection {
  id: string;
  label: string;
  glyph: string;
  hue: string;
  items: SkillDef[];
}

/** Section the filtered skills for the grouped / kind densities: by skill kind in "kind" density,
 *  else by task group (with an "Ungrouped" trailer for skills in no group). Empty sections drop. */
export function buildGroupedSections(density: Density, filtered: SkillDef[], skillGroups: SkillGroup[]): GroupedSection[] {
  if (density === "kind") {
    return KIND_KEYS
      .map((k) => ({ id: k, label: KIND[k].label, glyph: KIND[k].glyph, hue: KIND[k].color, items: filtered.filter((s) => s.kind === k) }))
      .filter((g) => g.items.length);
  }
  const sections: GroupedSection[] = skillGroups
    .map((g) => ({ id: g.id, label: g.name, glyph: "⬡", hue: g.hue, items: filtered.filter((s) => g.skillIds.includes(s.id)) }))
    .filter((g) => g.items.length);
  const grouped = new Set(skillGroups.flatMap((g) => g.skillIds));
  const ungrouped = filtered.filter((s) => !grouped.has(s.id));
  if (ungrouped.length) sections.push({ id: "__ungrouped__", label: "Ungrouped", glyph: "·", hue: "var(--fg-dim)", items: ungrouped });
  return sections;
}
