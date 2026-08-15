import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { usePreviewReview } from "@/features/glance/usePreviewReview";
import { grabFrame, stopCapture } from "@/shared/lib/preview/captureFrame";
import { reviewShot } from "@/shared/lib/preview/reviewShot";
import { injectPrompt } from "@/shared/lib/fleet/paneInject";
import type { ReviewFinding } from "@/shared/lib/preview/previewReview";

vi.mock("@/shared/lib/preview/captureFrame", () => ({
  screenCaptureAvailable: () => true,
  startPreviewCapture: vi.fn(async () => ({ getTracks: () => [] }) as unknown as MediaStream),
  grabFrame: vi.fn(async () => "data:image/png;base64,AAAA"),
  stopCapture: vi.fn(),
}));
vi.mock("@/shared/lib/preview/reviewShot", () => ({ reviewShot: vi.fn() }));
vi.mock("@/shared/lib/fleet/paneInject", () => ({ injectPrompt: vi.fn(async () => {}) }));

const finding = (over: Partial<ReviewFinding>): ReviewFinding => ({
  id: "f0", shotId: "proj:0", severity: "issue", title: "Overlap", detail: "", status: "pending", ...over,
});

describe("usePreviewReview (#2623 slice 5b — capture → review → inbox)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAppStore.setState({ reviewFindings: {} });
    vi.mocked(reviewShot).mockResolvedValue([finding({})]);
  });

  it("captures + reviews, folding findings into the confirm-gated inbox", async () => {
    const { result } = renderHook(() => usePreviewReview("proj"));
    await act(async () => { await result.current.captureAndReview(); });
    expect(grabFrame).toHaveBeenCalledOnce();
    expect(result.current.pending.map((f) => f.title)).toEqual(["Overlap"]);
    expect(useAppStore.getState().reviewFindings["proj"]).toHaveLength(1);
    expect(result.current.busy).toBe(false);
  });

  it("dedups a re-reviewed finding rather than duplicating it", async () => {
    const { result } = renderHook(() => usePreviewReview("proj"));
    await act(async () => { await result.current.captureAndReview(); });
    await act(async () => { await result.current.captureAndReview(); }); // same finding again
    expect(useAppStore.getState().reviewFindings["proj"]).toHaveLength(1);
  });

  it("confirm / dismiss move findings across the gate", async () => {
    const { result } = renderHook(() => usePreviewReview("proj"));
    await act(async () => { await result.current.captureAndReview(); });
    act(() => result.current.confirm("f0"));
    expect(result.current.confirmed.map((f) => f.id)).toEqual(["f0"]);
    expect(result.current.pending).toHaveLength(0);
    act(() => result.current.dismiss("f0"));
    expect(result.current.confirmed).toHaveLength(0);
  });

  it("surfaces an error and drops the stream when review fails", async () => {
    vi.mocked(reviewShot).mockRejectedValueOnce(new Error("no api key"));
    const { result } = renderHook(() => usePreviewReview("proj"));
    await act(async () => { await result.current.captureAndReview(); });
    await waitFor(() => expect(result.current.error).toMatch(/no api key/));
    expect(stopCapture).toHaveBeenCalled();
    expect(useAppStore.getState().reviewFindings["proj"] ?? []).toHaveLength(0);
  });

  it("no-ops without a project key", async () => {
    const { result } = renderHook(() => usePreviewReview(null));
    await act(async () => { await result.current.captureAndReview(); });
    expect(reviewShot).not.toHaveBeenCalled();
  });

  describe("dispatch — mark confirmed findings routed (#app-stops-pushing-prompts)", () => {
    it("marks them routed WITHOUT pushing anything into a session", async () => {
      // It used to type the findings into <key>:director. The app pushes no prompts now, so dispatch is
      // a local status change and a director picks the findings up when it reads the review state.
      useAppStore.setState({ findFleetTabIdx: () => 0 });
      const { result } = renderHook(() => usePreviewReview("proj"));
      await act(async () => { await result.current.captureAndReview(); });
      act(() => result.current.confirm("f0"));
      await act(async () => { await result.current.dispatch(); });

      expect(injectPrompt).not.toHaveBeenCalled();
      expect(result.current.confirmed).toHaveLength(0);       // left the confirmed pool
      expect(result.current.routed.map((f) => f.id)).toEqual(["f0"]);
    });

    it("no longer blocks on a missing fleet — there is no delivery left for one to block", async () => {
      // The old guard refused to route with no live fleet, because the injection needed a director pane
      // to land in. With nothing being delivered, a missing fleet is not an error state.
      useAppStore.setState({ findFleetTabIdx: () => -1 });
      const { result } = renderHook(() => usePreviewReview("proj"));
      await act(async () => { await result.current.captureAndReview(); });
      act(() => result.current.confirm("f0"));
      await act(async () => { await result.current.dispatch(); });

      expect(result.current.error).toBeNull();
      expect(result.current.routed.map((f) => f.id)).toEqual(["f0"]);
    });
  });
});
