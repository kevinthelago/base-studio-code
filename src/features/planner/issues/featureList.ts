// The feature list (#…): the authoritative artifact of the Features stage. Each entry is a
// capability AND a fleet stream, carrying a dependency DAG (`dependsOn`). The planner writes them to
// plan.db (surfaced by the poll as the `features` section); the Features board renders it and the
// gate signal reads it. Issues are generated FROM features at publish — `featuresToPlanIssues`.
// Pure + tolerant of partial/malformed input — no React/Tauri.

import type { PlanIssue } from "./planIssues";
import { slugify } from "@/shared/lib/core/format";

export interface PlanFeature {
  /** Stable slug / stream id (kebab-case). */
  slug: string;
  /** Capability name ("Invite teammates", "Geometry kernel"). Not just user-facing — a feature can
   *  be foundational (others depend on it). */
  name: string;
  /** What it does + when, in the user's terms. */
  behavior?: string;
  /** Done-when checklist a building agent verifies against. */
  acceptance?: string[];
  /** The build approach — the shape of the solution. */
  approach?: string;
  /** Specific libraries / services / frameworks. */
  tools?: string[];
  /** Feature slugs this feature builds on — the coarse roadmap DAG (#plan-db). Must stay acyclic. */
  dependsOn?: string[];
  /** What it stores/reads. */
  data?: string;
  /** The fleet stream that owns it (defaults to the slug — a feature IS a stream). */
  stream?: string;
  /** Algorithm impl ids from the GLOBAL `bsc graph` store this capability needs (#4080) — the plan →
   *  algorithms-graph edge, so a worker is pointed at the reference implementation instead of re-coding
   *  it. DECLARED intent (the planner names them at Features time), not derived fact. */
  requires?: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((s) => s.trim());
  return out.length ? out : undefined;
}
/** Parse `features.json` (a JSON array of feature objects) into a clean list. Tolerant: bad JSON
 *  ⇒ []; entries missing both slug and name are dropped; duplicate slugs are de-duped; a missing
 *  slug is derived from the name, and stream defaults to the slug. */
export function parseFeaturesFile(raw: string): PlanFeature[] {
  if (!raw.trim()) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const out: PlanFeature[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name) ?? "";
    const slug = str(o.slug) ?? slugify(name, 60);
    if (!slug || !name || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug, name,
      behavior: str(o.behavior),
      acceptance: strArray(o.acceptance),
      approach: str(o.approach),
      tools: strArray(o.tools),
      dependsOn: strArray(o.dependsOn ?? o.depends_on),
      // Both spellings, like `dependsOn` — the store emits camelCase, but a hand-written or older
      // payload may carry snake, and silently dropping it would lose the reference entirely.
      requires: strArray(o.requires ?? o.requires_),
      data: str(o.data),
      stream: str(o.stream) ?? slug,
    });
  }
  return out;
}

/** A feature is fully defined once it has a name, behavior, and ≥1 acceptance criterion — enough
 *  for the Plan stage to decompose it into agent-ready issues. */
export function featureDefined(f: PlanFeature): boolean {
  return !!f.name && !!f.behavior && (f.acceptance?.length ?? 0) > 0;
}

/** The Features-gate summary: how many capabilities exist, and whether ALL are fully defined. */
export function featuresSummary(features: PlanFeature[]): { count: number; allConfirmed: boolean } {
  return { count: features.length, allConfirmed: features.length > 0 && features.every(featureDefined) };
}

/**
 * Whether the Features stage may COMPLETE (#plan-db): every feature populated AND the user has
 * confirmed the set. The user-confirm is the boundary that stops a single fully-populated feature
 * from auto-advancing the stage — the planner works titles-first, then the user confirms at the end.
 */
export function featuresGateComplete(summary: { allConfirmed: boolean }, userConfirmed: boolean): boolean {
  return summary.allConfirmed && userConfirmed;
}

/** Whether to OFFER the one-click confirm: every feature is populated but the user hasn't confirmed
 *  yet. While features are still being populated, no confirm is offered (the gate stays closed). */
export function featuresAwaitingConfirm(summary: { allConfirmed: boolean }, userConfirmed: boolean): boolean {
  return summary.allConfirmed && !userConfirmed;
}

/** The extra prose (beyond acceptance/owns/dependsOn, which `renderIssueBody` adds) for a feature's
 *  published issue: its behavior + approach + data + tools. */
function featureBody(f: PlanFeature): string | undefined {
  const parts: string[] = [];
  if (f.behavior?.trim()) parts.push(f.behavior.trim());
  if (f.approach?.trim()) parts.push(`## Approach\n${f.approach.trim()}`);
  if (f.data?.trim()) parts.push(`## Data\n${f.data.trim()}`);
  if (f.tools?.length) parts.push(`## Tools\n${f.tools.map((t) => `- ${t}`).join("\n")}`);
  return parts.join("\n\n").trim() || undefined;
}

/**
 * Project features into the issues published from them (#plan-db) — ONE issue per feature. Issues
 * aren't authored during planning; this is what publish (and the structure card) generate from the
 * DB features. The feature's slug becomes the issue `ref`, so a `dependsOn` between features is a
 * `dependsOn` between issues; acceptance carries over; behavior/approach/data/tools become the
 * body. `owns`/`labels` are left to the fleet (assigned to the stream in the Permissions stage).
 */
export function featuresToPlanIssues(features: PlanFeature[]): PlanIssue[] {
  return features.map((f) => ({
    ref: f.slug,
    title: f.name || f.slug,
    acceptance: f.acceptance ?? [],
    owns: [],
    dependsOn: f.dependsOn ?? [],
    labels: [],
    stream: f.stream ?? f.slug,
    body: featureBody(f),
  }));
}

/**
 * Find a cycle in the feature dependency DAG (#plan-db) — a cycle is a planning deadlock and holds
 * the Features gate. Returns the slugs on the first cycle found (e.g. `["a","b","a"]`) or `[]` when
 * acyclic. Edges to unknown slugs are ignored (a dangling dep isn't a cycle). Iterative-style DFS
 * with a colour map; self-deps (`a → a`) count.
 */
export function featureDependencyCycle(features: PlanFeature[]): string[] {
  const bySlug = new Map(features.map((f) => [f.slug, f]));
  const color = new Map<string, 1 | 2>(); // 1 = on the current path, 2 = fully explored
  const path: string[] = [];
  let found: string[] = [];

  const visit = (slug: string): boolean => {
    if (color.get(slug) === 2) return false;
    if (color.get(slug) === 1) {
      found = path.slice(path.indexOf(slug)).concat(slug); // back-edge → extract the cycle
      return true;
    }
    color.set(slug, 1);
    path.push(slug);
    for (const dep of bySlug.get(slug)?.dependsOn ?? []) {
      if (bySlug.has(dep) && visit(dep)) return true;
    }
    path.pop();
    color.set(slug, 2);
    return false;
  };

  for (const f of features) {
    if (color.get(f.slug) !== 2 && visit(f.slug)) break;
  }
  return found;
}
