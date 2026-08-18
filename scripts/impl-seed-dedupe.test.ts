// The impl write must never append a DUPLICATE id into the algorithms seed.
//
// `knowledge.test.ts` asserts `ids.size === impls.length`. The component write has refused a duplicate
// since seven curated seeds were clobbered; the impl write did not — and an impl id comes from the FILE
// STEM, so promoting `features/algorithms/viz/examples/sort.ts` appended a second `sort.ts` beside a
// curated one and the seed failed with "expected 603 to be 604".
//
// Nothing upstream caught it: `bsc graph harvest` refuses a stem collision only when it can compare
// `src`, and the curated entry had none — no `src`, no `provides`, 28 lines of a 90-line module.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Impl { id: string; tech?: string; role?: string; composes?: string[] }
const SEED = join(process.cwd(), "src-tauri/data/knowledge/algorithms.json");
const impls: Impl[] = JSON.parse(readFileSync(SEED, "utf8")).implementations ?? [];

describe("the algorithms seed", () => {
  it("has records to check — the read still resolves", () => {
    expect(impls.length).toBeGreaterThan(400);
  });

  it("carries no DUPLICATE id", () => {
    const seen = new Set<string>();
    const dupes = impls.filter((i) => (seen.has(i.id) ? true : (seen.add(i.id), false))).map((i) => i.id);
    expect(dupes, `duplicate impl id(s): ${dupes.join(", ")}`).toEqual([]);
  });

  it("every `composes` target is a real impl of the SAME tech — the referential integrity a promotion must not break", () => {
    // The rule the carry closure exists to satisfy. Restated here over the seed on disk so a hand-edit
    // is caught too, not only a promotion.
    const byId = new Map(impls.map((i) => [i.id, i]));
    const dangling: string[] = [];
    for (const i of impls) {
      for (const c of i.composes ?? []) {
        const t = byId.get(c);
        if (!t) dangling.push(`${i.id} → ${c} (no such impl)`);
        else if (t.tech !== i.tech) dangling.push(`${i.id} (${i.tech}) → ${c} (${t.tech})`);
      }
    }
    expect(dangling, `dangling composes:\n  ${dangling.join("\n  ")}`).toEqual([]);
  });
});
