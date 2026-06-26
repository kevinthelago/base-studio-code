import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ImportModal, type PreviewBlueprint } from "./BlueprintModals";
import { mkStageSection } from "./blueprintEdit";
import { gistUpdateAvailable } from "./blueprintCatalog";

const noop = () => {};

describe("gistUpdateAvailable (#955)", () => {
  it("is true only when the gist's current updatedAt is strictly newer than the imported one", () => {
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", "2026-06-01T00:00:00Z")).toBe(true);
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-18T12:00:00Z")).toBe(false); // older upstream
    expect(gistUpdateAvailable("2026-06-01T00:00:00Z", "2026-06-01T00:00:00Z")).toBe(false); // same ⇒ current
  });
  it("can't tell (⇒ not stale) when either timestamp is missing or unparseable", () => {
    expect(gistUpdateAvailable(undefined, "2026-06-01T00:00:00Z")).toBe(false);
    expect(gistUpdateAvailable("2026-06-18T12:00:00Z", undefined)).toBe(false);
    expect(gistUpdateAvailable("not-a-date", "2026-06-01T00:00:00Z")).toBe(false);
  });
});

describe("ImportModal (#609)", () => {
  it("resolves a gist ref to a preview then imports", async () => {
    const preview: PreviewBlueprint = { name: "Imported", icon: "I", h: 70, author: "x", rev: "r2", sections: [mkStageSection("discovery"), mkStageSection("stack")] };
    const onResolve = vi.fn(async () => preview);
    const onImport = vi.fn();
    render(<ImportModal onClose={noop} onResolve={onResolve} onImport={onImport} />);
    fireEvent.change(screen.getByPlaceholderText(/gist.github.com/i), { target: { value: "abc123" } });
    fireEvent.click(screen.getByRole("button", { name: /Resolve gist/i }));
    await waitFor(() => expect(screen.getByText("Imported")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Import to library/i }));
    expect(onImport).toHaveBeenCalledWith(preview);
  });
});
