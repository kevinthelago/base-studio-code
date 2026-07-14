// The Sounds pillar's data model (#3072, epic #3071) — a sound is SYNTHESIZED from a descriptor, not a
// binary file, so it's diffable, seedable, and live-playable (Web Audio), exactly like a component's
// srcText or an algorithm's concept-IS-impl. The model is a composition graph mirroring the sibling
// pillars: Primitive → Voice → Cue.
//
//   Primitive — the base sound SOURCE (an oscillator or noise). The graph's Fundamentals band.
//   Voice     — a playable PATCH built on ONE primitive: pitch (+ optional sweep), an ADSR envelope,
//               an optional filter, and a peak gain. The Composables band; `primitive` is a composes edge.
//   Cue       — a UI-mapped SOUND: one or more voices LAYERED/SEQUENCED (each at an offset). The
//               "components" of this pillar; `layers[].voice` are composes edges.
//   SoundKit  — a cohesive named set a project adopts wholesale (its primitives + voices + cues).
//
// This module is PURE (no Web Audio, no React) — the synth compiler (`synth.ts`) turns a Cue into a flat
// schedule, and only the thin `playCue` touches the browser audio graph.

/** Oscillator wave shapes — the Web Audio `OscillatorNode` types. */
export type Waveform = "sine" | "square" | "sawtooth" | "triangle";

/** Where a cue sits in the library — drives the rail grouping (and, later, the graph swimlanes). */
export type SoundCategory = "ui" | "notify" | "transition" | "ambient" | "musical";

export const SOUND_CATEGORIES: readonly SoundCategory[] = ["ui", "notify", "transition", "ambient", "musical"];

/** Human labels for the categories (rail headers + inspector). */
export const CATEGORY_LABEL: Record<SoundCategory, string> = {
  ui: "UI feedback",
  notify: "Notifications",
  transition: "Transitions",
  ambient: "Ambient",
  musical: "Musical",
};

/** An ADSR-style one-shot envelope. Times in SECONDS; `sustain` is a 0..1 level (no sustain-hold time —
 *  a cue is one-shot, so release begins right after decay). A voice's duration = attack + decay + release. */
export interface Envelope {
  attack: number;
  decay: number;
  /** Level (0..1) held at the decay→release junction. */
  sustain: number;
  release: number;
}

/** A base sound source. `waveform` applies to `kind: "osc"`; `noise` is white noise (waveform ignored). */
export interface Primitive {
  id: string;
  name: string;
  kind: "osc" | "noise";
  waveform?: Waveform;
}

/** A tone filter applied to a voice. */
export interface VoiceFilter {
  type: "lowpass" | "highpass" | "bandpass";
  /** Cutoff / center frequency in Hz. */
  cutoff: number;
}

/** A playable patch built on exactly one primitive. */
export interface Voice {
  id: string;
  name: string;
  /** Primitive.id this voice is built on (the `composes` edge). */
  primitive: string;
  /** Base frequency in Hz (ignored for a noise primitive). */
  freq: number;
  /** Optional end frequency — the voice GLIDES freq→pitchTo over its life (a sweep/zap). */
  pitchTo?: number;
  /** Fine detune in cents. */
  detune?: number;
  env: Envelope;
  filter?: VoiceFilter;
  /** Peak gain, 0..1. */
  gain: number;
}

/** One voice within a cue, started at `at` seconds from the cue's start (0 = together = a layer). */
export interface CueLayer {
  /** Voice.id (the `composes` edge). */
  voice: string;
  at: number;
}

/** A UI-mapped sound: layered/sequenced voices. */
export interface Cue {
  id: string;
  name: string;
  category: SoundCategory;
  layers: CueLayer[];
}

/** A cohesive named library of sounds a project adopts wholesale. */
export interface SoundKit {
  id: string;
  name: string;
  primitives: Primitive[];
  voices: Voice[];
  cues: Cue[];
}

/**
 * Dangling-reference check for a kit — the dependency-integrity guard behind the playable UI (and, later,
 * a `bsc sound doctor`). Returns a human-readable problem per broken `composes` edge (a voice on a missing
 * primitive, a cue layer on a missing voice) or an empty layer; empty ⇒ the kit compiles + plays cleanly.
 */
export function validateKit(kit: SoundKit): string[] {
  const problems: string[] = [];
  const primIds = new Set(kit.primitives.map((p) => p.id));
  const voiceIds = new Set(kit.voices.map((v) => v.id));
  for (const v of kit.voices) {
    if (!primIds.has(v.primitive)) problems.push(`voice "${v.id}" composes a missing primitive "${v.primitive}"`);
  }
  for (const c of kit.cues) {
    if (c.layers.length === 0) problems.push(`cue "${c.id}" has no layers`);
    for (const l of c.layers) {
      if (!voiceIds.has(l.voice)) problems.push(`cue "${c.id}" layers a missing voice "${l.voice}"`);
    }
  }
  return problems;
}
