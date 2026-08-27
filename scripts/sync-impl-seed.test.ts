// #145: `sync-impl-seed.mjs` used to compare (and copy) `code` ONLY, so a store edit to any OTHER
// carried facet — `tests` above all, since `bsc graph tests set` writes nothing else — reported
// "already identical" and never reached the packaged seed the gate actually reads. These pin the fixed
// comparison against the exact repro on the request: a record whose `code` is untouched but whose
// `tests` differ must be reported as needing a sync, and applying it must write the new `tests`.
import { describe, it, expect } from "vitest";
import { contentOf, losesFields, diffFields, planOne } from "./sync-impl-seed.mjs";

function rec(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-roles.ts",
    tech: "typescript",
    role: "primitive",
    name: "scopeWriteGlobs",
    code: "export function scopeWriteGlobs() {}",
    ...overrides,
  };
}

describe("contentOf", () => {
  it("strips write bookkeeping the store carries and the seed never does", () => {
    const withBookkeeping = rec({ history: [{ rev: 1 }], rev: 3, updatedAt: "t", updatedBy: "x", build: { ok: true } });
    expect(contentOf(withBookkeeping)).toEqual(rec());
  });
});

describe("diffFields", () => {
  it("names only the keys that actually differ", () => {
    const a = rec({ tests: [] });
    const b = rec({ tests: [{ name: "t", src: "…" }] });
    expect(diffFields(a, b)).toEqual(["tests"]);
  });

  it("reports nothing for two identical records", () => {
    expect(diffFields(rec(), rec())).toEqual([]);
  });
});

describe("losesFields", () => {
  it("is true when the fresh copy drops a non-empty field the existing copy carries", () => {
    const existing = rec({ tests: [{ name: "t", src: "…" }] });
    const fresh = rec();
    expect(losesFields(fresh, existing)).toBe(true);
  });

  it("is false when the dropped field was empty anyway", () => {
    const existing = rec({ tests: [] });
    const fresh = rec();
    expect(losesFields(fresh, existing)).toBe(false);
  });

  it("is false when fresh carries every field existing does", () => {
    const existing = rec();
    const fresh = rec({ tests: [{ name: "t", src: "…" }] });
    expect(losesFields(fresh, existing)).toBe(false);
  });
});

describe("planOne — the request #145 repro", () => {
  const id = "session-roles.ts";

  it("SKIPs a record whose code is unchanged but reports up-to-date only when NOTHING carried differs", () => {
    const seedImpls = [rec()];
    const storeById = new Map([[id, rec()]]);
    expect(planOne(seedImpls, storeById, id).verdict).toBe("up-to-date");
  });

  it("a carried TEST edit with untouched `code` is no longer reported as identical — the bug", () => {
    const seedImpls = [rec()]; // seed has no tests
    const storeById = new Map([
      [id, rec({ tests: [{ name: "scopeWriteGlobs (#1297)", src: "expect(scopeWriteGlobs()).toEqual([]);" }] })],
    ]);
    const plan = planOne(seedImpls, storeById, id);
    expect(plan.verdict).toBe("sync");
    expect(plan.fields).toEqual(["tests"]);
  });

  it("refuses to sync when the store copy would DELETE a field the seed already carries", () => {
    const seedImpls = [rec({ tests: [{ name: "existing", src: "…" }], summary: "a summary" })];
    // The runtime store regressed and lost `summary` — same shape #4136's `RuntimeBehind` guards against.
    const storeById = new Map([[id, rec({ tests: [{ name: "existing", src: "…" }] })]]);
    const plan = planOne(seedImpls, storeById, id);
    expect(plan.verdict).toBe("would-lose-fields");
    expect(plan.fields).toContain("summary");
  });

  it("still skips when the id is absent from the store or the seed", () => {
    expect(planOne([rec()], new Map(), id).verdict).toBe("skip-not-in-store");
    expect(planOne([], new Map([[id, rec()]]), id).verdict).toBe("skip-not-in-seed");
  });

  it("bookkeeping fields never cause a false sync and never ride along into the seed", () => {
    const seedImpls = [rec()];
    const storeById = new Map([[id, rec({ history: [{ rev: 1 }], rev: 2, updatedAt: "t", updatedBy: "x" })]]);
    expect(planOne(seedImpls, storeById, id).verdict).toBe("up-to-date");
  });
});
