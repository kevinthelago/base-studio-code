// The sound-graph NodeLookup adapter (#3117) — the map from the sound library onto the shared cross-graph
// resolver. Verifies cue (primary) / voice (fallback) / primitive resolution, the miss, and the code
// carry-through (a cue/voice carries a player module; a primitive is a code-less descriptor).
import { describe, it, expect } from "vitest";
import { soundNodeLookup } from "./crossGraphAdapter";
import type { SoundKit } from "./soundDescriptor";

const kit: SoundKit = {
  id: "signal",
  name: "Signal",
  primitives: [{ id: "sine", name: "Sine", kind: "osc", waveform: "sine" }],
  voices: [
    { id: "blip", name: "Blip", primitive: "sine", freq: 880, gain: 0.3,
      env: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.03 } },
  ],
  cues: [{ id: "click", name: "Click", category: "ui", layers: [{ voice: "blip", at: 0 }] }],
};

describe("soundNodeLookup (#3117)", () => {
  const lookup = soundNodeLookup([kit]);

  it("resolves a CUE by id and carries its player module + kind", () => {
    const n = lookup("signal", "click");
    expect(n).not.toBeNull();
    expect(n!.id).toBe("click"); // the matched id (so a caller can canonicalize the URN)
    expect(n!.label).toBe("Click");
    expect(n!.kind).toBe("cue");
    expect(n!.graph).toBe("sound");
    expect(n!.code).toContain("export function play"); // the self-contained player module
    expect(n!.code).toContain("const SCHEDULE ="); // …embedding the compiled schedule
  });

  it("falls back to a VOICE (a playable patch) with a player module", () => {
    const n = lookup("signal", "blip");
    expect(n!.kind).toBe("voice");
    expect(n!.label).toBe("Blip");
    expect(n!.code).toContain("export function play");
  });

  it("resolves a PRIMITIVE as a code-less descriptor (not importable)", () => {
    const n = lookup("signal", "sine");
    expect(n!.kind).toBe("primitive");
    expect(n!.code).toBeUndefined();
  });

  it("scopes to the kit id and misses cleanly on an unknown id/kit", () => {
    expect(lookup("signal", "nope")).toBeNull();
    expect(lookup("other-kit", "click")).toBeNull(); // an unseeded kit
  });

  it("returns null (not throw) for a cue whose kit is broken (dangling composes edge)", () => {
    const broken: SoundKit = { ...kit, cues: [{ id: "ghost", name: "Ghost", category: "ui", layers: [{ voice: "missing", at: 0 }] }] };
    expect(soundNodeLookup([broken])("signal", "ghost")).toBeNull();
  });
});
