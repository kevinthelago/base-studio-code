// THE GLOBAL OFF SWITCH HAS TO BE READ (`debug-sessions-have-a-global-off-switch`).
//
// The switch itself is pinned in Rust (`bsc-request`): the policy outranks the pause, `resume` cannot
// lift it, and neither writes the other. What Rust cannot pin is that the APP asks — and a gate nothing
// consults is the same failure as a projection nothing calls, which this repo has now shipped twice.
//
// A WIRING guard, and it says so: it proves the mount reads `allowed` and combines nothing.
import { describe, it, expect } from "vitest";
// Reads the COMMITTED record store, not the packaged seed — `bsc-emit` materializes `.bsc-records/`
// from `graph/algorithms.json` + `graph/records/*.json` now, so that is the copy this module compiles
// from (`retire-the-packaged-seed-directories`).
import { loadStore } from "@scripts/lib/recordStore.mjs";

function mountSource(): string {
  const seed = loadStore();
  let found: string | null = null;
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) return void o.forEach(walk);
    if (o && typeof o === "object") {
      const r = o as Record<string, unknown>;
      if (r.id === "request-sessions-mount.ts" && typeof r.code === "string") found = r.code;
      for (const [k, v] of Object.entries(r)) if (k !== "code") walk(v);
    }
  };
  walk(seed);
  if (!found) throw new Error("request-sessions-mount.ts is not in the algorithms seed");
  return found;
}

describe("the mount honours the global switch", () => {
  const src = mountSource();

  it("reads the combined gate, not the pause alone", () => {
    expect(src).toContain(`["request", "sessions", "--json"]`);
    expect(src).toContain("const paused = !gate.allowed;");
  });

  it("does NOT recombine the two switches itself", () => {
    // The precedence lives in Rust and is returned as `allowed`. Two booleans combined by every caller
    // is exactly how the persona and stream levels of the model chain drifted apart.
    expect(src).not.toContain("enabled && !paused");
    expect(src).not.toContain(`["request", "paused", "--json"]`);
  });

  it("degrades to ALLOWED when the read fails", () => {
    // A failed `bsc` call must never silently stop the fleet — neither switch is true unless set.
    expect(src).toContain("{ allowed: true }");
  });

  it("gates the CLAIM on it too, not only the spawn", () => {
    // Claiming turns `open` into `claimed`. A disabled machine that still claimed would consume the
    // queue while doing no work — the same ordering bug the pause had to fix.
    const gateAt = src.indexOf(`["request", "sessions", "--json"]`);
    const claimAt = src.indexOf(`["request", "claim", "--json"]`);
    expect(gateAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(gateAt);
  });
});
