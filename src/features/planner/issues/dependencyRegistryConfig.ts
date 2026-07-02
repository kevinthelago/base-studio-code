// ── Registry config writers (#1127) ──────────────────────────────────────────────
// Generate the source/registry config so a private dependency is fetchable from the first commit.
// Only the registries a repo's deps actually reference are emitted; public-only repos get nothing.

import type {
  DependencyEcosystem,
  DependencyRegistry,
  PlanDependency,
} from "@/features/planner/issues/dependencyTypes";

/** The `//host[/path]/` key npm's `.npmrc` uses for an auth token, derived from a registry URL. */
function npmrcHostKey(url: string): string {
  return url.replace(/^https?:/i, "").replace(/\/?$/, "/");
}

/** The registry KEYs (sorted, deterministic) that a repo's deps of one ecosystem reference and that
 *  are actually defined in the registries map. */
function usedRegistries(registries: Record<string, DependencyRegistry>, deps: PlanDependency[], eco: DependencyEcosystem): string[] {
  const used = new Set(deps.filter((d) => d.ecosystem === eco && d.source && registries[d.source]).map((d) => d.source!));
  return [...used].sort();
}

/**
 * Build a repo's `.npmrc` from the registries its npm deps reference (#1127): a scoped registry as
 * `@scope:registry=<url>`, an unscoped one as the default `registry=<url>`, plus a `${SECRET}` auth
 * token line when the registry declares one. Returns null when no npm dep uses a private source.
 */
export function buildNpmrc(registries: Record<string, DependencyRegistry>, deps: PlanDependency[]): string | null {
  const keys = usedRegistries(registries, deps, "npm");
  if (!keys.length) return null;
  const lines: string[] = [];
  for (const key of keys) {
    const r = registries[key];
    lines.push(r.scope ? `${r.scope}:registry=${r.url}` : `registry=${r.url}`);
    if (r.auth) lines.push(`${npmrcHostKey(r.url)}:_authToken=\${${r.auth}}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * Build a repo's `.cargo/config.toml` from the registries its cargo deps reference (#1127) — one
 * `[registries.<name>]` table with the index URL each. Returns null when no cargo dep uses a private
 * source. (Cargo reads the token from `CARGO_REGISTRIES_<NAME>_TOKEN`, kept out of the file.)
 */
export function buildCargoConfig(registries: Record<string, DependencyRegistry>, deps: PlanDependency[]): string | null {
  const keys = usedRegistries(registries, deps, "cargo");
  if (!keys.length) return null;
  const lines: string[] = [];
  for (const key of keys) lines.push(`[registries.${key}]`, `index = "${registries[key].url}"`, "");
  return lines.join("\n").replace(/\n+$/, "\n");
}
