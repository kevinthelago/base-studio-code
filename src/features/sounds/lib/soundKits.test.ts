import { describe, it, expect } from "vitest";
import { BUILTIN_KITS, STARTER_KIT, mergeKits } from "./soundKits";
import { validateKit, type SoundKit } from "./soundDescriptor";

describe("BUILTIN_KITS (#3080 — seeded from src-tauri/data/sounds/)", () => {
  it("loads the Signal starter kit from the embedded seed JSON", () => {
    expect(BUILTIN_KITS.length).toBeGreaterThan(0);
    expect(STARTER_KIT.id).toBe("signal");
    expect(STARTER_KIT.cues).toHaveLength(5);
    expect(STARTER_KIT.voices).toHaveLength(7);
    expect(STARTER_KIT.primitives).toHaveLength(5);
  });

  it("every built-in kit is internally consistent (no dangling composes edges)", () => {
    // Guards the data/sounds/*.json seeds: compileCue throws on a broken kit.
    for (const kit of BUILTIN_KITS) expect(validateKit(kit)).toEqual([]);
  });
});

describe("mergeKits", () => {
  const a: SoundKit = { id: "a", name: "A", primitives: [], voices: [], cues: [] };
  const aEdited: SoundKit = { ...a, name: "A (edited)" };
  const b: SoundKit = { id: "b", name: "B", primitives: [], voices: [], cues: [] };

  it("returns built-ins to seed when the store is empty (first run)", () => {
    const { kits, toSeed } = mergeKits([], [a, b]);
    expect(kits).toEqual([a, b]);
    expect(toSeed).toEqual([a, b]); // both need seeding into the store
  });

  it("a stored kit WINS over the built-in for a shared id, and isn't re-seeded", () => {
    const { kits, toSeed } = mergeKits([aEdited], [a, b]);
    expect(kits).toEqual([aEdited, b]); // built-in order kept; edited `a` wins
    expect(toSeed).toEqual([b]);        // only the missing built-in seeds
  });

  it("keeps store-only kits (built-ins first, then extras)", () => {
    const extra: SoundKit = { id: "z", name: "Z", primitives: [], voices: [], cues: [] };
    const { kits } = mergeKits([extra], [a]);
    expect(kits).toEqual([a, extra]);
  });
});
