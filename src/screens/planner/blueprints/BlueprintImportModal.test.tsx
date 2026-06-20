import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { BlueprintImportModal } from "./BlueprintImportModal";
import { listBlueprintGists, type BlueprintGistItem } from "../../../lib/planner/gist/gist";

vi.mock("../../../lib/planner/gist/gist", () => ({ listBlueprintGists: vi.fn() }));

function gist(over: Partial<BlueprintGistItem>): BlueprintGistItem {
  return { id: "g", name: "G", description: "blueprint: G", owner: "me", htmlUrl: "", updatedAt: "2026-01-01T00:00:00Z", ...over };
}

const ITEMS = [
  gist({ id: "g-fresh", name: "Fresh BP", description: "a brand new one" }),
  gist({ id: "g-imp", name: "Imported BP", updatedAt: "2026-01-01T00:00:00Z" }),
  gist({ id: "g-stale", name: "Stale BP", updatedAt: "2026-06-01T00:00:00Z" }),
];
// g-imp imported & current (equal updatedAt); g-stale imported but upstream is newer.
const IMPORTED = { "g-imp": { updatedAt: "2026-01-01T00:00:00Z" }, "g-stale": { updatedAt: "2026-01-01T00:00:00Z" } };

function renderModal(props: Partial<React.ComponentProps<typeof BlueprintImportModal>> = {}) {
  const onImport = vi.fn();
  const onManualImport = vi.fn();
  const onClose = vi.fn();
  render(
    <BlueprintImportModal
      source="me" token="tok" importedById={IMPORTED}
      onImport={onImport} onManualImport={onManualImport} onClose={onClose}
      {...props}
    />,
  );
  return { onImport, onManualImport, onClose };
}

describe("BlueprintImportModal", () => {
  beforeEach(() => { vi.mocked(listBlueprintGists).mockReset(); });

  it("loads, then lists the account's blueprint gists with per-row status", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    renderModal();
    // Loading first, then the list.
    expect(await screen.findByText("Fresh BP")).toBeTruthy();
    expect(screen.getByText("Imported BP")).toBeTruthy();
    expect(screen.getByText("Stale BP")).toBeTruthy();
    expect(vi.mocked(listBlueprintGists)).toHaveBeenCalledWith("me", "tok");
    // Status variants: fresh ⇒ Import, current ⇒ Imported, stale ⇒ Update.
    expect(screen.getByText("Import")).toBeTruthy();
    expect(screen.getByText("Imported")).toBeTruthy();
    expect(screen.getByText("Update")).toBeTruthy();
  });

  it("filters by the search query", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    renderModal();
    await screen.findByText("Fresh BP");
    fireEvent.change(screen.getByPlaceholderText(/search blueprints/i), { target: { value: "fresh" } });
    expect(screen.getByText("Fresh BP")).toBeTruthy();
    expect(screen.queryByText("Imported BP")).toBeNull();
    expect(screen.queryByText("Stale BP")).toBeNull();
  });

  it("fires onImport with the gist id + updatedAt when Import is clicked", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const { onImport } = renderModal();
    await screen.findByText("Fresh BP");
    fireEvent.click(screen.getByText("Import"));
    expect(onImport).toHaveBeenCalledWith("g-fresh", "2026-01-01T00:00:00Z");
  });

  it("fires onManualImport (URL / ID) and onClose", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const { onManualImport, onClose } = renderModal();
    await screen.findByText("Fresh BP");
    fireEvent.click(screen.getByText("URL / ID"));
    expect(onManualImport).toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const { onClose } = renderModal();
    await screen.findByText("Fresh BP");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("shows the empty state when the account has no blueprint gists", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue([]);
    renderModal();
    expect(await screen.findByText("No blueprint gists yet")).toBeTruthy();
  });

  it("shows the error state when the list request fails", async () => {
    vi.mocked(listBlueprintGists).mockRejectedValue(new Error("offline"));
    renderModal();
    expect(await screen.findByText("Couldn't reach GitHub")).toBeTruthy();
  });
});
