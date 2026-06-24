import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlueprintImportModal, type BlueprintImportModalProps } from "./BlueprintImportModal";
import { listBlueprintGists, type BlueprintGistItem } from "../../../lib/planner/gist/gist";
import { type PreviewBlueprint } from "./BlueprintModals";
import { type Blueprint, type BlueprintSection } from "../stages/blueprints";

vi.mock("../../../lib/planner/gist/gist", () => ({ listBlueprintGists: vi.fn() }));

const SECTIONS = [
  { uid: "u1", key: "context", name: "Context", glyph: "◆", gate: "", deps: [], blurb: "", prompt: "", enabled: true, expanded: false },
  { uid: "u2", key: "repos", name: "Repos", glyph: "▦", gate: "", deps: [], blurb: "", prompt: "", enabled: true, expanded: false },
] as BlueprintSection[];
const PREVIEW: PreviewBlueprint = {
  name: "Fresh BP", icon: "F", h: 70, sections: SECTIONS,
  blueprint: { id: "fresh", name: "Fresh BP", desc: "", category: "greenfield", sections: SECTIONS } as Blueprint,
};

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
  const onPreview = vi.fn(async () => PREVIEW);
  render(
    <BlueprintImportModal
      source="me" token="tok" importedById={IMPORTED}
      onImport={onImport} onPreview={onPreview} onManualImport={onManualImport} onClose={onClose}
      {...props}
    />,
  );
  return { onImport, onManualImport, onClose, onPreview };
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

  it("previews a gist's blueprint contents before importing (#1037)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const { onPreview, onImport } = renderModal();
    await screen.findByText("Fresh BP");
    // Each row has a Preview button; expanding the first resolves + renders its blueprint.
    fireEvent.click(screen.getAllByRole("button", { name: /^preview$/i })[0]);
    expect(onPreview).toHaveBeenCalledWith("g-fresh");
    expect(await screen.findByText("Context")).toBeTruthy(); // the blueprint's stages render
    expect(screen.getByText("Repos")).toBeTruthy();
    expect(screen.getByText(/view raw JSON/i)).toBeTruthy();  // the literal file is one click away
    expect(onImport).not.toHaveBeenCalled();                  // previewing never imports
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

  // ── #1042: a per-row import must report its real outcome, never a silent swallow. ──

  function renderWith(onImport: BlueprintImportModalProps["onImport"]) {
    render(
      <BlueprintImportModal
        source="me" token="tok" importedById={IMPORTED}
        onImport={onImport} onPreview={vi.fn(async () => PREVIEW)} onManualImport={vi.fn()} onClose={vi.fn()}
      />,
    );
  }

  it("surfaces an import failure (no silent swallow, no false success) (#1042)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const onImport = vi.fn().mockRejectedValue(new Error("no extension.json manifest"));
    renderWith(onImport);
    await screen.findByText("Fresh BP");

    fireEvent.click(screen.getByText("Import"));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't import/i);
    expect(alert).toHaveTextContent(/no extension\.json manifest/);
    // The old code flashed "Imported" regardless; assert that false confirmation is gone.
    expect(screen.queryByText(/Imported .Fresh BP/)).toBeNull();
  });

  it("confirms a successful import and shows no error (#1042)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    const onImport = vi.fn().mockResolvedValue(undefined);
    renderWith(onImport);
    await screen.findByText("Fresh BP");

    fireEvent.click(screen.getByText("Import"));

    expect(await screen.findByText(/Imported .Fresh BP/)).toBeTruthy();
    expect(onImport).toHaveBeenCalledWith("g-fresh", "2026-01-01T00:00:00Z");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("lets the user dismiss a surfaced import error (#1042)", async () => {
    vi.mocked(listBlueprintGists).mockResolvedValue(ITEMS);
    renderWith(vi.fn().mockRejectedValue(new Error("private gist needs auth")));
    await screen.findByText("Fresh BP");

    fireEvent.click(screen.getByText("Import"));
    expect(await screen.findByRole("alert")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Dismiss error"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
