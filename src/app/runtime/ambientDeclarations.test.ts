// AMBIENT DECLARATIONS ARE NOT MODULES, AND CANNOT BE RETIRED.
//
// `.d.ts` files carry wildcard module declarations — `*.css`, `*?raw`, `*.svg` — that tsc reads because
// the file is INCLUDED, never because anything imports it. That makes them uniquely invisible to every
// other guard in this repo: retirement is safe precisely when a record can answer for a module, and here
// there is no importer to answer, no runtime behaviour to compare, and nothing that breaks until the
// entire typecheck fails at once on unrelated files.
//
// `src/vite-env.d.ts` was retired exactly that way — `.d.ts` ends in `.ts`, so the module census swept it
// up, harvested it as a record and deleted it. The failure surfaced as `main.tsx` being unable to import
// `@/styles/tokens.css`, which names neither the file that went nor the change that removed it.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "../..");

function declarationFiles(dir = SRC, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...declarationFiles(join(dir, e.name), r));
    else if (e.name.endsWith(".d.ts")) out.push(r);
  }
  return out;
}

describe("ambient declarations survive retirement (#3604)", () => {
  const found = declarationFiles();

  it("src/ still HAS ambient declarations", () => {
    // Non-vacuity, and the actual regression: the count going to zero is the bug, not a tidy-up.
    expect(found.length).toBeGreaterThan(0);
  });

  it("still pulls in vite/client — the source of the *.css and ?raw wildcards", () => {
    const all = found.map((f) => readFileSync(join(SRC, f), "utf8")).join("\n");
    // The wildcards are not declared HERE; they come from `vite/client`, and this one-line reference
    // directive is the whole mechanism that reaches them. `main.tsx` imports `@/styles/tokens.css` for
    // its side effect and `shadowPages.test.ts` reads a module's source via `?raw` — both stop
    // typechecking the moment this line is gone, which is what made the failure look unrelated.
    expect(all).toMatch(/\/\/\/\s*<reference\s+types=["']vite\/client["']\s*\/>/);
  });
    // The `.d.ts` exclusion moved with the census itself: it is now `bsc ui retirable`, and the rule is
    // asserted BEHAVIOURALLY in `bsc-ui`'s `retirable::tests` — a synthetic repo whose only seeded
    // candidate is a `.d.ts`, which must come back with no candidates at all. That is a stronger guard
    // than this was: it grepped the implementation's SOURCE for a regex, which passes for a rule that is
    // present but unreachable.
});
