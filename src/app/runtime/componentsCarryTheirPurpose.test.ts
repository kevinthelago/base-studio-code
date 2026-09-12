// EVERY REUSABLE COMPONENT CARRIES ITS PURPOSE AND ITS SHAPE — the population floor for
// `components-carry-their-purpose-and-shape`.
//
// THE DEFECT THIS CLOSES. `bsc ui list` already takes `--shape`, `--feature` and `--tags`, and the
// Design Studio rail already groups by `folder` — but MEASURED 2026-09-12 the facets those filters
// read were empty: of 460 stored component rows, `whenUse` was non-empty on 11 and `shapes` on ZERO,
// so `bsc ui shapes` answered all seven shapes with `components: []`. A session that cannot see what
// the library already holds writes a fourteenth variant of a row instead of composing the one that
// exists, and that is how the library got to 460 rows in the first place.
//
// WHY A STORE SCAN AND NOT A UNIT TEST. There is no function whose behaviour is wrong here; the
// defect is the CONTENT of a store, and content rots back one unclassified record at a time. Only a
// population floor over the real store can see that, which is the same reason `storesAgree.test.ts`
// and `expandNeverNavigates.test.ts` read `graph/` rather than a fixture.
//
// WHICH STORE, AND WHY THIS ONE. `graph/components.db` — the COMMITTED store, which is the build
// authority and the thing a fresh clone gets. The RUNTIME store
// (`~/.base-studio-code/components.db`) is per-user and carries this machine's suppression
// tombstones, so a gate that read it would pass or fail differently on every developer's box.
//
// SCOPED TO `shared/ui/**` DELIBERATELY. That is the reusable library — the set a session is meant
// to search before authoring — and it is the set the item put a floor under. Feature components are
// not exempt on principle, they are simply not in scope yet; widening this is a content change, not
// a test change.
import { describe, it, expect } from "vitest";
import { loadStore } from "@scripts/lib/recordStore.mjs";

/** The seven-shape data vocabulary (#2475/#3517). Mirrors `DATA_SHAPES` in the designs model and
 *  `DATA_SHAPES` in the Rust component CLI — the three must agree, and an off-vocabulary value here
 *  is a typo that would make `bsc ui list --shape` silently return nothing for it. */
const DATA_SHAPES = ["list", "linked-list", "tree", "graph", "table", "key-value", "series"] as const;

interface Comp {
  id?: string;
  folder?: string;
  whenUse?: unknown;
  whenNot?: unknown;
  shapes?: unknown;
  suppressed?: boolean;
}

const RECORDS = ((loadStore("graph/components.db") as { implementations?: Comp[] }).implementations ?? [])
  .filter((r) => r.suppressed !== true);
const SHARED_UI = RECORDS.filter((r) => String(r.folder ?? "").startsWith("shared/ui"));

/** Non-empty array of non-blank strings — the shape `whenUse`/`whenNot`/`shapes` are stored in. */
function filledStrings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0) : [];
}

describe("the component library carries its purpose and its shape", () => {
  it("reads the committed component store, so the assertions below are not vacuous", () => {
    // Guard the guard: an empty set satisfies every `for` loop below perfectly. Both floors are
    // asserted because a resolver change that returned `[]` is exactly how a content gate goes quiet.
    expect(RECORDS.length, "no component records — graph/components.db stopped resolving").toBeGreaterThan(250);
    expect(SHARED_UI.length, "no shared/ui records — did the folder convention change?").toBeGreaterThan(90);
  });

  it("every shared/ui component states WHEN TO USE IT, in one actionable sentence", () => {
    const missing = SHARED_UI.filter((r) => filledStrings(r.whenUse).length === 0).map((r) => r.id);
    expect(missing, `${missing.length} shared/ui components carry no whenUse — a session cannot find them`).toEqual([]);
  });

  it("a whenUse line is prose, not a restatement of the component's own name", () => {
    // The cheapest way to satisfy the floor above is `whenUse: ["Button"]`, which tells a reader
    // nothing they did not have from the id. A real purpose line is a sentence.
    const thin = SHARED_UI.filter((r) => filledStrings(r.whenUse).every((s) => s.trim().split(/\s+/).length < 5))
      .map((r) => r.id);
    expect(thin, "these whenUse lines are too short to act on").toEqual([]);
  });

  it("every stamped shape is in the seven-value vocabulary", () => {
    const bad = RECORDS.flatMap((r) => filledStrings(r.shapes).filter((s) => !DATA_SHAPES.includes(s as never))
      .map((s) => `${r.id}:${s}`));
    expect(bad, "off-vocabulary shapes are invisible to `bsc ui list --shape`").toEqual([]);
  });

  it("`bsc ui shapes` is not wholly unpopulated — every shape that has an ideal rendering names it", () => {
    // The failure this replaces: all seven shapes answering `components: []`, which reads as "the kit
    // has no ideal layout for anything" when in fact nothing had been stamped. The floor is per-shape
    // rather than a single total, because one over-stamped shape would otherwise hide six empty ones.
    const byShape = new Map(DATA_SHAPES.map((s) => [s, RECORDS.filter((r) => filledStrings(r.shapes).includes(s)).length]));
    const empty = [...byShape].filter(([, n]) => n === 0).map(([s]) => s);
    expect(empty, "these shapes have no ideal component — `bsc ui shapes <s>` answers nothing").toEqual([]);
    expect([...byShape.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
  });
});
