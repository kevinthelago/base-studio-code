// Self-contained cue-player emit (#3117) — the vendorable "code" for a sound the Design Studio preview
// imports as `@bsc/sounds/<id>`. Verifies the emitted module embeds the compiled schedule + exports `play`.
import { describe, it, expect } from "vitest";
import { cuePlayerModule } from "./cuePlayerModule";
import { compileCue } from "./synth";
import type { SoundKit } from "./soundDescriptor";

const kit: SoundKit = {
  id: "signal",
  name: "Signal",
  primitives: [
    { id: "sine", name: "Sine", kind: "osc", waveform: "sine" },
    { id: "noise", name: "Noise", kind: "noise" },
  ],
  voices: [
    { id: "blip", name: "Blip", primitive: "sine", freq: 880, gain: 0.3,
      env: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.03 } },
    { id: "sparkle", name: "Sparkle", primitive: "noise", freq: 0, gain: 0.12,
      filter: { type: "highpass", cutoff: 5000 },
      env: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.07 } },
  ],
  cues: [
    { id: "click", name: "Click", category: "ui", layers: [{ voice: "blip", at: 0 }] },
    { id: "notify", name: "Notify", category: "notify", layers: [{ voice: "blip", at: 0 }, { voice: "sparkle", at: 0.02 }] },
  ],
};

describe("cuePlayerModule (#3117)", () => {
  it("emits a self-contained ES module that embeds the compiled schedule and exports play", () => {
    const src = cuePlayerModule(kit.cues[0], kit);
    // The export API a component binds.
    expect(src).toContain("export function play");
    expect(src).toContain("export default play");
    // The embedded schedule — the SAME shape compileCue produces (no app import at preview time).
    const compiled = compileCue(kit.cues[0], kit);
    expect(src).toContain(`const SCHEDULE = ${JSON.stringify(compiled)}`);
    // A minimal Web Audio player is inlined (ported from synth.ts), not imported.
    expect(src).toContain("createOscillator");
    expect(src).not.toContain('from "./synth"');
    expect(src).not.toContain("import {"); // no import statements — the preview iframe can't resolve them
  });

  it("embeds every layered voice of a multi-voice cue (with its noise + filter path)", () => {
    const compiled = compileCue(kit.cues[1], kit);
    expect(compiled.voices).toHaveLength(2);
    const src = cuePlayerModule(kit.cues[1], kit);
    expect(src).toContain(JSON.stringify(compiled)); // the full schedule, both voices
    expect(src).toContain("createBufferSource"); // the noise voice path
    expect(src).toContain("createBiquadFilter"); // the filtered voice path
  });

  it("throws on a cue whose kit has a dangling composes edge (caller treats as unresolvable)", () => {
    const broken: SoundKit = { ...kit, cues: [{ id: "x", name: "X", category: "ui", layers: [{ voice: "missing", at: 0 }] }] };
    expect(() => cuePlayerModule(broken.cues[0], broken)).toThrow();
  });
});
