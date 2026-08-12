// Seed records carry each doc block ONCE (graph-seed-4235-comment-stacking).
//
// The #4235 reconcile re-PREPENDED its marker plus the record's whole doc comment instead of replacing
// them, and it ran four times — so nine records shipped their header stacked four deep. The damage was
// comment-only (no duplicated declarations; every module still compiled), which is exactly why it
// survived: nothing failed, and a record's source is not something anyone reads top-to-bottom.
//
// THE ITEM ASKED FOR AN IDEMPOTENT PASS AND THERE IS NO PASS LEFT TO FIX. The #4235 reconcile was a
// one-off script, retired with the other 23 generators in `graph-retire-shadow-and-generators`; nothing
// under `scripts/` writes that marker any more. So the honest substitute for "make it idempotent" is
// this: a standing guard on the RESULT, which holds no matter what writes a record next.
import { describe, it, expect } from "vitest";

const RECONCILE_MARKER = "RECONCILED #4235";

const seed = import.meta.glob<{ id: string; srcText?: string }>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});
const records = Object.values(seed);

const isComment = (l: string) => l.trim().startsWith("//");

/** Runs of 3+ consecutive comment lines — the unit a stacked doc block duplicates. Deliberately NOT
 *  per-line: `// eslint-disable-next-line …` legitimately repeats for two different hooks, and a `════`
 *  divider legitimately repeats per section. Both are false positives a line-level check reports. */
function commentBlocks(src: string): string[] {
  const out: string[] = [];
  let run: string[] = [];
  for (const line of src.split("\n")) {
    if (isComment(line)) run.push(line.trim());
    else {
      if (run.length >= 3) out.push(run.join("\n"));
      run = [];
    }
  }
  if (run.length >= 3) out.push(run.join("\n"));
  return out;
}

describe("packaged seed records", () => {
  it("has records to check", () => {
    expect(records.length).toBeGreaterThan(300);
  });

  it("carries the #4235 reconcile marker at most ONCE per record", () => {
    const stacked = records
      .map((r) => ({ id: r.id, n: (r.srcText ?? "").split(RECONCILE_MARKER).length - 1 }))
      .filter((r) => r.n > 1);
    expect(stacked, `records with a stacked marker:\n${stacked.map((s) => `  ${s.id} x${s.n}`).join("\n")}`)
      .toEqual([]);
  });

  it("never repeats a doc-comment block within one record", () => {
    const dupes: string[] = [];
    for (const r of records) {
      const blocks = commentBlocks(r.srcText ?? "");
      const seen = new Set<string>();
      for (const b of blocks) {
        if (seen.has(b)) { dupes.push(r.id); break; }
        seen.add(b);
      }
    }
    expect(dupes, `records repeating a comment block:\n${dupes.map((d) => `  ${d}`).join("\n")}`).toEqual([]);
  });
});
