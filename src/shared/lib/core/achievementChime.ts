// The unlock chime (#3939) — SYNTHESIZED, not sampled.
//
// The toast used to play a bundled `achievement-sound.mp3` that was almost certainly the Xbox cue.
// Generating the sound removes the provenance question entirely and drops a binary from the bundle:
// two short notes on a triangle wave with a quick exponential decay, which reads as a chime without
// imitating anyone's.
//
// Fail-safe by construction: no AudioContext (an old WebView, a test env) or a blocked autoplay policy
// simply produces no sound. The toast's visual never depends on it.

/** A rising two-note figure — a perfect fifth, which is the least imitative "something good happened". */
const NOTES: Array<{ hz: number; at: number; dur: number }> = [
  { hz: 784, at: 0, dur: 0.16 },     // G5
  { hz: 1175, at: 0.13, dur: 0.34 }, // D6
];

/** Play the unlock chime. Never throws, never rejects — audio is decoration here. */
export function playAchievementChime(volume = 0.22): void {
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    for (const n of NOTES) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = n.hz;
      // A quick attack and an exponential decay — a flat envelope would click on start and stop.
      gain.gain.setValueAtTime(0.0001, now + n.at);
      gain.gain.exponentialRampToValueAtTime(volume, now + n.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.at + n.dur);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + n.at);
      osc.stop(now + n.at + n.dur + 0.02);
    }
    // Release the hardware once the figure has finished; leaking contexts eventually stops playback.
    window.setTimeout(() => void ctx.close().catch(() => {}), 1200);
  } catch {
    // No audio is fine — the toast is visual first.
  }
}
