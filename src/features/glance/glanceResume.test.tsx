// Project Resume from the Glance header (#glance-resume) — drilling into a project surfaces a "▶ Resume"
// action in the graph header that relaunches that project's fleet.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";

// Stub the viewport hook so the canvas renders in jsdom without layout measurement (as glancePan does).
vi.mock("@/shared/ui/layouts/useGraphViewport", async (orig) => {
  const actual = await orig<typeof import("@/shared/ui/layouts/useGraphViewport")>();
  return {
    ...actual,
    useGraphViewport: () => ({
      view: { tx: 0, ty: 0, scale: 1 },
      setVp: () => {}, onCanvasDown: () => {}, fit: () => {}, centerOn: () => {},
      zoomBy: () => {}, zoomTo: () => {}, zoomToCentered: () => {},
      dragMoved: { current: false }, worldTransform: {},
    }),
  };
});

// Spy the resume engine — the header click's effect is that it invokes it with the drilled project's key.
const { resumeSpy } = vi.hoisted(() => ({
  resumeSpy: vi.fn((_opts: { projectName: string; projectKey: string; fleet?: unknown }) => Promise.resolve({ ok: true })),
}));
vi.mock("./lib/resumeProject", () => ({ resumeProjectFleet: resumeSpy }));

import { GlanceWorkspace } from "./GlanceWorkspace";

describe("Glance project Resume header action (#glance-resume)", () => {
  beforeEach(() => {
    resumeSpy.mockClear();
    useAppStore.setState({
      localDraftProjects: { proj: { title: "Proj", pitch: "", createdAt: 1 } },
      triagedProjects: { proj: 1 },
      projectLinks: [], githubToken: "", githubState: null,
      glanceDrill: "proj",              // drilled into the project → header shows its fleet
      tabs: [], bscBaseDir: "/base",
    });
  });

  it("shows a Resume action in the header when drilled into a project", () => {
    render(<GlanceWorkspace />);
    expect(screen.getByRole("button", { name: /Resume/i })).toBeTruthy();
  });

  it("resumes the drilled project's fleet when clicked (no live build tab → relaunch)", async () => {
    render(<GlanceWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: /Resume/i }));
    await waitFor(() => expect(resumeSpy).toHaveBeenCalledTimes(1));
    expect(resumeSpy.mock.calls[0][0]).toMatchObject({ projectKey: "proj" });
  });
});
