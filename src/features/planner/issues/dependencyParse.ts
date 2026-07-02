// Parsing + basic selectors for the dependency manifest (#1111/#1127). Pure + tolerant: it parses the
// same shape whether it arrives from plan.db or a legacy `dependencies.json`, and the selectors below
// slice the parsed list per-repo / per-ecosystem for the writers and the worker block.

import type {
  DependencyEcosystem,
  DependencyManifest,
  DependencyRegistry,
  PlanDependency,
} from "@/features/planner/issues/dependencyTypes";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/**
 * Parse a stored dependency manifest (the plan.db blob, or a legacy `dependencies.json`) into the
 * full manifest (#1127). Accepts a bare JSON array of dependency
 * objects (the #1111 form, ⇒ no registries), or `{ "dependencies": [...], "registries": {...} }`.
 * Tolerant: bad JSON ⇒ empty manifest; a dependency without a name or a recognized ecosystem
 * (`npm` | `cargo`) is dropped; duplicates (same repo+ecosystem+name) are de-duped, first write
 * winning; a registry without a string `url` is dropped.
 */
export function parseDependencyManifest(raw: string): DependencyManifest {
  const empty: DependencyManifest = { dependencies: [], registries: {} };
  const t = (raw ?? "").trim();
  if (!t) return empty;
  let data: unknown;
  try { data = JSON.parse(t); } catch { return empty; }
  const obj = (data && typeof data === "object" && !Array.isArray(data)) ? data as Record<string, unknown> : null;
  const arr: unknown[] = Array.isArray(data)
    ? data
    : (obj && Array.isArray(obj.dependencies)) ? obj.dependencies as unknown[] : [];

  const dependencies: PlanDependency[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const name = str(o.name);
    const eco = str(o.ecosystem)?.toLowerCase();
    if (!name || (eco !== "npm" && eco !== "cargo")) continue;
    const repo = str(o.repo);
    const key = `${repo ?? "*"}|${eco}|${name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dependencies.push({
      repo,
      ecosystem: eco,
      name,
      version: str(o.version),
      dev: o.dev === true,
      why: str(o.why),
      source: str(o.source),
      stream: str(o.stream),
    });
  }

  const registries: Record<string, DependencyRegistry> = {};
  const regRaw = obj && obj.registries && typeof obj.registries === "object" && !Array.isArray(obj.registries)
    ? obj.registries as Record<string, unknown> : {};
  for (const [k, v] of Object.entries(regRaw)) {
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
    const url = str(r.url);
    if (!url) continue;
    registries[k] = { url, scope: str(r.scope), auth: str(r.auth) };
  }
  return { dependencies, registries };
}

/** Parse just the dependency list (#1111 back-compat — the count/gate/seeding callers). */
export function parseDependenciesFile(raw: string): PlanDependency[] {
  return parseDependencyManifest(raw).dependencies;
}

/** The dependencies that apply to a given repo: those tagged with that `owner/repo`, plus the
 *  ecosystem-wide ones (no `repo`). */
export function depsForRepo(deps: PlanDependency[], fullName: string): PlanDependency[] {
  return deps.filter((d) => !d.repo || d.repo === fullName);
}

/** Split a repo's deps into npm / cargo buckets (for the manifest writers + the worker block). */
export function bucketByEcosystem(deps: PlanDependency[]): Record<DependencyEcosystem, PlanDependency[]> {
  return {
    npm: deps.filter((d) => d.ecosystem === "npm"),
    cargo: deps.filter((d) => d.ecosystem === "cargo"),
  };
}
