// #145: `sync-impl-seed.mjs` used to compare (and copy) `code` ONLY, so a store edit to any OTHER
// carried facet — `tests` above all, since `bsc graph tests set` writes nothing else — reported
// "already identical" and never reached the packaged seed the gate actually reads. These pin the fixed
// comparison against the exact repro on the request: a record whose `code` is untouched but whose
// `tests` differ must be reported as needing a sync, and applying it must write the new `tests`.
import { describe, it, expect } from "vitest";
import { contentOf, losesFields, diffFields, planOne, mergeStores } from "./sync-impl-seed.mjs";

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

// Request #151: `bsc graph edge set` writes into a SECOND store tier (`edge list`) alongside impls
// (`impl list`) — the sync script used to build its store map from `impl list` alone, so any edge id
// reported "not in the store" no matter what the store held, with no path to the packaged seed at all.
function edgeRec(overrides: Record<string, unknown> = {}) {
  return {
    id: "role-model-session-roles--sessionRoles.roleTable",
    members: ["role-model.ts", "session-roles.ts"],
    src: "rt.ts",
    tests: [{ name: "role table", src: "expect(true).toBe(true);" }],
    ...overrides,
  };
}

describe("mergeStores — the request #151 repro", () => {
  it("an edge id resolves through the merged map exactly like an impl id does", () => {
    const byId = mergeStores([rec()], [edgeRec()]);
    expect(byId.get("session-roles.ts")).toEqual(rec());
    expect(byId.get(edgeRec().id)).toEqual(edgeRec());
  });

  it("a sync PLAN succeeds for an edge id once it resolves through the merged store — the bug", () => {
    const seedRecords = [rec(), edgeRec({ src: "old-src.ts", tests: [] })]; // seed has no edge tests yet
    const storeById = mergeStores([rec()], [edgeRec()]);
    const plan = planOne(seedRecords, storeById, edgeRec().id);
    expect(plan.verdict).toBe("sync");
    expect(plan.fields).toEqual(["src", "tests"]);
  });

  it("refuses rather than silently pick a side when an id exists in both tiers", () => {
    const collidingId = "same-id";
    expect(() => mergeStores([rec({ id: collidingId })], [edgeRec({ id: collidingId })])).toThrow(
      /exists as BOTH an impl and an edge/,
    );
  });

  it("an impl-only or edge-only store still merges with nothing to collide over", () => {
    expect(mergeStores([rec()], []).size).toBe(1);
    expect(mergeStores([], [edgeRec()]).size).toBe(1);
  });
});
