import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// Mock the bundler so the pane's flow is testable without esbuild-wasm (its module
// load fails under jsdom).
vi.mock("../screens/projects/previewBundle", () => ({
  bundleSkeleton: vi.fn().mockResolvedValue("BUNDLE_JS"),
  buildPreviewSrcDoc: (js: string) => `<html><body>${js}</body></html>`,
}));

import { PlanPreviewPane } from "../screens/projects/PlanPreviewPane";

describe("PlanPreviewPane (#530)", () => {
  it("shows the empty state with a render-demo action + close", () => {
    const onClose = vi.fn();
    render(<PlanPreviewPane onClose={onClose} />);
    expect(screen.getByText("No preview yet")).toBeTruthy();
    expect(screen.getByText("render demo →")).toBeTruthy();
    expect(screen.getByText("▸ preview")).toBeTruthy();
  });

  it("bundles + renders a preview when the demo is run", async () => {
    const { container } = render(<PlanPreviewPane />);
    fireEvent.click(screen.getByText("render demo →"));
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain("BUNDLE_JS");
  });
});
