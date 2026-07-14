// The Sounds synth engine (#3072) — two halves, split so the logic is testable without a browser:
//   compileCue — PURE: resolves a Cue's composes edges (layer→voice→primitive) into a FLAT schedule of
//                voices with absolute start times + durations. No Web Audio; fully unit-tested.
//   playCue    — THIN: realizes that schedule on a Web Audio graph. No-op where AudioContext is absent
//                (SSR / jsdom), so it's safe to call from anywhere; not unit-tested (needs a real ctx).
import type { Cue, Envelope, SoundKit, VoiceFilter, Waveform } from "./soundDescriptor";

/** One voice of a cue, resolved to everything the player needs — no more kit lookups downstream. */
export interface CompiledVoice {
  source: "osc" | "noise";
  waveform: Waveform;
  freq: number;
  pitchTo?: number;
  detune: number;
  env: Envelope;
  filter?: VoiceFilter;
  gain: number;
  /** Seconds from the cue's start. */
  startAt: number;
  /** attack + decay + release. */
  duration: number;
}

export interface CompiledCue {
  voices: CompiledVoice[];
  /** Wall-clock length of the whole cue (max layer end). */
  duration: number;
}

/** A voice's one-shot length: attack → decay → release (sustain is a level, not a hold). */
export function voiceDuration(env: Envelope): number {
  return env.attack + env.decay + env.release;
}

/**
 * Resolve a cue into a flat, absolutely-timed schedule. Throws on a dangling composes edge (a missing
 * voice or primitive) — call `validateKit` first if the kit might be broken; the seed kits are
 * test-guarded, so a throw here is a real bug, not user data. Pure + deterministic.
 */
export function compileCue(cue: Cue, kit: SoundKit): CompiledCue {
  const voiceById = new Map(kit.voices.map((v) => [v.id, v]));
  const primById = new Map(kit.primitives.map((p) => [p.id, p]));
  const voices: CompiledVoice[] = [];
  let duration = 0;
  for (const layer of cue.layers) {
    const voice = voiceById.get(layer.voice);
    if (!voice) throw new Error(`cue "${cue.id}" layers a missing voice "${layer.voice}"`);
    const prim = primById.get(voice.primitive);
    if (!prim) throw new Error(`voice "${voice.id}" composes a missing primitive "${voice.primitive}"`);
    const dur = voiceDuration(voice.env);
    voices.push({
      source: prim.kind,
      waveform: prim.waveform ?? "sine",
      freq: voice.freq,
      pitchTo: voice.pitchTo,
      detune: voice.detune ?? 0,
      env: voice.env,
      filter: voice.filter,
      gain: voice.gain,
      startAt: layer.at,
      duration: dur,
    });
    duration = Math.max(duration, layer.at + dur);
  }
  return { voices, duration };
}

// ── Web Audio realization (thin; untested — needs a real AudioContext) ─────────────────────────────

let sharedCtx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;

type AudioCtor = typeof AudioContext;

/** The shared AudioContext, created lazily on first play (a user gesture) and resumed if suspended.
 *  Returns null where Web Audio is unavailable (SSR / jsdom) so callers degrade to a no-op. */
function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  if (!sharedCtx) sharedCtx = new Ctor();
  if (sharedCtx.state === "suspended") void sharedCtx.resume();
  return sharedCtx;
}

/** A one-second white-noise buffer, generated once and reused for every noise voice. */
function whiteNoise(ctx: AudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

/** Schedule one compiled voice on the graph, starting at absolute time `t0`. */
function scheduleVoice(ctx: AudioContext, v: CompiledVoice, t0: number): void {
  const start = t0 + v.startAt;
  const { attack, decay, sustain, release } = v.env;
  const peak = Math.max(0.0001, v.gain);

  // Envelope on a GainNode: 0 →(attack)→ peak →(decay)→ sustain·peak →(release)→ 0.
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.linearRampToValueAtTime(peak, start + attack);
  amp.gain.linearRampToValueAtTime(Math.max(0.0001, sustain * peak), start + attack + decay);
  amp.gain.linearRampToValueAtTime(0.0001, start + attack + decay + release);

  let node: OscillatorNode | AudioBufferSourceNode;
  if (v.source === "noise") {
    const src = ctx.createBufferSource();
    src.buffer = whiteNoise(ctx);
    src.loop = true;
    node = src;
  } else {
    const osc = ctx.createOscillator();
    osc.type = v.waveform;
    osc.detune.setValueAtTime(v.detune, start);
    osc.frequency.setValueAtTime(v.freq, start);
    if (v.pitchTo != null && v.pitchTo !== v.freq) {
      osc.frequency.linearRampToValueAtTime(v.pitchTo, start + v.duration);
    }
    node = osc;
  }

  let tail: AudioNode = node;
  if (v.filter) {
    const f = ctx.createBiquadFilter();
    f.type = v.filter.type;
    f.frequency.setValueAtTime(v.filter.cutoff, start);
    tail.connect(f);
    tail = f;
  }
  tail.connect(amp);
  amp.connect(ctx.destination);

  node.start(start);
  node.stop(start + v.duration + 0.02);
}

/**
 * Play a cue NOW. Compiles it (throws only on a broken kit — guarded by validateKit/tests), then schedules
 * every voice on the shared AudioContext. Returns the cue's duration in seconds (0 where audio is
 * unavailable — a safe no-op). Fire-and-forget; there's no stop handle in Phase 1 (cues are short one-shots).
 */
export function playCue(cue: Cue, kit: SoundKit): number {
  const ctx = getCtx();
  if (!ctx) return 0;
  const compiled = compileCue(cue, kit);
  const t0 = ctx.currentTime + 0.02; // a hair ahead so the first envelope point isn't in the past
  for (const v of compiled.voices) scheduleVoice(ctx, v, t0);
  return compiled.duration;
}
