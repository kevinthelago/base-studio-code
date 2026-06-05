import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "../store";

// Mock the bundler so the render-preview pipeline runs without esbuild-wasm (its
// module load fails under jsdom).
vi.mock("../screens/projects/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { PlanPreviewPane } from "../screens/projects/PlanPreviewPane";

describe("PlanPreviewPane (#531)", () => {
  beforeEach(() => useAppStore.setState({ stagePreview: {}, stagePipelineRuns: {}, uiApproved: {} }));

  it("shows the empty state with skeleton + demo actions", () => {
    render(<PlanPreviewPane projectKey="proj" />);
    expect(screen.getByText("No preview yet")).toBeTruthy();
    expect(screen.getByText("load from skeleton →")).toBeTruthy();
    expect(screen.getByText("demo")).toBeTruthy();
  });

  it("renders the preview the store holds for this project", () => {
    useAppStore.setState({ stagePreview: { proj: { srcDoc: "<html><body>STORED</body></html>", mode: "2d" } } });
    const { container } = render(<PlanPreviewPane projectKey="proj" />);
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain("STORED");
  });

  it("running the demo routes through the render-preview pipeline → store → iframe", async () => {
    const { container } = render(<PlanPreviewPane projectKey="proj" />);
    fireEvent.click(screen.getByText("demo"));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    // the pipeline wrote the bundled srcdoc to the store
    expect(useAppStore.getState().stagePreview["proj"]?.srcDoc).toContain("BUNDLE_JS");
  });

  it("approving a rendered preview sets uiApproved for the project (#544)", () => {
    useAppStore.setState({ stagePreview: { proj: { srcDoc: "<html></html>", mode: "2d" } } });
    render(<PlanPreviewPane projectKey="proj" />);
    fireEvent.click(screen.getByText("approve"));
    expect(useAppStore.getState().uiApproved["proj"]).toBe(true);
    // the button reflects the approved state and clicking again revokes it
    fireEvent.click(screen.getByText("✓ approved"));
    expect(useAppStore.getState().uiApproved["proj"]).toBe(false);
  });

  it("does not offer approval when there is no preview yet (#544)", () => {
    render(<PlanPreviewPane projectKey="proj" />);
    expect(screen.queryByText("approve")).toBeNull();
  });
});
