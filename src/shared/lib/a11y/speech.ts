// App-owned text-to-speech (#3804, a11y epic #2725 Tier 1) — a thin wrapper over the WebView's
// SpeechSynthesis API (`window.speechSynthesis`). This is DISTINCT from #3770's ARIA live region
// (`announcer.ts`): that pushes text to a live region the user's OWN screen reader speaks; this is the
// app speaking with its own voice, for the streaming-fleet surfaces a screen reader handles badly.
// Every entry guards for absence so it's a safe no-op in a stripped WebView or the jsdom test env.

export interface SpeakOpts {
  /** Speech rate, 0.1–10 (default 1). */
  rate?: number;
  /** A `SpeechSynthesisVoice.voiceURI` to select; falls back to the platform default when absent/unknown. */
  voiceURI?: string;
}

/** How much of the fleet stream is spoken: `terse` = only the needs-you / went-wrong events; `verbose`
 *  = those plus the progress events (a PR landed, a gate is ready). */
export type TtsVerbosity = "terse" | "verbose";

/** The live `SpeechSynthesis` object, or `null` when the environment has none (SSR / jsdom / a stripped
 *  WebView). Coalesces a present-but-undefined value to `null` so `isSpeechSupported` reads correctly. */
function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  return window.speechSynthesis ?? null;
}

/** Whether the WebView exposes SpeechSynthesis (false in tests / a stripped WebView). */
export function isSpeechSupported(): boolean {
  return synth() !== null && typeof SpeechSynthesisUtterance !== "undefined";
}

/** The voices the platform offers (empty when unsupported or the list hasn't loaded yet). */
export function listVoices(): SpeechSynthesisVoice[] {
  return synth()?.getVoices() ?? [];
}

/** Speak `text` at the given rate/voice. No-op when unsupported or the text is blank. Utterances QUEUE
 *  (coord events shouldn't cut each other off); call [`cancelSpeech`] to flush. */
export function speak(text: string, opts: SpeakOpts = {}): void {
  const s = synth();
  if (!s || !isSpeechSupported() || !text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  if (opts.rate != null) u.rate = opts.rate;
  if (opts.voiceURI) {
    const v = s.getVoices().find((voice) => voice.voiceURI === opts.voiceURI);
    if (v) u.voice = v;
  }
  s.speak(u);
}

/** Stop + flush any queued or in-flight speech. */
export function cancelSpeech(): void {
  synth()?.cancel();
}
