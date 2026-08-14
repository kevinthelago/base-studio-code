// A retired module must still resolve — the regression that took the whole app down.
//
// `Spacer.tsx` was deleted once its record superseded it, which made the app depend on the generated
// `.bsc-records/` tree. Generation was wired into the `typecheck` / `test` / `build` npm scripts, so every
// gate command regenerated the tree as its FIRST step and no gate could ever observe the tree missing.
// `npm run dev` was not wired, so the dev server booted with the module unresolvable and died on
// `Failed to fetch dynamically imported module: /src/app/runtime/appModules.ts`.
//
// Generation now lives in the vite plugin's `buildStart`, which fires for serve and build alike — and for
// vitest, which is why this test is meaningful rather than circular: it exercises the SAME plugin path the
// dev server uses, not the npm script.
import { describe, it, expect } from "vitest";
import { Spacer } from "@/shared/ui/layout/Spacer";

describe("retired modules resolve through the record fallback", () => {
  it("imports a module whose file was deleted, from its packaged seed", () => {
    // If the fallback is broken this file fails to COLLECT — the import above throws before any assertion
    // runs — which is exactly the shape of the dev-server failure.
    expect(typeof Spacer).toBe("function");
  });
});
