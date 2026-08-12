// The seed-projection COVERAGE guard (`record-src-reconcile`).
//
// `projectComponent` is an ALLOWLIST: a field it does not name is dropped. That is fine for a field
// nothing carries, and silent data loss for a field a packaged record actually holds.
//
// WHY THE EXISTING ROUND-TRIP TEST CANNOT CATCH THIS. `seedRoundTrip.test.ts` asserts
// `seed === load(push(seed))` — but `SEED_COMPONENTS` is itself built by running each raw JSON through
// `projectComponent` (see `seed.ts`). Both sides of that equation therefore drop an unknown field
// IDENTICALLY, and the equation holds trivially. Verified by removing `srcDivergence` from the
// allowlist: the round-trip suite stayed green (7/7) while the field was being dropped from the seed
// entirely — so the app would never have seen it, and 70 annotated records would have carried a reason
// that existed only in the JSON on disk. That is the same shape as #4188/#4224: a check more permissive
// than the thing it stands for.
//
// So this asserts the coverage directly, against the RAW seed JSON rather than the projected form: every
// key any packaged record actually carries must survive the projection.
import { describe, it, expect } from "vitest";
import { projectComponent } from "./componentBridge";
import type { ComponentRecord } from "./model";

// The RAW records — deliberately NOT `SEED_COMPONENTS`, which is already projected and so cannot show
// what the projection discarded.
const raw = import.meta.glob<Partial<ComponentRecord>>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});
const RECORDS = Object.values(raw).filter((r) => r && (r as { id?: string }).id);

/** Keys a record may carry that the projection is EXPECTED to drop, each with the reason.
 *  Anything not listed here is either projected or a bug — this list is the deliberate part. */
const INTENTIONALLY_DROPPED = new Set<string>([
  // The legacy spelling of `folder` (#4107 slice B). The projection reads it and re-emits it AS
  // `folder`, so the key itself legitimately does not survive under its old name.
  "group",
]);

describe("seed projection coverage (`record-src-reconcile`)", () => {
  it("has records to check — the glob still resolves", () => {
    // Non-vacuity: an empty glob would make the assertion below pass while checking nothing, which is
    // precisely the failure mode this file exists to close.
    expect(RECORDS.length).toBeGreaterThan(300);
  });

  it("EVERY key a packaged record carries survives `projectComponent`", () => {
    const carried = new Set<string>();
    for (const r of RECORDS) for (const k of Object.keys(r)) carried.add(k);

    const dropped: string[] = [];
    for (const key of carried) {
      if (INTENTIONALLY_DROPPED.has(key)) continue;
      // Project a record that actually carries the key, so a projection reading it conditionally
      // (`folder ?? group`) is exercised the way the real seed exercises it.
      const sample = RECORDS.find((r) => (r as Record<string, unknown>)[key] !== undefined)!;
      const projected = projectComponent(sample) as unknown as Record<string, unknown>;
      if (projected[key] === undefined) dropped.push(key);
    }

    expect(
      dropped,
      `these keys are on packaged records but dropped by projectComponent — add them to the allowlist ` +
        `(or to INTENTIONALLY_DROPPED with a reason):\n  ${dropped.join("\n  ")}`,
    ).toEqual([]);
  });

  it("carries `srcDivergence` — the field this guard was written for", () => {
    // A named regression test for the specific field, so the general check above cannot be weakened
    // without this also failing.
    const projected = projectComponent({ id: "x", name: "X", srcDivergence: "because" }) as ComponentRecord;
    expect(projected.srcDivergence).toBe("because");
  });
});
