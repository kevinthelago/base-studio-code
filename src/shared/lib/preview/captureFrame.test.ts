import { describe, it, expect, vi, afterEach } from "vitest";
import { screenCaptureAvailable, stopCapture } from "./captureFrame";

describe("captureFrame guards (#2623 slice 5b)", () => {
  const md = navigator.mediaDevices;
  afterEach(() => { Object.defineProperty(navigator, "mediaDevices", { value: md, configurable: true }); });

  it("screenCaptureAvailable reflects getDisplayMedia presence", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    expect(screenCaptureAvailable()).toBe(false);
    Object.defineProperty(navigator, "mediaDevices", { value: { getDisplayMedia: () => {} }, configurable: true });
    expect(screenCaptureAvailable()).toBe(true);
  });

  it("stopCapture stops every track and no-ops on null", () => {
    const a = { stop: vi.fn() }, b = { stop: vi.fn() };
    stopCapture({ getTracks: () => [a, b] } as unknown as MediaStream);
    expect(a.stop).toHaveBeenCalledOnce();
    expect(b.stop).toHaveBeenCalledOnce();
    expect(() => stopCapture(null)).not.toThrow();
  });
});
