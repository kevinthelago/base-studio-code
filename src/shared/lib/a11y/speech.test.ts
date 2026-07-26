import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isSpeechSupported, listVoices, speak, cancelSpeech } from "./speech";

// A stand-in for SpeechSynthesisUtterance (jsdom has neither the ctor nor speechSynthesis).
class FakeUtterance {
  text: string;
  rate = 1;
  voice: unknown = null;
  constructor(text: string) {
    this.text = text;
  }
}

const voices = [
  { name: "Alice", lang: "en-US", voiceURI: "alice" },
  { name: "Bob", lang: "en-GB", voiceURI: "bob" },
];

describe("speech engine (#3804, a11y Tier 1)", () => {
  let spoken: FakeUtterance[];
  let cancelled: number;

  beforeEach(() => {
    spoken = [];
    cancelled = 0;
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      speak: (u: FakeUtterance) => spoken.push(u),
      cancel: () => { cancelled++; },
      getVoices: () => voices,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reports supported + lists the platform voices", () => {
    expect(isSpeechSupported()).toBe(true);
    expect(listVoices().map((v) => v.voiceURI)).toEqual(["alice", "bob"]);
  });

  it("speaks with the given rate + selected voice", () => {
    speak("hello", { rate: 1.5, voiceURI: "bob" });
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe("hello");
    expect(spoken[0].rate).toBe(1.5);
    expect(spoken[0].voice).toEqual(voices[1]);
  });

  it("falls back to the default voice for an unknown voiceURI", () => {
    speak("hi", { voiceURI: "nope" });
    expect(spoken[0].voice).toBeNull();
  });

  it("no-ops on blank text", () => {
    speak("   ");
    expect(spoken).toHaveLength(0);
  });

  it("cancel flushes queued/active speech", () => {
    cancelSpeech();
    expect(cancelled).toBe(1);
  });

  it("is a safe no-op when speechSynthesis is absent", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    expect(isSpeechSupported()).toBe(false);
    expect(listVoices()).toEqual([]);
    expect(() => speak("x")).not.toThrow();
    expect(() => cancelSpeech()).not.toThrow();
    expect(spoken).toHaveLength(0);
  });
});
