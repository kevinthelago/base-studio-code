import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useAppStore } from "@/store";

// Mock the bundler so the render-preview pipeline runs without esbuild-wasm (its
// module load fails under jsdom).
vi.mock("../preview/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { PlanPreviewPane } from "./PlanPreviewPane";

describe("PlanPreviewPane (#531)", () => {
  beforeEach(() => useAppStore.setState({ stagePreview: {}, stageRuns: {}, uiScreens: {}, uiApproved: {} }));

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

  it("approving the rendered screen records it by name and revokes on re-click (#546)", () => {
    useAppStore.setState({ stagePreview: { proj: { srcDoc: "<html></html>", mode: "2d", screen: "Login" } } });
    render(<PlanPreviewPane projectKey="proj" />);
    fireEvent.click(screen.getByText("approve"));
    expect(useAppStore.getState().uiApproved["proj"]).toEqual(["Login"]);
    // the button reflects the approved state and clicking again revokes it
    fireEvent.click(screen.getByText("✓ approved"));
    expect(useAppStore.getState().uiApproved["proj"]).toEqual([]);
  });

  it("does not offer approval when there is no preview yet (#546)", () => {
    render(<PlanPreviewPane projectKey="proj" />);
    expect(screen.queryByText("approve")).toBeNull();
  });

  it("does not offer the header approval when the preview has no screen name (#546)", () => {
    useAppStore.setState({ stagePreview: { proj: { srcDoc: "<html></html>", mode: "2d" } } });
    render(<PlanPreviewPane projectKey="proj" />);
    expect(screen.queryByText("approve")).toBeNull();
  });

  it("lists declared screens with their approval count and toggles per row (#546)", () => {
    useAppStore.setState({
      stagePreview: { proj: { srcDoc: "<html></html>", mode: "2d", screen: "Login" } },
      uiScreens: { proj: ["Login", "Dashboard"] },
      uiApproved: { proj: ["Login"] },
    });
    render(<PlanPreviewPane projectKey="proj" />);
    expect(screen.getByText("1/2 approved")).toBeTruthy();
    // Approve the second screen from its row → count advances.
    fireEvent.click(screen.getByText("Dashboard"));
    expect(useAppStore.getState().uiApproved["proj"]).toEqual(["Login", "Dashboard"]);
    expect(screen.getByText("2/2 approved")).toBeTruthy();
  });
});
