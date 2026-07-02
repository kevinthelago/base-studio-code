// Group locked deps by the source (registry) each is pulled from (#1127) — the Deploy pane surface.

import type {
  DependencyEcosystem,
  DependencyRegistry,
  PlanDependency,
} from "@/features/planner/issues/dependencyTypes";

/** A source (registry) the project pulls from, with the deps fetched through it (#1127 UI). The
 *  public default per ecosystem is synthesized when a dep carries no `source`. */
export interface DependencySourceGroup {
  /** Stable key — the registry key, or `"npm"` / `"cargo"` for the ecosystem default. */
  key: string;
  name: string;
  /** True when this source is a non-default (private) registry. */
  private: boolean;
  url: string;
  scope?: string;
  /** Auth-token secret name (private sources only). */
  auth?: string;
  deps: PlanDependency[];
}

const PUBLIC_SOURCE: Record<DependencyEcosystem, { name: string; url: string }> = {
  npm:   { name: "npm registry", url: "registry.npmjs.org" },
  cargo: { name: "crates.io",    url: "crates.io" },
};

/** Group locked deps BY the source each is pulled from (#1127): one group per non-default registry
 *  referenced, plus one per ecosystem-default for deps without a `source`. Sorted defaults-first
 *  then by name, so the view is deterministic. Pure. */
export function groupDependenciesBySource(
  deps: PlanDependency[],
  registries: Record<string, DependencyRegistry>,
): DependencySourceGroup[] {
  const groups = new Map<string, DependencySourceGroup>();
  for (const dep of deps) {
    const reg = dep.source ? registries[dep.source] : undefined;
    // A dep whose `source` isn't a known registry falls back to the ecosystem's public default.
    const key = reg ? dep.source! : dep.ecosystem;
    let g = groups.get(key);
    if (!g) {
      g = reg
        ? { key, name: dep.source!, private: true, url: reg.url, scope: reg.scope, auth: reg.auth, deps: [] }
        : { key, name: PUBLIC_SOURCE[dep.ecosystem].name, private: false, url: PUBLIC_SOURCE[dep.ecosystem].url, deps: [] };
      groups.set(key, g);
    }
    g.deps.push(dep);
  }
  return [...groups.values()].sort((a, b) =>
    a.private === b.private ? a.name.localeCompare(b.name) : a.private ? 1 : -1);
}
