// The worker-context dependency block (#1111): the locked set for ONE repo, inlined into its
// CLAUDE.local.md as the single authority every worker reads.

import type { PlanDependency } from "@/features/planner/issues/dependencyTypes";
import { bucketByEcosystem } from "@/features/planner/issues/dependencyParse";

/**
 * Render the locked dependency set for ONE repo as the worker-context block inlined into its
 * CLAUDE.local.md (#1111) — the single authority every worker reads, with the guardrail that the
 * manifests are planner-owned and new deps route through the director. Returns "" when the repo has
 * no locked deps (nothing to inline).
 */
export function buildWorkerDependencyBlock(deps: PlanDependency[]): string {
  if (!deps.length) return "";
  const { npm, cargo } = bucketByEcosystem(deps);
  const fmt = (d: PlanDependency) => {
    const ver = d.version ? `@${d.version}` : "";
    const dev = d.dev ? " *(dev)*" : "";
    const src = d.source ? ` *(from \`${d.source}\` registry)*` : "";
    const why = d.why ? ` — ${d.why}` : "";
    return `  - \`${d.name}${ver}\`${dev}${src}${why}`;
  };
  const hasSource = deps.some((d) => d.source);
  const lines = ["## Dependencies (locked by the planner)", ""];
  if (npm.length) lines.push("**npm** (`package.json`):", ...npm.map(fmt), "");
  if (cargo.length) lines.push("**cargo** (`Cargo.toml`):", ...cargo.map(fmt), "");
  lines.push(
    "These are already present in the repo's manifests — installing them is enough. **Do NOT add to or",
    "edit `package.json` / `Cargo.toml`** (the role gate blocks it): redefining deps in parallel",
    "worktrees is exactly what collides at integration. If you genuinely need a new dependency, request",
    "it from the director (`bsc-ask`) rather than adding it yourself.",
  );
  if (hasSource) {
    lines.push(
      "",
      "Private-registry sources are already wired in `.npmrc` / `.cargo/config.toml` (their auth tokens",
      "come from the environment) — don't reconfigure them.",
    );
  }
  return lines.join("\n");
}
