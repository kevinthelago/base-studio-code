import { describe, it, expect } from "vitest";
import { compileCue, voiceDuration } from "./synth";
import { STARTER_KIT } from "./soundSeeds";
import type { SoundKit } from "./soundDescriptor";

const cue = (id: string) => STARTER_KIT.cues.find((c) => c.id === id)!;

describe("voiceDuration", () => {
  it("is attack + decay + release (sustain is a level, not a hold)", () => {
    expect(voiceDuration({ attack: 0.01, decay: 0.05, sustain: 0.3, release: 0.1 })).toBeCloseTo(0.16);
  });
});

describe("compileCue (#3072)", () => {
  it("resolves a single-layer cue down to its voice + primitive", () => {
    const c = compileCue(cue("click"), STARTER_KIT);
    expect(c.voices).toHaveLength(1);
    expect(c.voices[0].source).toBe("osc");
    expect(c.voices[0].waveform).toBe("sine"); // blip → sine primitive
    expect(c.voices[0].freq).toBe(880);
    expect(c.voices[0].startAt).toBe(0);
  });

  it("sequences a multi-layer cue and totals duration = the max layer end", () => {
    const c = compileCue(cue("success"), STARTER_KIT);
    expect(c.voices).toHaveLength(2);
    expect(c.voices[1].startAt).toBe(0.09); // bell-hi layered at 0.09
    const bellHi = STARTER_KIT.voices.find((v) => v.id === "bell-hi")!;
    expect(c.duration).toBeCloseTo(0.09 + voiceDuration(bellHi.env));
  });

  it("carries a noise primitive + its filter through (the notify sparkle)", () => {
    const c = compileCue(cue("notify"), STARTER_KIT);
    const sparkle = c.voices.find((v) => v.source === "noise");
    expect(sparkle).toBeTruthy();
    expect(sparkle!.filter?.type).toBe("highpass");
  });

  it("carries a pitch sweep through (the error buzz glides freq→pitchTo)", () => {
    const c = compileCue(cue("error"), STARTER_KIT);
    expect(c.voices[0].freq).toBe(200);
    expect(c.voices[0].pitchTo).toBe(90);
  });

  it("throws on a dangling voice reference (a broken kit is a bug, not user data)", () => {
    const kit: SoundKit = { ...STARTER_KIT, cues: [{ id: "bad", name: "Bad", category: "ui", layers: [{ voice: "ghost", at: 0 }] }] };
    expect(() => compileCue(kit.cues[0], kit)).toThrow(/missing voice "ghost"/);
  });
});
