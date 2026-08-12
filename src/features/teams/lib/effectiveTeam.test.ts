import { describe, it, expect } from "vitest";
import { effectiveTeam, type TeamGraph } from "./effectiveTeam";

const graph = (n: string): TeamGraph => ({
  positions: [{ nodeId: n, kind: "agent", personaId: `persona-${n}` }],
  relationships: [],
});

describe("effectiveTeam (#3152)", () => {
  it("falls back to the blueprint's team when no per-project binding has ever been set", () => {
    const blueprintTeam = graph("architect");
    expect(effectiveTeam(null, blueprintTeam)).toBe(blueprintTeam);
    expect(effectiveTeam(undefined, blueprintTeam)).toBe(blueprintTeam);
  });

  it("the per-project binding wins over the blueprint's team once set", () => {
    const binding = graph("curator");
    const blueprintTeam = graph("architect");
    expect(effectiveTeam(binding, blueprintTeam)).toBe(binding);
  });

  it("an explicitly-set EMPTY binding still wins — a deliberate unpin is a recorded decision, not an absence", () => {
    const empty: TeamGraph = { positions: [], relationships: [] };
    const blueprintTeam = graph("architect");
    expect(effectiveTeam(empty, blueprintTeam)).toBe(empty);
  });

  it("no binding and no blueprint team ⇒ no team", () => {
    expect(effectiveTeam(null, undefined)).toBeUndefined();
    expect(effectiveTeam(undefined, undefined)).toBeUndefined();
  });
});
