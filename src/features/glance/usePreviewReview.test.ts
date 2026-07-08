import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";
import { usePreviewReview } from "./usePreviewReview";
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

  describe("dispatch — route confirmed findings to the director (5d)", () => {
    it("injects the dispatch prompt into <key>:director and marks findings routed", async () => {
      useAppStore.setState({ findFleetTabIdx: () => 0 }); // a live fleet exists
      const { result } = renderHook(() => usePreviewReview("proj"));
      await act(async () => { await result.current.captureAndReview(); });
      act(() => result.current.confirm("f0"));
      await act(async () => { await result.current.dispatch(); });

      const [pane, text] = vi.mocked(injectPrompt).mock.calls[0];
      expect(pane).toBe("proj:director");
      expect(text).toContain("preview-review");
      expect(text).toContain("Overlap");
      expect(result.current.confirmed).toHaveLength(0); // left the confirmed pool
      expect(result.current.routed.map((f) => f.id)).toEqual(["f0"]);
    });

    it("refuses to route with no running fleet, surfacing an error and keeping the finding confirmed", async () => {
      useAppStore.setState({ findFleetTabIdx: () => -1 });
      const { result } = renderHook(() => usePreviewReview("proj"));
      await act(async () => { await result.current.captureAndReview(); });
      act(() => result.current.confirm("f0"));
      await act(async () => { await result.current.dispatch(); });

      expect(injectPrompt).not.toHaveBeenCalled();
      expect(result.current.error).toMatch(/No running fleet/);
      expect(result.current.confirmed.map((f) => f.id)).toEqual(["f0"]); // still confirmed, not lost
    });
  });
});
