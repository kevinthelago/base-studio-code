import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAppStore } from "@/store";

const h = vi.hoisted(() => ({
  speakMock: vi.fn(),
  coordState: { alerts: [] as { id: string; kind: string; text: string }[] },
}));

vi.mock("@/shared/lib/a11y/speech", () => ({ speak: h.speakMock }));
vi.mock("@/shared/lib/fleet/useCoordLog", () => ({ useCoordLog: () => ({ state: h.coordState }) }));
vi.mock("@/features/tunnel", () => ({ coordAlerts: (s: typeof h.coordState) => s.alerts }));

import { useCoordSpeaker } from "./useCoordSpeaker";

const alerts = (...a: { id: string; kind: string; text: string }[]) => ({ alerts: a });

describe("useCoordSpeaker (#3804, a11y Tier 1)", () => {
  beforeEach(() => {
    h.speakMock.mockClear();
    h.coordState = { alerts: [] };
    useAppStore.setState({ ttsEnabled: true, ttsRate: 1.25, ttsVoice: "", ttsVerbosity: "verbose" });
  });

  it("seeds the mount backlog SILENT, then speaks only NEW events, deduped by id", () => {
    h.coordState = alerts({ id: "a1", kind: "agent-paused", text: "api-stream paused" });
    const { rerender } = renderHook(() => useCoordSpeaker());
    expect(h.speakMock).not.toHaveBeenCalled(); // the mount backlog is never spoken

    h.coordState = alerts(
      { id: "a1", kind: "agent-paused", text: "api-stream paused" },
      { id: "a2", kind: "fleet-landed", text: "ui landed a PR" },
    );
    rerender();
    expect(h.speakMock).toHaveBeenCalledTimes(1);
    expect(h.speakMock).toHaveBeenCalledWith("ui landed a PR", { rate: 1.25, voiceURI: undefined });

    rerender(); // unchanged set → nothing new
    expect(h.speakMock).toHaveBeenCalledTimes(1);
  });

  it("stays silent when TTS is OFF, and enabling later never replays the seen backlog", () => {
    useAppStore.setState({ ttsEnabled: false });
    const { rerender } = renderHook(() => useCoordSpeaker()); // seed empty
    h.coordState = alerts({ id: "b1", kind: "worker-question", text: "a worker asked a question" });
    rerender();
    expect(h.speakMock).not.toHaveBeenCalled();
    // Turning it on must not replay b1 (already remembered while off).
    useAppStore.setState({ ttsEnabled: true });
    rerender();
    expect(h.speakMock).not.toHaveBeenCalled();
  });

  it("respects verbosity: terse skips progress events but still speaks the needs-you ones", () => {
    useAppStore.setState({ ttsVerbosity: "terse" });
    const { rerender } = renderHook(() => useCoordSpeaker()); // seed empty
    h.coordState = alerts(
      { id: "c1", kind: "fleet-landed", text: "ui landed a PR" }, // progress — skipped in terse
      { id: "c2", kind: "fleet-failed", text: "a chain failed" },  // needs-you — spoken
    );
    rerender();
    expect(h.speakMock).toHaveBeenCalledTimes(1);
    expect(h.speakMock).toHaveBeenCalledWith("a chain failed", { rate: 1.25, voiceURI: undefined });
  });

  it("passes the selected voice through to the engine", () => {
    useAppStore.setState({ ttsVoice: "voice-uri-1" });
    const { rerender } = renderHook(() => useCoordSpeaker()); // seed empty
    h.coordState = alerts({ id: "d1", kind: "agent-paused", text: "paused" });
    rerender();
    expect(h.speakMock).toHaveBeenCalledWith("paused", { rate: 1.25, voiceURI: "voice-uri-1" });
  });
});
