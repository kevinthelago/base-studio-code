// Pull-into-plan (#4267) — the write behind "this feature should be built from that library record".
//
// `PlanFeature.requires` is the plan → library edge, and its own doc in `crates/plandb/src/features.rs`
// says what it is for: *a worker building this feature is pointed at the reference implementation
// instead of re-coding it (the `reimplemented-component` problem, #3892, one layer up and caught BEFORE
// the code is written)*. #4191 already injects a feature's `requires` into worker context as ids + the
// fetch command. Everything existed except something writing it — the planner's "Pull into plan" button
// only flashed a toast.
//
// DECLARED intent, not derived fact (the field's own contract): the ids are NOT validated against the
// graph. The two stores are separate and the library may be unreachable when a plan is written, so a
// wrong id is a dangling reference, not a corrupt plan.
import { bsc } from "@/shared/lib/core/bsc";
import type { PlanFeature } from "@/features/planner/issues/featureList";

/** Does this feature already draw on `artifactId`? Drives the idempotent, already-required UI state. */
export function featureRequires(feature: Pick<PlanFeature, "requires">, artifactId: string): boolean {
  return (feature.requires ?? []).includes(artifactId);
}

/**
 * The feature's `requires` after pulling `artifactId` in — append-only, order preserved, no duplicates.
 * Pure, so the merge rule is testable without a store.
 *
 * **Append-only is a constraint, not a preference.** `feature_upsert` keeps the stored value when the
 * incoming list is empty (`CASE WHEN excluded.requires != '[]' … ELSE features.requires`), which is the
 * right rule for titles-first detail-filling but means an EMPTY list cannot be written through this
 * path. A remove-the-last-one toggle would therefore silently no-op, so removal is deliberately not
 * offered here rather than offered and quietly broken.
 */
export function withRequirement(requires: string[] | undefined, artifactId: string): string[] {
  const list = requires ?? [];
  return list.includes(artifactId) ? list : [...list, artifactId];
}

/**
 * Record that `feature` is built from `artifactId`, returning the feature's new `requires`.
 *
 * Writes ONLY `{ slug, requires }`: `feature_upsert` merges per field and preserves anything empty or
 * absent, so the feature's name, behavior, acceptance and the rest are untouched.
 *
 * Deliberately NOT `bscWrite` — that helper swallows the error, and a hand-off that reports success
 * without writing is the exact defect this replaces. A failed write throws so the caller can say so.
 *
 * @throws when the `bsc` bridge or the plan store is unreachable.
 */
export async function pullIntoPlan(
  projectKey: string,
  feature: Pick<PlanFeature, "slug" | "requires">,
  artifactId: string,
): Promise<string[]> {
  // Already there ⇒ nothing to write. Re-pulling is a no-op, not a duplicate or a wasted spawn.
  if (featureRequires(feature, artifactId)) return feature.requires ?? [];
  const requires = withRequirement(feature.requires, artifactId);
  await bsc(projectKey, ["plan", "feature", "add"], JSON.stringify({ slug: feature.slug, requires }));
  return requires;
}
