// The feature-rule boundary guard (`the-feature-rules-live-in-typescript-not-the-crate`).
//
// plan.db is `crates/plandb`'s resource, so the RULES over it are the crate's
// (`epic-frontend-logic-over-backend-resources-belongs-in-rust`). They were not: `feature-list.ts`
// held its own `featureDefined`, `featuresSummary`, `featuresGateComplete`, `featuresAwaitingConfirm`
// and `featureDependencyCycle`, over a parsed `features.json` rather than the store — and Rust's
// `validate.rs::feature_defined` documented itself as "mirrors the frontend `featureDefined`", so the
// renderer was the spec and the store was the copy.
//
// They drifted, exactly as two copies do. MEASURED 2026-09-03 on studio-code: `bsc plan feature list`
// printed `·` (not fully defined) against nearly every row while its own footer said
// `47 of 49 features fully defined` — one command, two rules, contradicting each other on screen,
// because `render_feature_line` required a non-empty `requires` and `feature_readiness` did not.
//
// Nothing at run time can observe a rule being RE-DERIVED, so the guard asserts over SOURCE — the same
// shape as `every_store_env_mutation_is_inside_the_store_lock`. It reads the packaged SEED rather than
// the live store, like `platformBoundary.test.ts`: the seed is what ships, and the guard has to hold
// on a fresh clone and in CI where no local store exists.
//
// Read the rules instead of re-deriving them:
//   bsc plan feature gate [--confirmed] --json
//     → { count, specified, defined, allSpecified, gateComplete, awaitingConfirm, dependencyCycle }
import { describe, it, expect } from "vitest";
import seed from "@data/knowledge/algorithms.json";

/** A predicate that answers a question about plan.db's feature roster. Rust owns every one. */
const RUST_OWNED = [
  "featureDefined",
  "featuresSummary",
  "featuresGateComplete",
  "featuresAwaitingConfirm",
  "featureDependencyCycle",
] as const;

interface Impl {
  id: string;
  tech?: string;
  code?: string;
  tests?: { src?: string }[];
}
const impls = (seed as { implementations: Impl[] }).implementations.filter((i) => i.tech === "typescript");

describe("the feature rules stay in Rust", () => {
  // A scanner that silently stops matching reports zero offenders, which reads as a pass. Assert the
  // POPULATION so the guard fails loudly if it is ever pointed at nothing.
  it("is actually looking at the TypeScript records", () => {
    expect(impls.length).toBeGreaterThan(400);
    // Anchored on a record that is STILL THERE. It used to name `feature-list.ts`, which this suite
    // now asserts is retired — a non-vacuity check that fails when the thing it guards succeeds is
    // worse than none, because it reads as the guard breaking rather than as the work landing.
    expect(impls.some((i) => i.id === "feature-nodes.ts")).toBe(true);
  });

  it.each(RUST_OWNED)("no TypeScript record DEFINES %s", (sym) => {
    // `function <sym>` / `const <sym> =` is a DEFINITION. A mention in a comment or a string is not,
    // which is why this matches the declaration forms rather than the bare name — the migration note
    // left behind in `feature-list.ts` names all five on purpose.
    const decl = new RegExp(String.raw`(?:function\s+${sym}\b|(?:const|let|var)\s+${sym}\s*=)`);
    const offenders = impls.filter((i) => decl.test(i.code ?? "")).map((i) => i.id);
    expect(offenders, `${sym} is Rust's — read it with \`bsc plan feature gate --json\``).toEqual([]);
  });

  it("feature-list.ts is RETIRED — nothing decodes features from a file any more", () => {
    // It kept a parser and a projection after the rules moved to Rust. Both were then found to have
    // no caller at all — the modules that used them were planner-UI residue, and `bsc-publish` takes
    // `PlanIssue` rows rather than deriving them. The projection lives in `crates/plandb` and is read
    // with `bsc plan feature issues`; the decoder went with the cluster
    // (`retire-the-planner-ui-cluster-that-parses-features`).
    expect(impls.some((i) => i.id === "feature-list.ts"), "feature-list.ts is back").toBe(false);
  });

  it("no TypeScript record decodes a features FILE", () => {
    // The whole point of the retirement: one source, and it is plan.db.
    const offenders = impls.filter((i) => /function\s+parseFeaturesFile|featuresToPlanIssues\s*\(/.test(i.code ?? ""));
    expect(
      offenders.map((i) => i.id),
      "features come from plan.db — `bsc plan feature list --json`, and `bsc plan feature issues` for the projection",
    ).toEqual([]);
  });
});
