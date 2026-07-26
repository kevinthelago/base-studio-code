import { describe, it, expect } from "vitest";
import type { AlertKind } from "@/features/tunnel";
import { shouldSpeak } from "./coordSpeech";

const NEEDS_YOU: AlertKind[] = ["agent-paused", "prompt-waiting", "worker-question", "planner-waiting", "fleet-failed"];
const PROGRESS: AlertKind[] = ["fleet-landed", "gate-ready"];

describe("shouldSpeak — TTS verbosity policy (#3804)", () => {
  it("verbose speaks every alert kind", () => {
    for (const k of [...NEEDS_YOU, ...PROGRESS]) {
      expect(shouldSpeak(k, "verbose"), k).toBe(true);
    }
  });

  it("terse speaks the needs-you / went-wrong kinds", () => {
    for (const k of NEEDS_YOU) expect(shouldSpeak(k, "terse"), k).toBe(true);
  });

  it("terse SKIPS the progress kinds (landings, ready gates)", () => {
    for (const k of PROGRESS) expect(shouldSpeak(k, "terse"), k).toBe(false);
  });
});
