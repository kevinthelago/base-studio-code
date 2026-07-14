// The starter sound kit (#3072) — a hand-authored SoundKit seeding the Sounds tab so it's playable on
// first open, the same way Components/Algorithms ship a seed. Frontend-only for Phase 1; Phase 3 moves
// these into the `bsc-sound` store (data/sounds/) as the durable source, this becoming just the seed.
//
// Everything is built from a few shared PRIMITIVES → VOICES (patches) → CUES (UI sounds), so the
// composition graph (Phase 2) already has real `composes` edges to draw.
import type { SoundKit } from "./soundDescriptor";

export const STARTER_KIT: SoundKit = {
  id: "signal",
  name: "Signal",
  primitives: [
    { id: "sine", name: "Sine", kind: "osc", waveform: "sine" },
    { id: "square", name: "Square", kind: "osc", waveform: "square" },
    { id: "triangle", name: "Triangle", kind: "osc", waveform: "triangle" },
    { id: "saw", name: "Saw", kind: "osc", waveform: "sawtooth" },
    { id: "noise", name: "Noise", kind: "noise" },
  ],
  voices: [
    // A crisp short sine — the workhorse for a click.
    { id: "blip", name: "Blip", primitive: "sine", freq: 880, gain: 0.3,
      env: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.03 } },
    // A dry filtered square — a mechanical tick for a toggle.
    { id: "tick", name: "Tick", primitive: "square", freq: 1200, gain: 0.22,
      filter: { type: "lowpass", cutoff: 2600 },
      env: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.02 } },
    // Two triangle bells (a fifth-plus-octave apart) — the ascending success chime.
    { id: "bell-lo", name: "Bell (low)", primitive: "triangle", freq: 880, gain: 0.26,
      env: { attack: 0.005, decay: 0.12, sustain: 0.15, release: 0.25 } },
    { id: "bell-hi", name: "Bell (high)", primitive: "triangle", freq: 1318.5, gain: 0.24,
      env: { attack: 0.005, decay: 0.12, sustain: 0.15, release: 0.28 } },
    // A downward saw sweep — an unmistakable error buzz.
    { id: "buzz", name: "Buzz", primitive: "saw", freq: 200, pitchTo: 90, gain: 0.24,
      filter: { type: "lowpass", cutoff: 1400 },
      env: { attack: 0.004, decay: 0.08, sustain: 0.3, release: 0.18 } },
    // An upward sine pop — a friendly notification.
    { id: "pop", name: "Pop", primitive: "sine", freq: 620, pitchTo: 990, gain: 0.28,
      env: { attack: 0.002, decay: 0.05, sustain: 0.1, release: 0.09 } },
    // A bright noise sparkle — layered texture on the notify pop.
    { id: "sparkle", name: "Sparkle", primitive: "noise", freq: 0, gain: 0.12,
      filter: { type: "highpass", cutoff: 5000 },
      env: { attack: 0.001, decay: 0.03, sustain: 0, release: 0.07 } },
  ],
  cues: [
    { id: "click", name: "Click", category: "ui", layers: [{ voice: "blip", at: 0 }] },
    { id: "toggle", name: "Toggle", category: "ui", layers: [{ voice: "tick", at: 0 }] },
    { id: "success", name: "Success", category: "notify",
      layers: [{ voice: "bell-lo", at: 0 }, { voice: "bell-hi", at: 0.09 }] },
    { id: "error", name: "Error", category: "notify", layers: [{ voice: "buzz", at: 0 }] },
    { id: "notify", name: "Notify", category: "notify",
      layers: [{ voice: "pop", at: 0 }, { voice: "sparkle", at: 0.02 }] },
  ],
};
