import { describe, it, expect } from "vitest";
import { validateKit, type SoundKit } from "./soundDescriptor";
import { STARTER_KIT } from "./soundSeeds";

describe("validateKit (#3072)", () => {
  it("passes the starter kit — no dangling composes edges (seed integrity)", () => {
    // Guards the seed: compileCue throws on a broken kit, so the shipped kit MUST be clean.
    expect(validateKit(STARTER_KIT)).toEqual([]);
  });

  it("flags a voice built on a missing primitive", () => {
    const kit: SoundKit = {
      ...STARTER_KIT,
      voices: [{ id: "v", name: "V", primitive: "ghost", freq: 440, gain: 0.2, env: { attack: 0, decay: 0.1, sustain: 0, release: 0.1 } }],
      cues: [],
    };
    expect(validateKit(kit)).toEqual([`voice "v" composes a missing primitive "ghost"`]);
  });

  it("flags a cue layering a missing voice, and an empty cue", () => {
    const kit: SoundKit = {
      ...STARTER_KIT,
      cues: [
        { id: "c", name: "C", category: "ui", layers: [{ voice: "ghost", at: 0 }] },
        { id: "empty", name: "E", category: "ui", layers: [] },
      ],
    };
    const problems = validateKit(kit);
    expect(problems).toContain(`cue "c" layers a missing voice "ghost"`);
    expect(problems).toContain(`cue "empty" has no layers`);
  });
});
