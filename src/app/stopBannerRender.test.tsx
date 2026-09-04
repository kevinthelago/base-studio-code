// The banner must COLLAPSE (`one-stop-banner-per-pane-fills-the-screen`).
//
// `stopBannerCollapse.test.tsx` proves the ordering and summary rules; this proves the thing the
// maintainer actually reported — that N stops no longer render N full-width bars.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { useAppStore } from "@/store";
import type { PaneStop } from "@/app/console/lib/paneStops";
import { AppBanners } from "@/app/AppBanners";

vi.mock("@/shared/hooks/useSandboxReadiness", () => ({ useSandboxReadiness: () => ({ ready: true }) }));

const NOW = Date.now();
const stop = (paneId: string, reason: PaneStop["reason"], lastOutput?: string): PaneStop =>
  ({ paneId, reason, detail: "detail", at: NOW, lastOutput }) as PaneStop;

/** Every rendered status banner, by its role. */
const banners = () => screen.queryAllByRole("status");

beforeEach(() => {
  useAppStore.setState({ paneStops: [], dismissedNotices: [] } as never);
});

describe("many stops render as ONE banner", () => {
  it("collapses six simultaneous stops into a single banner", () => {
    // THE REPORTED BUG: an app relaunch ends every session, and this used to be six full-width bars.
    useAppStore.setState({
      paneStops: ["a", "b", "c", "d", "e", "f"].map((n) => stop(`p:${n}`, "app-closed")),
    } as never);
    render(<AppBanners />);
    expect(banners()).toHaveLength(1);
  });

  it("still names every pane inside that one banner — collapsing is not hiding", () => {
    useAppStore.setState({
      paneStops: ["a", "b", "c"].map((n) => stop(`p:${n}`, "app-closed")),
    } as never);
    render(<AppBanners />);
    for (const n of ["p:a", "p:b", "p:c"]) expect(screen.getByText(new RegExp(n))).toBeTruthy();
  });

  it("keeps a fault's LAST WORDS, which nothing else in the app has", () => {
    // The one thing collapsing must not drop: once the pane is recreated, this output is gone.
    useAppStore.setState({
      paneStops: [stop("p:a", "app-closed"), stop("p:bad", "failed", "panic: boom")],
    } as never);
    render(<AppBanners />);
    expect(banners()).toHaveLength(1);
    expect(screen.getByText(/panic: boom/)).toBeTruthy();
  });

  it("still shows a SINGLE stop the way it always did", () => {
    useAppStore.setState({ paneStops: [stop("p:only", "finished")] } as never);
    render(<AppBanners />);
    expect(banners()).toHaveLength(1);
    expect(screen.getByText(/finished/)).toBeTruthy();
  });

  it("renders nothing when there are no stops", () => {
    render(<AppBanners />);
    expect(banners()).toHaveLength(0);
  });
});
