// Self-contained sound-cue player emit (#3117, epic #3114) — the Sounds analog of an algorithm's
// vendorable `code` (libraryModules.ts, #3116). An algorithm ships real JS `code` the preview vendors
// verbatim; a sound has NO JS source, so we can't vendor a file. Instead we COMPILE the cue here (synth.ts
// `compileCue`) and EMIT A STRING that is a self-contained ES module: it embeds the resulting flat
// `SCHEDULE` and inlines a MINIMAL Web Audio player ported from `synth.ts` — the preview iframe runs in
// isolation and canNOT import the app's `synth`, so the player must travel with the cue. Pure — no Web
// Audio, no React (the emitted STRING touches Web Audio only when its `play()` runs inside the preview).
//
// EXPORT API (what a component author binds): `import { play } from "@bsc/sounds/<id>"` — `play()` plays
// the cue now and returns its duration in seconds (0 where Web Audio is unavailable — a safe no-op in
// SSR/jsdom), reading naturally in an `onClick={() => play()}`. A DEFAULT export mirrors it, so
// `import play from "@bsc/sounds/<id>"` binds too.
import { compileCue } from "./synth";
import type { Cue, SoundKit } from "./soundDescriptor";

/** The static player runtime inlined into every emitted module — a minimal port of synth.ts's
 *  `getCtx`/`whiteNoise`/`scheduleVoice`/`playCue` that reads the pre-compiled `SCHEDULE` the emit prepends.
 *  Kept as ONE literal so the emit is just `SCHEDULE` + this. MUST stay behaviorally in lockstep with
 *  `synth.ts` (the desktop player) — both realize the same compiled schedule on a Web Audio graph. */
const PLAYER_RUNTIME = `
let __ctx = null;
let __noise = null;

function __getCtx() {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!__ctx) __ctx = new Ctor();
  if (__ctx.state === "suspended") __ctx.resume();
  return __ctx;
}

function __whiteNoise(ctx) {
  if (__noise && __noise.sampleRate === ctx.sampleRate) return __noise;
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  __noise = buf;
  return buf;
}

function __scheduleVoice(ctx, v, t0) {
  const start = t0 + v.startAt;
  const { attack, decay, sustain, release } = v.env;
  const peak = Math.max(0.0001, v.gain);

  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.linearRampToValueAtTime(peak, start + attack);
  amp.gain.linearRampToValueAtTime(Math.max(0.0001, sustain * peak), start + attack + decay);
  amp.gain.linearRampToValueAtTime(0.0001, start + attack + decay + release);

  let node;
  if (v.source === "noise") {
    const src = ctx.createBufferSource();
    src.buffer = __whiteNoise(ctx);
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

  let tail = node;
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

/** Play the cue now; returns its duration in seconds (0 where Web Audio is unavailable — a safe no-op). */
export function play() {
  const ctx = __getCtx();
  if (!ctx) return 0;
  const t0 = ctx.currentTime + 0.02;
  for (const v of SCHEDULE.voices) __scheduleVoice(ctx, v, t0);
  return SCHEDULE.duration;
}

export default play;
`;

/**
 * Emit a self-contained ES module (as a string) that plays `cue` — the vendorable "code" for a sound the
 * Design Studio preview imports as `@bsc/sounds/<id>` (#3117). Compiles `cue` against `kit` (synth.ts
 * `compileCue`) and embeds the resulting flat `SCHEDULE` ahead of the inlined {@link PLAYER_RUNTIME}.
 * Deterministic + pure.
 *
 * Throws only when the kit has a DANGLING composes edge (a broken user kit) — the packaged kits are
 * test-guarded, so the caller (the sounds `NodeLookup`) treats a throw as "not resolvable" and returns
 * `null`, exactly as an algorithm primitive (no `code`) is not vendorable.
 */
export function cuePlayerModule(cue: Cue, kit: SoundKit): string {
  const compiled = compileCue(cue, kit);
  const header =
    `// Generated player for the "${cue.name}" sound cue (@bsc/sounds/${cue.id}) — self-contained, no app\n` +
    `// imports (#3117). Embeds the compiled schedule + a minimal Web Audio player.\n`;
  return `${header}const SCHEDULE = ${JSON.stringify(compiled)};\n${PLAYER_RUNTIME}`;
}
